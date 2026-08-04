#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(ROOT, 'data', 'cache-snapshot.json');
const SNAPSHOT = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
const PORT = Number(process.env.CASE_GOODS_STATUS_PORT || 3996);
const SESSION_SECRET = 'demand-planner-case-goods-status-test';
const CASE_GOODS_OPTION1 = 'case goods - active';
const KNOWN_DEMAND_ONLY_BUNDLES = new Set(['RKU-SOFA-SET']);

function isCaseGoodsSku(sku) {
  const s = String(sku || '').toUpperCase();
  if (!s) return false;
  const compact = s.replace(/[^A-Z0-9]/g, '');
  if (['LIFELYCARE', 'CAREINSURANCE', 'INSURANCE', 'GIFTCARD'].some(value => compact.includes(value))) return false;
  if (s.startsWith('LLAU') || s.startsWith('LLUS') || s.startsWith('LLUK') || s.startsWith('LLNZ') || s.startsWith('LLSG') || s.startsWith('LLCA') || s.startsWith('LLNA') || s.startsWith('LL-')) return false;
  if (s.startsWith('CUSB') || s.startsWith('V2-') || s.startsWith('V3-') || s.startsWith('CMSS') || s.startsWith('CLV2') || s.startsWith('CSV2') || s.startsWith('LFSB')) return false;
  if (s.startsWith('LFSF') || s.startsWith('LIFELY-SOFA')) return false;
  if (s.startsWith('CCN') || s.startsWith('COCOON')) return false;
  if (s.startsWith('DD-') || s.startsWith('DDM') || s.startsWith('DDRM')) return false;
  if (s.startsWith('RAD') || s.startsWith('RDNT')) return false;
  if (s.startsWith('WFH') || s.startsWith('PAD-')) return false;
  if (['QB+ARMREST', 'TB+ARMREST', 'TB-ARMREST', 'DB+ARMREST', 'OB-', 'OS-'].some(part => s.includes(part))) return false;
  return true;
}

function caseGoodsSourceRows() {
  return Object.entries(SNAPSHOT.cin7Products || {}).filter(([sku, product]) => (
    isCaseGoodsSku(sku)
    && String(product?.option1 || '').trim().toLowerCase() === CASE_GOODS_OPTION1
  ));
}

function sessionToken() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 10 * 60 * 1000, nonce: 'case-goods-public' })).toString('base64url');
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

(async () => {
  const sources = caseGoodsSourceRows();
  const publicSources = sources.filter(([, product]) => product?.status === 'Public').map(([sku]) => sku);
  const nonPublicSources = sources.filter(([, product]) => product?.status !== 'Public').map(([sku]) => sku);
  const publicLegacySources = Object.entries(SNAPSHOT.cin7Products || {}).filter(([sku, product]) => (
    isCaseGoodsSku(sku)
    && String(product?.option1 || '').trim().toLowerCase() === 'case goods - discontinued'
    && product?.status === 'Public'
  )).map(([sku]) => sku);
  assert(publicSources.length > 0, `expected Public + Case goods - Active sources, got ${publicSources.length}`);
  assert(nonPublicSources.length > 0, 'fixture must include Non-Public Case Goods products to prove exclusion');
  assert(publicLegacySources.length > 0, 'fixture must include Public legacy-category products to prove the Option1 intersection');
  assert.strictEqual(
    sources.filter(([, product]) => !String(product?.status || '').trim()).length,
    0,
    'every Case Goods source product must retain product-level Cin7 status'
  );

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
    const data = await getJson('/api/ck/case-goods');
    const visible = new Set(Object.keys(data.cin7 || {}));
    const supported = new Set(publicSources);
    for (const sku of publicSources) {
      if (/-\d+$/.test(sku)) supported.add(sku.replace(/-\d+$/, ''));
    }

    const missing = publicSources.filter(sku => (
      !KNOWN_DEMAND_ONLY_BUNDLES.has(sku)
      && !visible.has(sku)
      && !visible.has(sku.replace(/-\d+$/, ''))
    ));
    const stockOnlyRows = [...visible].filter(sku => !supported.has(sku));
    const unsupported = stockOnlyRows.filter(sku => Number(data.cin7?.[sku] || 0) <= 0);

    assert.deepStrictEqual(missing, [], `Public Cin7 Case Goods missing from panel: ${missing.slice(0, 20).join(', ')}`);
    assert.deepStrictEqual(unsupported, [], `panel rows outside Public + Active without positive SOH: ${unsupported.slice(0, 20).join(', ')}`);
    assert(stockOnlyRows.length > 0, 'fixture must include additional Case Goods rows retained only because SOH is positive');

    console.log(JSON.stringify({
      sourceProducts: sources.length,
      publicSourceSkus: publicSources.length,
      nonPublicSourceSkus: nonPublicSources.length,
      publicLegacySourceSkusAudited: publicLegacySources.length,
      normalizedVisibleRows: visible.size,
      positiveSohRowsAdded: stockOnlyRows.length,
      demandOnlyBundles: [...KNOWN_DEMAND_ONLY_BUNDLES]
    }, null, 2));
    console.log('Case Goods Cin7 Public-status tests passed');
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    child.kill('SIGTERM');
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
