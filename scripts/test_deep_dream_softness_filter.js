const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cache-snapshot.json'), 'utf8'));
const { DEEP_DREAM_DISCONTINUED_SKUS, DEEP_DREAM_SOFTNESS_BY_SKU } = require('../lib/deep-dream-softness');

const currentDeepDreamSkus = Object.entries(snapshot.cin7Products || {})
  .filter(([, product]) => product?.option1 === 'Category Killer - Deepdream')
  .map(([sku]) => sku)
  .filter(sku => !DEEP_DREAM_DISCONTINUED_SKUS.includes(sku))
  .sort();
const mappedSkus = Object.keys(DEEP_DREAM_SOFTNESS_BY_SKU).sort();

assert.deepStrictEqual(mappedSkus, currentDeepDreamSkus, 'every current Deep Dream SKU must have one explicit softness assignment');
assert(mappedSkus.length > 0, 'Deep Dream catalogue must not be empty');

const allowed = new Set(['plush', 'medium', 'firm']);
const counts = { plush: 0, medium: 0, firm: 0 };
for (const [sku, softness] of Object.entries(DEEP_DREAM_SOFTNESS_BY_SKU)) {
  assert(allowed.has(softness), `${sku} has unsupported softness ${softness}`);
  counts[softness] += 1;
}
assert.deepStrictEqual(counts, { plush: 3, medium: 7, firm: 3 }, 'Deep Dream softness counts changed unexpectedly');

assert.strictEqual(DEEP_DREAM_SOFTNESS_BY_SKU['DD-137D-PLUSH'], 'plush');
assert.strictEqual(DEEP_DREAM_SOFTNESS_BY_SKU['DD-153QMF'], 'medium');
assert.strictEqual(DEEP_DREAM_SOFTNESS_BY_SKU['DD-183KMF'], 'medium');
assert.strictEqual(DEEP_DREAM_SOFTNESS_BY_SKU['DD-36153SG'], 'medium');
assert.strictEqual(DEEP_DREAM_SOFTNESS_BY_SKU['DD-34153Q-SFM'], 'firm');
assert.deepStrictEqual(DEEP_DREAM_DISCONTINUED_SKUS, ['DD-21153CF', 'DD-21183CF'], 'Cin7-verified inactive Deep Dream exclusion set changed');
for (const sku of DEEP_DREAM_DISCONTINUED_SKUS) {
  assert(!Object.prototype.hasOwnProperty.call(DEEP_DREAM_SOFTNESS_BY_SKU, sku), `${sku} must not remain in active softness metadata`);
}

assert(server.includes("softnessBySku: ckId === 'dd' ? DEEP_DREAM_SOFTNESS_BY_SKU : {}"), 'Deep Dream softness metadata missing from CK payload');
assert(server.includes('DEEP_DREAM_DISCONTINUED_SKUS.includes(normalized)'), 'Deep Dream discontinued SKUs must be excluded from planner payloads');
assert(server.includes('Planner catalogue visibility must'), 'Cin7 PO source-integrity guard missing');
assert(html.includes("[['all','All'],['plush','Plush'],['medium','Medium'],['firm','Firm']]"), 'Deep Dream softness tabs missing');
assert(html.includes("if(currentCK==='dd'&&counts.unclassified>0)tabs.push(['unclassified','Unclassified'])"), 'unclassified safety tab missing');
assert(html.includes("row.__ddSoftness=stockTableSoftnessBySku[sku]||'unclassified'"), 'rendered Deep Dream row must use explicit metadata');
assert(html.includes("if(currentCK==='dd')return row?.__ddSoftness===llnaGridSegment"), 'Deep Dream segment predicate missing');
assert(html.includes("quickFilterText:llnaGridSearch"), 'search must remain composed with softness filtering');
assert(html.includes('.llna-grid-segments[hidden]{display:none!important}'), 'segment tabs must remain hidden on unrelated CK tabs');

const captureStart = html.indexOf('function captureLlnaClassicTable()');
const captureEnd = html.indexOf('function llnaGridTheme()', captureStart);
const captureBody = html.slice(captureStart, captureEnd);
assert(!/PLUSH|SFM|MF|SG|CF/.test(captureBody), 'softness must not be inferred from SKU text in the table adapter');

console.log(`Deep Dream softness filter regression: PASS (${counts.plush} plush, ${counts.medium} medium, ${counts.firm} firm)`);
