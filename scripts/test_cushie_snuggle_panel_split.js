#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CUSHIE_SNUGGLE_TEST_PORT || 3997);
const SESSION_SECRET = 'cushie-snuggle-panel-split-test';

function sessionToken() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 600000, nonce: crypto.randomBytes(8).toString('hex') })).toString('base64url');
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
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error(`${route} returned invalid JSON: ${error.message}`)); }
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
      const health = await getJson('/api/health', false);
      if (health && health.ok !== undefined) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('local planner did not become ready');
}

function visibleSkus(data) {
  return new Set([
    ...Object.keys(data.cin7 || {}),
    ...Object.keys(data.velocity || {}),
    ...Object.keys(data.shopify || {})
  ].map(sku => String(sku || '').toUpperCase().trim()).filter(sku => sku && !sku.startsWith('_')));
}

function assertDisjoint(a, b, label) {
  const duplicates = [...a].filter(sku => b.has(sku));
  assert.deepStrictEqual(duplicates, [], `${label} duplicated between Cushie and Snuggle: ${duplicates.join(', ')}`);
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
    const list = await getJson('/api/ck-list');
    const byId = Object.fromEntries((list.list || []).map(row => [row.id, row]));
    const markets = [
      { market: 'AU', cushie: 'cusb-au', snuggle: 'cusb-au-snuggle', cushieMatch: sku => sku.startsWith('LFSB') && !sku.includes('-UK'), snuggleMatch: sku => sku.startsWith('CUSB') && !sku.includes('-UK') && !sku.includes('SGE') },
      { market: 'US', cushie: 'cusb-us', snuggle: 'cusb-us-snuggle', cushieMatch: sku => sku.startsWith('V2-'), snuggleMatch: sku => sku.startsWith('V3-') },
      { market: 'CA', cushie: 'cusb-ca', snuggle: 'cusb-ca-snuggle', cushieMatch: sku => sku.startsWith('V2-'), snuggleMatch: sku => sku.startsWith('V3-') },
      { market: 'UK', cushie: 'cusb-uk', snuggle: 'cusb-uk-snuggle', cushieMatch: sku => sku.startsWith('LFSB') && sku.includes('-UK'), snuggleMatch: sku => sku.startsWith('CUSB') && sku.includes('-UK') }
    ];

    let rowsChecked = 0;
    for (const cfg of markets) {
      assert.strictEqual(byId[cfg.cushie]?.brand?.id, 'cushie', `${cfg.cushie} must remain in the Cushie sidebar section`);
      assert.strictEqual(byId[cfg.snuggle]?.brand?.id, 'snuggle', `${cfg.snuggle} must appear in the Snuggle sidebar section`);
      const [cushieData, snuggleData] = await Promise.all([
        getJson(`/api/ck/${cfg.cushie}`),
        getJson(`/api/ck/${cfg.snuggle}`)
      ]);
      const cushieSkus = visibleSkus(cushieData);
      const snuggleSkus = visibleSkus(snuggleData);
      assert(cushieSkus.size > 0, `${cfg.market} Cushie panel must not be empty`);
      assert(snuggleSkus.size > 0, `${cfg.market} Snuggle panel must not be empty`);
      assert.deepStrictEqual([...cushieSkus].filter(sku => !cfg.cushieMatch(sku)), [], `${cfg.market} Cushie contains a non-Cushie family SKU`);
      assert.deepStrictEqual([...snuggleSkus].filter(sku => !cfg.snuggleMatch(sku)), [], `${cfg.market} Snuggle contains a non-Snuggle family SKU`);
      assertDisjoint(cushieSkus, snuggleSkus, cfg.market);
      rowsChecked += cushieSkus.size + snuggleSkus.size;
    }

    console.log(`Cushie/Snuggle panel split passed: 8 country tabs, ${rowsChecked} visible rows, zero cross-family duplicates`);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
