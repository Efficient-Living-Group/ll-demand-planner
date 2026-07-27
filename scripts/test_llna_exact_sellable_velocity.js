#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isLlnaSellableParentSku } = require('../lib/little-lifely-demand');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const snapshot = require('../data/cache-snapshot.json');

for (const sku of [
  'LLNA-CB-F-BABL',
  'LLNA-CB-TW-CTCN',
  'LLNA-CB-TWX-MSM',
  'LLNA-CFDS-F-PST',
  'LLNA-CB-F-BABL-SET'
]) {
  assert.strictEqual(isLlnaSellableParentSku(sku), true, `${sku} must be an LLNA sellable parent`);
}

for (const sku of [
  'LLNA-CB-F-BABL-CV',
  'LLNA-CB-F-FRM',
  'LLNA-CB-TW-MSM-CSTM'
]) {
  assert.strictEqual(isLlnaSellableParentSku(sku), false, `${sku} must remain component demand`);
}

assert(
  server.includes('const exactSellableVelocity = {};')
    && server.includes('exactSellableVelocity[sku] = Number(sellableVelocity[sku] || 0);'),
  'Server must publish exact direct Shopify velocity for visible LLNA sellable-parent rows'
);
assert(
  server.includes('const exactSellableWeeklyData = {};')
    && server.includes('exactSellableWeeklyData[sku][week] ='),
  'Server must publish exact direct 90-day weekly history for LLNA sellable-parent stock turn'
);
assert(
  frontend.includes('function hasExactSellableVel(s)')
    && frontend.includes('if(hasExactSellableVel(s))'),
  'Frontend must prefer the exact sellable-parent velocity before any historical fallback'
);
assert(
  frontend.includes('exactSellableVelocity:d.exactSellableVelocity||{}')
    && frontend.includes('exactSellableWeeklyData:d.exactSellableWeeklyData||{}'),
  'Frontend must retain both exact sellable maps from the category API response'
);
assert(
  frontend.includes('function isEstVel(s){return!hasExactSellableVel(s)'),
  'Exact LLNA sellable-parent rows must never be labelled estimated'
);
assert(
  frontend.includes('hasExactSellableVel(s)?DATA.exactSellableWeeklyData?.[s]:DATA.weeklyData?.[s]'),
  'Stock turn must use exact direct 90-day history for LLNA sellable-parent rows'
);

const usSources = Object.values(snapshot.shopifyVelocityByCountry || {})
  .map(store => store?.US || {});
const sku = 'LLNA-CB-F-BABL';
const exact30DayUnits = usSources.reduce((sum, source) => sum + Number(source?._30d?.[sku] || 0), 0);
const exactWeeklyVelocity = exact30DayUnits / 30 * 7;
assert.strictEqual(exact30DayUnits, 29, 'Fixture must retain 29 exact 30-day Shopify units');
assert(Math.abs(exactWeeklyVelocity - 6.766666666666667) < 1e-12);
assert.notStrictEqual(
  Math.round(exactWeeklyVelocity * 10) / 10,
  6.5,
  'Exact Shopify velocity must not equal the historical 6.5/wk estimate shown in the screenshot'
);

console.log('LLNA exact sellable-parent velocity tests passed');
