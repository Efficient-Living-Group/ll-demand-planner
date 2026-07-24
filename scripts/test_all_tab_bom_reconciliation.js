#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const {
  resolveBomMasterLeaves,
  isBomMasterDemandParentForPanel
} = require('../lib/bom-master-demand');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cache-snapshot.json'), 'utf8'));
const PORT = Number(process.env.BOM_RECONCILIATION_PORT || 3998);
const SESSION_SECRET = 'demand-planner-bom-reconciliation-test';
const KNOWN_BOM_MASTER_EXCLUSIONS = new Set();

function normalizeSku(value) {
  return String(value || '').toUpperCase().trim();
}

function sessionToken() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    iat: now,
    exp: now + 10 * 60 * 1000,
    nonce: crypto.randomBytes(8).toString('hex')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getJson(route, authenticated = true) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: PORT,
      path: route,
      headers: authenticated ? { 'x-session': sessionToken() } : {}
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`${route} returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`${route} returned invalid JSON: ${error.message}`));
        }
      });
    });
    req.on('error', reject);
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`local planner exited with code ${child.exitCode}`);
    try {
      const health = await getJson('/api/health', false);
      if (health && health.ok !== undefined) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw lastError || new Error('local planner did not become ready');
}

function relatedStores(ckId, primaryStore) {
  const stores = new Set([primaryStore]);
  if (String(ckId || '').startsWith('ll')) stores.add('littlelifely');
  if (primaryStore === 'lifely') stores.add('cushie');
  return [...stores].filter(Boolean);
}

function rawVelocityForPanel(ckId, ck) {
  const out = {};
  for (const store of relatedStores(ckId, ck.store)) {
    const source = ck.salesCountry
      ? SNAPSHOT.shopifyVelocityByCountry?.[store]?.[ck.salesCountry] || {}
      : SNAPSHOT.shopifyVelocity?.[store] || {};
    for (const [rawSku, rawVelocity] of Object.entries(source)) {
      if (String(rawSku || '').startsWith('_')) continue;
      const sku = normalizeSku(rawSku);
      const exact30DayUnits = source?._30d?.[rawSku];
      const velocity = exact30DayUnits !== undefined
        ? Number(exact30DayUnits || 0) / 30 * 7
        : Number(rawVelocity || 0);
      if (!sku || velocity <= 0) continue;
      out[sku] = (out[sku] || 0) + velocity;
    }
  }
  return out;
}

function visibleComponentSku(rawSku, visible) {
  const sku = normalizeSku(rawSku);
  if (visible.has(sku)) return sku;
  const carton = sku.match(/^(.+)-(?:[1-4]|C[1-4])$/);
  if (carton && visible.has(carton[1])) return carton[1];
  return '';
}

async function reconcilePanel(row) {
  const data = await getJson(`/api/ck/${encodeURIComponent(row.id)}`);
  const visible = new Set([
    ...Object.keys(data.cin7 || {}),
    ...Object.keys(data.velocity || {})
  ].map(normalizeSku).filter(sku => sku && !sku.startsWith('_')));
  const sourceVelocity = rawVelocityForPanel(row.id, data.ck || {});
  const expected = {};
  const evidence = {};
  const missingBom = [];

  for (const [parentSku, parentVelocity] of Object.entries(sourceVelocity)) {
    if (visible.has(parentSku)) continue;
    const resolved = resolveBomMasterLeaves(parentSku, SNAPSHOT.cin7BOMs || {});
    if (!resolved.ok) {
      if (isBomMasterDemandParentForPanel(row.id, parentSku)) {
        missingBom.push({
          parentSku,
          velocity: parentVelocity,
          reason: resolved.reason || resolved.issues.join('; ') || 'bom_master_unusable'
        });
      }
      continue;
    }

    let visibleChildren = 0;
    for (const [componentSku, qty] of Object.entries(resolved.components)) {
      const mappedSku = visibleComponentSku(componentSku, visible);
      if (!mappedSku || mappedSku === parentSku) continue;
      visibleChildren += 1;
      expected[mappedSku] = (expected[mappedSku] || 0) + parentVelocity * Number(qty || 0);
      evidence[mappedSku] ||= [];
      evidence[mappedSku].push({
        parentSku,
        parentVelocity,
        qty,
        rootBomSku: resolved.bomSku,
        bomReferences: [...new Set(resolved.provenance.map(item => item.reference).filter(Boolean))]
      });
    }

    // A relevant hidden bundle with a usable BOM must reach at least one
    // physical row in its panel. Otherwise it is silently excluded.
    if (isBomMasterDemandParentForPanel(row.id, parentSku) && visibleChildren === 0) {
      missingBom.push({
        parentSku,
        velocity: parentVelocity,
        reason: 'bom_master_has_no_visible_panel_component'
      });
    }
  }

  const demandGaps = [];
  for (const [componentSku, expectedVelocity] of Object.entries(expected)) {
    const actualVelocity = Number(data.velocity?.[componentSku] || 0);
    const tolerance = Math.max(0.11, expectedVelocity * 0.005);
    if (actualVelocity + tolerance < expectedVelocity) {
      demandGaps.push({
        componentSku,
        expectedAtLeast: Math.round(expectedVelocity * 100) / 100,
        actual: Math.round(actualVelocity * 100) / 100,
        evidence: evidence[componentSku]
      });
    }
  }

  return {
    id: row.id,
    name: data.ck?.name || row.name || row.id,
    visibleRows: visible.size,
    soldParentsChecked: Object.keys(sourceVelocity).length,
    missingBom,
    demandGaps
  };
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
    const list = await getJson('/api/ck-list');
    const panels = [];
    for (const row of list.list || []) panels.push(await reconcilePanel(row));

    const missingBom = panels.flatMap(panel => panel.missingBom.map(issue => ({ panel: panel.id, ...issue })));
    const demandGaps = panels.flatMap(panel => panel.demandGaps.map(issue => ({ panel: panel.id, ...issue })));
    assert.strictEqual((list.list || []).length, 20, 'universal reconciliation must cover all 20 planner tabs');
    const exclusionKeys = new Set(missingBom.map(issue => `${issue.panel}:${issue.parentSku}:${issue.reason}`));
    assert.deepStrictEqual(
      [...exclusionKeys].sort(),
      [...KNOWN_BOM_MASTER_EXCLUSIONS].sort(),
      `sold parent BOM Master exclusions changed:\n${JSON.stringify(missingBom, null, 2)}`
    );
    assert.deepStrictEqual(demandGaps, [], `sold parent/component demand reconciliation failures:\n${JSON.stringify(demandGaps, null, 2)}`);

    const visibleRows = panels.reduce((sum, panel) => sum + panel.visibleRows, 0);
    const soldParentsChecked = panels.reduce((sum, panel) => sum + panel.soldParentsChecked, 0);
    console.log(
      `Universal BOM reconciliation passed: ${panels.length} tabs, ${visibleRows} visible rows, `
      + `${soldParentsChecked} sold SKU signals checked, ${missingBom.length} known BOM-less parents fail-closed`
    );
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
