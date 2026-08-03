const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cache-snapshot.json'), 'utf8'));

const catalogue = Object.freeze({
  BABL: { name: 'Baby Blue', className: 'sku-cover-babl', background: '#93C5FD' },
  CTCN: { name: 'Cotton Candy', className: 'sku-cover-ctcn', background: '#FDA4AF' },
  DGY: { name: 'Dove Grey', className: 'sku-cover-dgy', background: '#D1D5DB' },
  DSBL: { name: 'Dusty Blue', className: 'sku-cover-dsbl', background: '#7DD3FC' },
  MSM: { name: 'Marshmallow', className: 'sku-cover-msm', background: '#FEF3C7' },
  PST: { name: 'Pistachio', className: 'sku-cover-pst', background: '#BBF7D0' }
});

const currentCoverCodes = new Set();
for (const sku of Object.keys(snapshot.cin7Products || {})) {
  const match = sku.toUpperCase().match(/^(?:LLAU|LLNA|LLSG|LLUK|LLCA|LLNZ)-CB-[^-]+-([^-]+)-CV(?:-|$)/);
  if (match) currentCoverCodes.add(match[1]);
}

assert.deepStrictEqual([...currentCoverCodes].sort(), Object.keys(catalogue).sort(), 'current Little Lifely cover catalogue changed');
assert(html.includes('const LITTLE_LIFELY_COVER_COLOURS=Object.freeze({'), 'explicit cover colour catalogue missing');
assert(html.includes("match(/-([A-Z0-9]+)-CV(?:-|$)/)"), 'cover colour lookup must use the explicit colour segment before CV');
assert(html.includes('title="\'+title+\'"'), 'cover badges must expose the full colour name');
assert(html.includes('sku-cover-generic'), 'unknown covers need a neutral fallback');

for (const [code, colour] of Object.entries(catalogue)) {
  assert(html.includes(`${code}:{name:'${colour.name}',className:'${colour.className}'}`), `${code} catalogue entry missing`);
  assert(html.includes(`.${colour.className}{background:${colour.background};`), `${code} visual colour missing`);
}

console.log(`Little Lifely cover colour badges: PASS (${currentCoverCodes.size} catalogue colours)`);
