#!/usr/bin/env node
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3198;
const SESSION_SECRET = 'po-coverage-consistency-test-secret';

function createSession() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    iat: now,
    exp: now + 60 * 60 * 1000,
    nonce: 'po-coverage-consistency'
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

const session = createSession();

function getJson(route) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: PORT,
      path: route,
      headers: { 'x-session': session }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${route}: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = () => {
      if (child.exitCode !== null) return reject(new Error(`server exited ${child.exitCode}`));
      const req = http.get({ hostname: '127.0.0.1', port: PORT, path: '/api/health' }, res => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        setTimeout(poll, 200);
      });
      req.on('error', () => {
        if (Date.now() >= deadline) reject(new Error('server start timed out'));
        else setTimeout(poll, 200);
      });
    };
    poll();
  });
}

function incomingFromPos(pos) {
  const result = {};
  for (const po of pos || []) {
    for (const [sku, qty] of Object.entries(po.analyticsItems || po.items || {})) {
      result[sku] = (result[sku] || 0) + Number(qty || 0);
    }
  }
  return result;
}

function quantitiesFromCoverageRows(poRows) {
  const result = {};
  for (const [sku, rows] of Object.entries(poRows || {})) {
    result[sku] = (rows || []).reduce((sum, row) => sum + Number(row.qty || 0), 0);
  }
  return result;
}

function positiveMap(map) {
  return Object.fromEntries(
    Object.entries(map || {})
      .map(([sku, qty]) => [sku, Number(qty || 0)])
      .filter(([, qty]) => qty > 0)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function assertIncomingMatchesPos(label, scope) {
  assert.deepStrictEqual(
    positiveMap(scope.incoming),
    positiveMap(incomingFromPos(scope.pos)),
    `${label}: incoming must equal exact open physical PO lines`
  );
}

function assertIncomingMatchesCoverage(label, scope) {
  assert(Object.prototype.hasOwnProperty.call(scope, 'coveragePoRows'), `${label}: coverage PO rows missing`);
  assert.deepStrictEqual(
    positiveMap(scope.incoming),
    positiveMap(quantitiesFromCoverageRows(scope.coveragePoRows)),
    `${label}: coverage PO rows must conserve incoming quantities`
  );
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SESSION_SECRET,
      ENABLE_RENDER_CIN7_SCHEDULER: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

  try {
    await waitForServer(child);
    const frontend = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert(frontend.includes('poRows:isAll?(DATA._base.coverageAux.poRows||{})'), 'warehouse filter must restore All coverage PO rows');
    assert(frontend.includes("Object.prototype.hasOwnProperty.call(src,'coveragePoRows')"), 'warehouse filter must select exact branch coverage PO rows');
    assert(frontend.includes('rawOpenDemandTotal:isAll?'), 'warehouse filter must keep summary open demand in the selected scope');
    const list = (await getJson('/api/ck-list')).list || [];
    let panelCount = 0;
    let warehouseScopeCount = 0;
    let regionScopeCount = 0;
    let coveredIncomingSkuCount = 0;

    for (const panel of list) {
      const data = await getJson(`/api/ck/${encodeURIComponent(panel.id)}`);
      panelCount += 1;
      assertIncomingMatchesPos(`${panel.id}/All`, data);

      if (data.coverageAux) {
        const coverageQuantities = positiveMap(quantitiesFromCoverageRows(data.coverageAux.poRows));
        for (const [sku, qty] of Object.entries(positiveMap(data.incoming))) {
          assert.strictEqual(coverageQuantities[sku], qty, `${panel.id}/All/${sku}: coverage PO qty must match incoming`);
          coveredIncomingSkuCount += 1;
        }
      }

      for (const [scopeId, view] of Object.entries(data.warehouseViews || {})) {
        warehouseScopeCount += 1;
        assertIncomingMatchesPos(`${panel.id}/${scopeId}`, view);
        if (data.coverageAux) {
          assertIncomingMatchesCoverage(`${panel.id}/${scopeId}`, view);
          assert(view.coverageOpenDemandBySku && typeof view.coverageOpenDemandBySku === 'object', `${panel.id}/${scopeId}: branch coverage demand missing`);
          assert(view.coverageStockBySku && typeof view.coverageStockBySku === 'object', `${panel.id}/${scopeId}: branch coverage stock missing`);
          coveredIncomingSkuCount += Object.keys(positiveMap(view.incoming)).length;
        }
      }

      for (const [regionId, view] of Object.entries(data.mattressRegions || {})) {
        regionScopeCount += 1;
        assertIncomingMatchesPos(`${panel.id}/${regionId}`, view);
      }
    }

    console.log(`PO coverage consistency passed: ${panelCount} panels, ${warehouseScopeCount} warehouse scopes, ${regionScopeCount} mattress regions, ${coveredIncomingSkuCount} incoming SKU-scope pairs`);
  } catch (error) {
    if (serverOutput) console.error(serverOutput.slice(-3000));
    throw error;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
