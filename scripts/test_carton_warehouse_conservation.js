#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { aggregateCartonsByWarehouse } = require('../lib/inventory');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cache-snapshot.json'), 'utf8'));
const PORT = Number(process.env.CARTON_CONSERVATION_PORT || 3995);
const SESSION_SECRET = 'demand-planner-carton-conservation-test';

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
        if (res.statusCode !== 200) return reject(new Error(`${route} returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
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
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw lastError || new Error('local planner did not become ready');
}

function cartonGroups() {
  const groups = {};
  for (const sku of Object.keys(SNAPSHOT.cin7Products || {})) {
    const match = String(sku).match(/^(.+)-(\d)$/);
    if (!match) continue;
    if (!groups[match[1]]) groups[match[1]] = [];
    groups[match[1]].push(sku);
  }
  return Object.fromEntries(Object.entries(groups).filter(([, skus]) => skus.length >= 2));
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SESSION_SECRET, ENABLE_RENDER_CIN7_SCHEDULER: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

  try {
    await waitForServer(child);
    const list = await getJson('/api/ck-list');
    assert.strictEqual((list.list || []).length, 24, 'carton conservation must audit all 24 planner tabs');
    const groups = cartonGroups();
    const checked = [];

    for (const panel of list.list || []) {
      const data = await getJson(`/api/ck/${encodeURIComponent(panel.id)}`);
      const branchIds = data.ck?.stockBranches;
      if (!Array.isArray(branchIds) || branchIds.length === 0) continue;
      for (const [parentSku, cartonSkus] of Object.entries(groups)) {
        if (!Object.prototype.hasOwnProperty.call(data.cin7 || {}, parentSku)) continue;
        const expected = aggregateCartonsByWarehouse(cartonSkus, branchIds, SNAPSHOT.cin7StockByBranch || {});
        if (!expected) continue;
        const actualSoh = Number(data.cin7?.[parentSku] || 0);
        const actualAvailable = Number(data.available?.[parentSku] || 0);
        assert.strictEqual(actualSoh, expected.soh, `${panel.id}/${parentSku}: SOH must be limiting cartons inside each warehouse, then summed`);
        assert.strictEqual(actualAvailable, expected.available, `${panel.id}/${parentSku}: Available must preserve signed limiting-carton balances inside each warehouse, then sum`);
        checked.push({ panel: panel.id, sku: parentSku, soh: actualSoh, available: actualAvailable });
      }
    }

    const required = [
      'case-goods:HANK-CT-WNT-ECO',
      'case-goods:HANK-SB160-WNT-ECO',
      'case-goods:EVE-BF-Q-ECO',
      'case-goods:HDSN-DSK-OAK-ECO',
      'case-goods:ODEN-D120-OAK-ECO',
      'case-goods:TATE-EDT-WNT-ECO',
      'cusb-us:V2-QB-DKBL'
    ];
    const keys = new Set(checked.map(row => `${row.panel}:${row.sku}`));
    for (const key of required) assert(keys.has(key), `required regression row missing: ${key}`);

    console.log(JSON.stringify({ panels: (list.list || []).length, cartonParentsChecked: checked.length, checked }, null, 2));
    console.log('Carton warehouse conservation tests passed');
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n${serverOutput.slice(-4000)}\n`);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
})();
