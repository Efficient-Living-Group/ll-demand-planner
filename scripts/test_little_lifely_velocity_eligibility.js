#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  isLlnaShopifyVelocitySku,
  isLlauActiveSetShopifyVelocitySku,
  isShopifyVelocitySourceEligibleForPanel
} = require('../lib/little-lifely-demand');

for (const sku of [
  'LLNA-CTP-TW-MSM-MSM',
  'LLNA-CTP-TW-MSM-MSM-SET',
  'LLNA-CB-TW-MSM',
  'LLNA-CB-TW-MSM-SET',
  'LLNA-CFDS-F-DGY',
  'LLNA-CFDS-F-DGY-SET',
  'LLNA-CB-TWX-PST-CV'
]) {
  assert.strictEqual(isLlnaShopifyVelocitySku(sku), true, `${sku} must contribute to LLNA Shopify velocity`);
  assert.strictEqual(isShopifyVelocitySourceEligibleForPanel('llna', sku), true);
  assert.strictEqual(isShopifyVelocitySourceEligibleForPanel('llca', sku), true);
}

for (const sku of [
  'LLNA-CB-TW-FRM',
  'LLNA-CB-TW-MSM-CSTM',
  'LLNA-UNKNOWN-TW-MSM'
]) {
  assert.strictEqual(isLlnaShopifyVelocitySku(sku), false, `${sku} must not be a direct LLNA Shopify velocity source`);
}

for (const sku of [
  'LLAU-CB-S-MSM-SET',
  'LLAU-CBCF-KS-PST-SET',
  'LLAU-CTP-D-PST-PST',
  'LLAU-CTP-D-PST-PST-SET',
  'LLAU-CB-CS-PACK'
]) {
  assert.strictEqual(isLlauActiveSetShopifyVelocitySku(sku), true, `${sku} must remain an active LLAU set source`);
  assert.strictEqual(isShopifyVelocitySourceEligibleForPanel('llau', sku), true);
  assert.strictEqual(isShopifyVelocitySourceEligibleForPanel('llnz', sku), true);
}

for (const sku of [
  'LLAU-CB-S-MSM',
  'LLAU-CBCF-KS-PST',
  'LLAU-CB-S-MSM-CV',
  'LLAU-CB-S-FRM'
]) {
  assert.strictEqual(isLlauActiveSetShopifyVelocitySku(sku), false, `${sku} is legacy/component demand and must not add direct LLAU velocity`);
  assert.strictEqual(isShopifyVelocitySourceEligibleForPanel('llau', sku), false);
  assert.strictEqual(isShopifyVelocitySourceEligibleForPanel('ll-mattresses', sku), false);
}

assert.strictEqual(
  isShopifyVelocitySourceEligibleForPanel('ll-mattresses', 'LLAU-CBCF-D-MSM-SET'),
  true,
  'active AU combo sets must continue to credit mattress velocity'
);
assert.strictEqual(
  isShopifyVelocitySourceEligibleForPanel('ll-mattresses', 'LLAU-CTP-D-MSM-MSM'),
  true,
  'active AU transition-pack sets must continue to credit mattress velocity'
);
assert.strictEqual(
  isShopifyVelocitySourceEligibleForPanel('ll-mattresses', 'LLUK-CBCF-D-MSM'),
  true,
  'the LLAU eligibility rule must not change UK mattress demand'
);
assert.strictEqual(
  isShopifyVelocitySourceEligibleForPanel('cocoon', 'COCOON-QUEEN-IVR'),
  true,
  'unrelated panels must remain unchanged'
);

console.log('Little Lifely Shopify velocity eligibility tests passed');
