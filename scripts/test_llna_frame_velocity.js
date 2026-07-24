#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  llnaFrameComponentsForDemandSku,
  addLlnaFrameVelocity
} = require('../lib/little-lifely-demand');

const bomMap = {
  'LLNA-CB-TW-DGY-SET': {
    components: {
      'LLNA-CB-TW-DGY-CV': 1,
      'LLNA-CB-TW-FRM': 1
    }
  },
  'LLNA-CFDS-F-MSM-SET': {
    components: {
      'DS-FULL': 1,
      'LLNA-CB-F-MSM-CV': 1,
      'LLNA-CB-F-FRM': 1
    }
  },
  'LLNA-CTP-TWX-MSM-MSM-SET': {
    components: {
      'DS-TWIN-XL': 1,
      'LLNA-CB-TWX-MSM-CV': 2,
      'LLNA-CB-TWX-FRM': 1
    }
  }
};

assert.deepStrictEqual(
  llnaFrameComponentsForDemandSku('LLNA-CB-TW-DGY', bomMap),
  ['LLNA-CB-TW-FRM'],
  'base bed sales must resolve through the matching SET BOM'
);
assert.deepStrictEqual(
  llnaFrameComponentsForDemandSku('LLNA-CFDS-F-MSM-SET', bomMap),
  ['LLNA-CB-F-FRM'],
  'combo sales must credit the physical Full frame'
);
assert.deepStrictEqual(
  llnaFrameComponentsForDemandSku('LLNA-CTP-TWX-MSM-MSM', bomMap),
  ['LLNA-CB-TWX-FRM'],
  'transition-pack sales must credit the physical Twin XL frame'
);
assert.deepStrictEqual(
  llnaFrameComponentsForDemandSku('LLNA-CB-F-NEWCOLOUR', bomMap),
  ['LLNA-CB-F-FRM'],
  'new parent variants must fail safe to the deterministic size frame'
);
assert.deepStrictEqual(llnaFrameComponentsForDemandSku('LLNA-CB-TW-DGY-CV', bomMap), []);
assert.deepStrictEqual(llnaFrameComponentsForDemandSku('LLNA-CB-TW-FRM', bomMap), []);

const velocity = {};
addLlnaFrameVelocity(velocity, {
  'LLNA-CB-TW-DGY': 2.1,
  'LLNA-CFDS-F-MSM-SET': 3.4,
  'LLNA-CTP-TWX-MSM-MSM': 0.7,
  'LLNA-CB-TW-DGY-CV': 9
}, bomMap);
assert.deepStrictEqual(velocity, {
  'LLNA-CB-TW-FRM': 2.1,
  'LLNA-CB-F-FRM': 3.4,
  'LLNA-CB-TWX-FRM': 0.7
});

const canonicalVelocity = {};
addLlnaFrameVelocity(
  canonicalVelocity,
  { 'LLAU-CBCF-D-MSM': 1.2 },
  bomMap,
  () => 'LLNA-CFDS-F-MSM-SET'
);
assert.deepStrictEqual(canonicalVelocity, { 'LLNA-CB-F-FRM': 1.2 });

console.log('LLNA frame velocity tests passed');
