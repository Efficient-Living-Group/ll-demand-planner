#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cache-snapshot.json'), 'utf8'));
const PORT = Number(process.env.PO_SOURCE_INTEGRITY_PORT || 3997);
const SESSION_SECRET = 'po-cin7-source-integrity-test';

function sessionToken() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 600000, nonce: 'po-source' })).toString('base64url');
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
        if (res.statusCode !== 200) return reject(new Error(`${route} returned HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`local planner exited with code ${child.exitCode}`);
    try {
      await getJson('/api/health', false);
      return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('local planner did not become ready');
}

function poKey(po) {
  return String(po.id || po.orderId || po.purchaseOrderId || po.reference || '');
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SESSION_SECRET, ENABLE_RENDER_CIN7_SCHEDULER: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await waitForServer(child);
    const response = await getJson('/api/all-pos');
    const expected = new Map((SNAPSHOT.cin7POs || [])
      .filter(po => Object.keys(po.items || {}).length > 0)
      .map(po => [poKey(po), po.items || {}]));
    const actual = new Map((response.pos || []).map(po => [poKey(po), po.items || {}]));

    assert.strictEqual(actual.size, expected.size, 'PO count must match the Cin7 snapshot exactly');
    for (const [key, items] of expected) {
      assert(actual.has(key), `Cin7 PO ${key} missing from /api/all-pos`);
      assert.deepStrictEqual(actual.get(key), items, `Cin7 PO ${key} item SKUs or quantities were altered`);
    }

    const required = ['DD-153QMF', 'DD-183KMF', 'DD-21153CF', 'DD-21183CF'];
    for (const sku of required) {
      const sourceQty = [...expected.values()].reduce((sum, items) => sum + Number(items[sku] || 0), 0);
      const apiQty = [...actual.values()].reduce((sum, items) => sum + Number(items[sku] || 0), 0);
      assert(sourceQty > 0, `${sku} has no PO source evidence in the frozen Cin7 snapshot`);
      assert.strictEqual(apiQty, sourceQty, `${sku} PO quantity must remain exact even when catalogue visibility changes`);
    }

    console.log(`Cin7 PO source integrity: PASS (${actual.size} POs, exact SKU and quantity parity)`);
  } catch (error) {
    if (output) process.stderr.write(output);
    throw error;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
