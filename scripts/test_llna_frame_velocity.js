#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  littleLifelyCtpComponentsForDemandSku,
  cocoonPhysicalComponentsForDemandSku,
  caseGoodsBundleComponentsForDemandSku,
  llnaFrameComponentsForDemandSku,
  addLlnaFrameVelocity,
  addLlnaFrameTrend
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
  },
  'LLNA-CTP-TWX-MSM-MSM': {
    components: {
      'DS-TWIN-XL': 1,
      'LLNA-CB-TWX-MSM-CV': 1,
      'LLNA-CB-TWX-MSM': 1
    }
  },
  'LLAU-CTP-D-PST-PST': {
    components: {
      'DD-21137CF': 1,
      'LLAU-CB-D-PST-CV': 2,
      'LLAU-CB-D-FRM': 1
    }
  },
  'LLUK-CTP-SD-MSM-MSM': {
    components: {
      'DDUK-21120CF': 1,
      'LLUK-CB-SD-MSM-CV': 2,
      'LLUK-CB-SD-FRM': 1
    }
  },
  'COCOON-QUEEN-IVR': {
    components: {
      'COCOON-QUEEN-FRM': 1,
      'COCOON-QUEEN-IVR-CV': 1
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
  [],
  'transition packs must use the shared BOM mapper so LLNA frames are not counted twice'
);
assert.deepStrictEqual(
  llnaFrameComponentsForDemandSku('LLNA-CB-F-NEWCOLOUR', bomMap),
  ['LLNA-CB-F-FRM'],
  'new parent variants must fail safe to the deterministic size frame'
);
assert.deepStrictEqual(llnaFrameComponentsForDemandSku('LLNA-CB-TW-DGY-CV', bomMap), []);
assert.deepStrictEqual(llnaFrameComponentsForDemandSku('LLNA-CB-TW-FRM', bomMap), []);

assert.deepStrictEqual(
  littleLifelyCtpComponentsForDemandSku('LLNA-CTP-TWX-MSM-MSM', bomMap),
  ['DS-TWIN-XL', 'LLNA-CB-TWX-MSM-CV', 'LLNA-CB-TWX-MSM-CV', 'LLNA-CB-TWX-FRM'],
  'LLNA transition packs must resolve the -SET BOM alias and preserve component quantities'
);
assert.deepStrictEqual(
  littleLifelyCtpComponentsForDemandSku('LLAU-CTP-D-PST-PST', bomMap),
  ['DD-21137CF', 'LLAU-CB-D-PST-CV', 'LLAU-CB-D-PST-CV', 'LLAU-CB-D-FRM'],
  'AU transition packs must resolve their exact BOM'
);
assert.deepStrictEqual(
  littleLifelyCtpComponentsForDemandSku('LLUK-CTP-SD-MSM-MSM', bomMap),
  ['DDUK-21120CF', 'LLUK-CB-SD-MSM-CV', 'LLUK-CB-SD-MSM-CV', 'LLUK-CB-SD-FRM'],
  'UK transition packs must resolve their exact BOM'
);
assert.deepStrictEqual(
  cocoonPhysicalComponentsForDemandSku('COCOON-QUEEN-IVR', bomMap),
  ['COCOON-QUEEN-FRM', 'COCOON-QUEEN-IVR-CV'],
  'Cocoon sellable-bed demand must credit its physical frame and cover'
);
assert.deepStrictEqual(
  caseGoodsBundleComponentsForDemandSku('EMMA-NOAH-4S'),
  ['EMMA-DT180-OAK-ECO', 'NOAH-DC-WHT-ECO', 'NOAH-DC-WHT-ECO'],
  'the EMMA bundle must credit one table and two chairs without counting the table carton twice'
);

const velocity = {};
addLlnaFrameVelocity(velocity, {
  'LLNA-CB-TW-DGY': 2.1,
  'LLNA-CFDS-F-MSM-SET': 3.4,
  'LLNA-CTP-TWX-MSM-MSM': 0.7,
  'LLNA-CB-TW-DGY-CV': 9
}, bomMap);
assert.deepStrictEqual(velocity, {
  'LLNA-CB-TW-FRM': 2.1,
  'LLNA-CB-F-FRM': 3.4
});

const canonicalVelocity = {};
addLlnaFrameVelocity(
  canonicalVelocity,
  { 'LLAU-CBCF-D-MSM': 1.2 },
  bomMap,
  () => 'LLNA-CFDS-F-MSM-SET'
);
assert.deepStrictEqual(canonicalVelocity, { 'LLNA-CB-F-FRM': 1.2 });

const trend = {};
addLlnaFrameTrend(trend, {
  _7d: {
    'LLNA-CB-TW-DGY': 8,
    'LLNA-CFDS-F-MSM-SET': 11,
    'LLNA-CB-TW-DGY-CV': 99
  },
  _30d: {
    'LLNA-CB-TW-DGY': 31,
    'LLNA-CFDS-F-MSM-SET': 42
  },
  _weeklyBreakdown: {
    'LLNA-CB-TW-DGY': { '2026-W28': 6, '2026-W29': 8 },
    'LLNA-CFDS-F-MSM-SET': { '2026-W28': 9, '2026-W29': 11 },
    'LLNA-CB-TW-DGY-CV': { '2026-W28': 99 }
  },
  _firstSeen: {
    'LLNA-CB-TW-DGY': '2026-02-10T00:00:00.000Z',
    'LLNA-CFDS-F-MSM-SET': '2026-01-05T00:00:00.000Z'
  }
}, bomMap);
assert.deepStrictEqual(trend, {
  _7d: {
    'LLNA-CB-TW-FRM': 8,
    'LLNA-CB-F-FRM': 11
  },
  _30d: {
    'LLNA-CB-TW-FRM': 31,
    'LLNA-CB-F-FRM': 42
  },
  _weeklyBreakdown: {
    'LLNA-CB-TW-FRM': { '2026-W28': 6, '2026-W29': 8 },
    'LLNA-CB-F-FRM': { '2026-W28': 9, '2026-W29': 11 }
  },
  _firstSeen: {
    'LLNA-CB-TW-FRM': '2026-02-10T00:00:00.000Z',
    'LLNA-CB-F-FRM': '2026-01-05T00:00:00.000Z'
  }
});

console.log('Component demand mapping tests passed');
