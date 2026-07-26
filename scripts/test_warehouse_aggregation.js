#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.WAREHOUSE_AGGREGATION_PORT || 3997);
const SESSION_SECRET = 'demand-planner-warehouse-aggregation-test';

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

function incomingFromPos(pos) {
  const incoming = {};
  for (const po of pos || []) {
    for (const [sku, rawQty] of Object.entries(po.analyticsItems || po.items || {})) {
      incoming[sku] = (incoming[sku] || 0) + Number(rawQty || 0);
    }
  }
  return incoming;
}

function comparableMap(value) {
  return Object.fromEntries(
    Object.entries(value || {})
      .filter(([, qty]) => Number(qty || 0) !== 0)
      .map(([sku, qty]) => [sku, Number(qty || 0)])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function poKey(po) {
  return `${po.id || po.orderId || po.purchaseOrderId || ''}:${String(po.reference || '').trim()}`;
}

async function verifyPanel(panelId) {
  const data = await getJson(`/api/ck/${encodeURIComponent(panelId)}`);
  const options = (data.warehouseOptions || []).filter(option => String(option.id) !== 'All');
  assert(options.length > 0, `${panelId}: expected warehouse options`);

  const branchViews = options.map(option => {
    const view = data.warehouseViews?.[String(option.id)];
    assert(view, `${panelId}: missing warehouse view ${option.id}`);
    assert(Array.isArray(view.pos), `${panelId}/${option.id}: branch PO rows missing`);
    assert(Array.isArray(view.allPos), `${panelId}/${option.id}: branch all-PO rows missing`);
    if (view.warehouseMetrics?.demandReconciled === true) {
      assert(view.velocity && typeof view.velocity === 'object', `${panelId}/${option.id}: reconciled demand needs branch velocity`);
    } else {
      assert(!Object.prototype.hasOwnProperty.call(view, 'velocity'), `${panelId}/${option.id}: must not reuse market velocity`);
    }
    assert.deepStrictEqual(
      comparableMap(view.incoming),
      comparableMap(incomingFromPos(view.pos)),
      `${panelId}/${option.id}: incoming must equal its branch-filtered physical PO lines`
    );
    for (const po of view.pos) {
      assert.strictEqual(String(po.branchId), String(option.id), `${panelId}/${option.id}: foreign PO ${po.reference}`);
    }
    return view;
  });

  const branchPoKeys = branchViews.flatMap(view => view.pos.map(poKey));
  assert.strictEqual(new Set(branchPoKeys).size, branchPoKeys.length, `${panelId}: PO appears in more than one warehouse`);
  assert.deepStrictEqual(
    [...new Set(branchPoKeys)].sort(),
    [...new Set((data.pos || []).map(poKey))].sort(),
    `${panelId}: All open POs must partition exactly across warehouse views`
  );

  const branchIncoming = {};
  for (const view of branchViews) {
    for (const [sku, qty] of Object.entries(view.incoming || {})) {
      branchIncoming[sku] = (branchIncoming[sku] || 0) + Number(qty || 0);
    }
  }
  assert.deepStrictEqual(
    comparableMap(branchIncoming),
    comparableMap(data.incoming),
    `${panelId}: All incoming must equal the sum of warehouse incoming`
  );
  if (branchViews.every(view => view.warehouseMetrics?.demandReconciled === true)) {
    const velocitySkus = new Set([
      ...Object.keys(data.velocity || {}),
      ...branchViews.flatMap(view => Object.keys(view.velocity || {}))
    ]);
    for (const sku of velocitySkus) {
      if (sku.startsWith('_')) continue;
      const total = Number(data.velocity?.[sku] || 0);
      const branchTotal = branchViews.reduce((sum, view) => sum + Number(view.velocity?.[sku] || 0), 0);
      assert(
        Math.abs(total - branchTotal) <= 0.011,
        `${panelId}/${sku}: All velocity ${total} must equal branch velocity ${branchTotal}`
      );
    }
  }

  return {
    panelId,
    poCounts: options.map((option, index) => `${option.name}:${branchViews[index].pos.length}`),
    incoming: options.map((option, index) => Object.values(branchViews[index].incoming || {}).reduce((sum, qty) => sum + Number(qty || 0), 0)),
    demandReconciled: branchViews.map(view => view.warehouseMetrics?.demandReconciled === true),
    overstock: branchViews.map(view => Object.keys(view.cin7 || {}).reduce((sum, sku) => {
      const velocity = Number(view.velocity?.[sku] || 0);
      if (velocity <= 0) return sum;
      const excess = Math.max(0, Math.round(Number(view.cin7?.[sku] || 0) - velocity * 25));
      return sum + excess * Number(data.costs?.[sku] || 0);
    }, 0))
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
    const results = [];
    for (const panelId of ['llau', 'llnz', 'llna']) results.push(await verifyPanel(panelId));
    console.log(`Warehouse aggregation passed: ${JSON.stringify(results)}`);
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
