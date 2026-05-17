#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(ROOT, 'data', 'cache-snapshot.json');
const WARN_STALE_HOURS = 6;
const MIN_PRODUCTS = 1000;
const MIN_POS = 50;
const EXPECTED_STORES = ['lifely', 'cushie', 'littlelifely'];
const REQUIRED_OPTION1 = [
  'Category Killer - Little Lifely',
  'Category Killer - 21cm Mattress',
  'Category Killer - Deepdream',
  'Category Killer - Deep Dream',
  'Category Killer - Cocoon Bed',
  'Category Killer - Radiant',
  'Category Killer - WFH Chair',
  'Category Killer - Cushie V3 Snuggle',
  'Category Killer - Cushie V2',
  'Category Killer - Lifely Sofa',
  'Case goods - Active',
  'Case goods - Discontinued'
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { throw new Error(`${path.relative(ROOT, file)} is not valid JSON: ${err.message}`); }
}
function norm(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function ageHours(value) {
  const ts = Date.parse(value || '');
  if (!Number.isFinite(ts)) return null;
  return Math.round(((Date.now() - ts) / 36e5) * 10) / 10;
}
function hasPayload(obj, store) {
  return !!obj?.[store] && Object.keys(obj[store] || {}).filter(k => !k.startsWith('__')).length > 0;
}
function isCaseGoodsSku(sku) {
  const s = String(sku || '').toUpperCase();
  const compact = s.replace(/[^A-Z0-9]/g, '');
  if (['LIFELYCARE', 'CAREINSURANCE', 'INSURANCE', 'GIFTCARD'].some(x => compact.includes(x))) return false;
  return true;
}
const CK_DEFS = {
  llau: { name:'Little Lifely AU', prefix:'LLAU-CB-', option1:'Category Killer - Little Lifely', filter:s=>!s.includes('CBCF') },
  llnz: { name:'Little Lifely NZ', prefix:'LLAU-CB-', option1:'Category Killer - Little Lifely', filter:s=>!s.includes('CBCF') },
  'll-mattresses': { name:'LL Mattresses', prefix:'MULTI', option1:['Category Killer - 21cm Mattress','Category Killer - Deep Dream'], option1Bypass:s=>s.startsWith('DDUK'), filter:s=>['DD-21915CF','DD-21107CF','DD-21137CF'].includes(s)||s.startsWith('DDUK') },
  dd: { name:'Deep Dream', prefix:'MULTI', option1:'Category Killer - Deepdream' },
  cocoon: { name:'Cocoon Bed', prefix:'COCOON', option1:'Category Killer - Cocoon Bed' },
  rdnt: { name:'Radiant', prefix:'RDNT', option1:'Category Killer - Radiant' },
  wfhcr: { name:'WFH Chair', prefix:'WFHCR', option1:'Category Killer - WFH Chair' },
  'cusb-au-snuggle': { name:'Cushie Snuggle Bed', prefix:'MULTI', option1:'Category Killer - Cushie V3 Snuggle', filter:s=>s.startsWith('CUSB')&&!s.includes('-UK')&&!s.includes('SGE'), excludeCV:true },
  'cusb-au-lifely': { name:'Lifely Sofabed', prefix:'MULTI', option1:['Category Killer - Cushie V2','Category Killer - Lifely Sofa'], filter:s=>s.startsWith('LFSB')&&!s.includes('-UK'), excludeCV:true },
  'cusb-us': { name:'Cushie US', prefix:'MULTI', option1:['Category Killer - Cushie V2','Category Killer - Cushie V3 Snuggle'], filter:s=>s.startsWith('V2-')||s.startsWith('V3-'), excludeCV:true },
  'cusb-uk': { name:'Cushie UK', prefix:'MULTI', option1:['Category Killer - Cushie V2','Category Killer - Cushie V3 Snuggle'], filter:s=>(s.startsWith('CUSB')||s.startsWith('LFSB'))&&s.includes('-UK'), excludeCV:true },
  cmss: { name:'Cushie Modular Sleeper', prefix:'CMSS', option1:'Category Killer - Cushie V2' },
  'lifely-sofa': { name:'Modular Sofa', prefix:'LIFELY', option1:'Category Killer - Lifely Sofa' },
  'case-goods': { name:'Case Goods', prefix:'MULTI', option1:['Case goods - Active','Case goods - Discontinued'], filter:isCaseGoodsSku }
};
function optionAllowed(actual, allowed) {
  if (!allowed) return true;
  const list = Array.isArray(allowed) ? allowed : [allowed];
  return list.some(v => norm(v) === norm(actual));
}
function matchesDef(sku, option1, def) {
  const s = String(sku || '').toUpperCase();
  const filter = def.filter || (() => true);
  if (def.prefix === 'MULTI') { if (!filter(s)) return false; }
  else if (!(s.startsWith(def.prefix) && filter(s))) return false;
  if (def.excludeCV && s.includes('-CV')) return false;
  if (def.option1Bypass && def.option1Bypass(s)) return true;
  return optionAllowed(option1, def.option1);
}
function routeSku(sku, products) {
  const option1 = products[sku]?.option1 || products[String(sku).toUpperCase()]?.option1 || '';
  for (const def of Object.values(CK_DEFS)) if (matchesDef(sku, option1, def)) return def.name;
  return 'Uncategorised';
}

const blockers = [];
const warnings = [];
let cache;
try { cache = readJson(CACHE_PATH); } catch (err) { blockers.push(err.message); cache = {}; }
const products = cache.cin7Products || {};
const stockByBranch = cache.cin7StockByBranch || {};
const pos = cache.cin7POs || [];

if (Object.keys(products).length < MIN_PRODUCTS) blockers.push(`Cin7 product count below floor: ${Object.keys(products).length}`);
if (Object.keys(stockByBranch).length === 0) blockers.push('Cin7 branch stock payload missing');
if (!Array.isArray(pos) || pos.length < MIN_POS) blockers.push(`Purchase order count below floor: ${Array.isArray(pos) ? pos.length : 'not-array'}`);
if (pos.some(po => !('items' in (po || {})))) blockers.push('One or more purchase orders are missing an items object');

const optionCounts = {};
for (const product of Object.values(products)) {
  const option1 = String(product?.option1 || '').trim();
  if (option1) optionCounts[option1] = (optionCounts[option1] || 0) + 1;
}
for (const required of REQUIRED_OPTION1) if (!optionCounts[required]) blockers.push(`Required Option1 category missing: ${required}`);

for (const store of EXPECTED_STORES) {
  if (!hasPayload(cache.shopifyInventory, store)) blockers.push(`Shopify ${store} inventory payload missing/empty`);
  if (!hasPayload(cache.shopifyVelocity, store)) blockers.push(`Shopify ${store} velocity payload missing/empty`);
  if (!hasPayload(cache.shopifyVelocityByCountry, store)) blockers.push(`Shopify ${store} velocityByCountry payload missing/empty`);
  if (!hasPayload(cache.shopifyOpenDemand, store)) blockers.push(`Shopify ${store} openDemand payload missing/empty`);
}

for (const [name, value] of Object.entries({ overall: cache.lastRefresh, cin7: cache.lastCin7Refresh, purchaseOrders: cache.lastPoRefresh, shopify: cache.lastShopifyRefresh })) {
  const age = ageHours(value);
  if (age === null) blockers.push(`${name} refresh timestamp missing/invalid`);
  else if (age > WARN_STALE_HOURS) warnings.push(`${name} data is ${age}h old`);
}

for (const [id, def] of Object.entries(CK_DEFS)) {
  let count = 0;
  for (const [sku, data] of Object.entries(products)) if (matchesDef(sku, data.option1 || '', def)) count += 1;
  if (count === 0) blockers.push(`CK panel has zero matching Cin7 SKUs: ${id}`);
}

const fixtures = [
  { sku: 'LIFELY-CPD', expected: 'Case Goods' },
  { sku: 'COCOON-DOUBLE-IVR', expected: 'Cocoon Bed' },
  { sku: 'RDNT-D-BASE', expected: 'Radiant' },
  { sku: 'LLAU-CB-S-MSM', expected: 'Little Lifely AU' },
  { sku: 'DD-21153CF', expected: 'Deep Dream' },
  { sku: 'DD-34183K-SFM', expected: 'Deep Dream' },
  { sku: 'DDUK-2190CF', expected: 'LL Mattresses' }
];
for (const fixture of fixtures) {
  const actual = routeSku(fixture.sku, products);
  if (actual !== fixture.expected) blockers.push(`SKU fixture route mismatch: ${fixture.sku} expected ${fixture.expected}, got ${actual}`);
}

if (warnings.length) {
  console.warn('Demand Planner deploy warnings:');
  for (const warning of warnings) console.warn(`- ${warning}`);
}
if (blockers.length) {
  console.error('Demand Planner deploy blocked:');
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exit(1);
}
console.log(`Demand Planner deploy gate passed: ${Object.keys(products).length} Cin7 SKUs, ${pos.length} POs, ${EXPECTED_STORES.length} Shopify stores checked.`);
