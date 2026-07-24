#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  normalizeBomComponentMap,
  resolveBomMasterLeaves,
  expandResolvedComponentMap,
  bomMasterComponentsForPanel
} = require('../lib/bom-master-demand');

const bomMap = {
  'LIFELY-SOFA-2S-LB': {
    reference: 'BOM-SOFA',
    components: {
      'LFSF-CRNR-CV-LB': 2,
      'LFSF-CRNR-FC': 2
    }
  },
  'RDNT-K-MF-SET': {
    reference: 'BOM-RADIANT',
    components: {
      'RDNT-K-MF': 2,
      'RDNT-K-BASE': 1
    }
  },
  'LLNA-CTP-TW-MSM-MSM': {
    reference: 'BOM-CTP',
    components: {
      'DS-TWIN': 1,
      'LLNA-CB-TW-MSM-CV': 1,
      'LLNA-CB-TW-MSM': 1
    }
  },
  'LLNA-CB-TW-MSM-SET': {
    reference: 'BOM-BED',
    components: {
      'LLNA-CB-TW-MSM-CV': 1,
      'LLNA-CB-TW-FRM': 1
    }
  },
  'EMMA-NOAH-4S': {
    reference: 'BOM-EMMA',
    components: {
      'NOAH-DC-WHT-ECO': 2,
      'EMMA-DT180-OAK-ECO': 1,
      'EMMA-DT180-OAK-ECO-3': 1
    }
  },
  'EMMA-DT180-OAK-ECO': {
    reference: 'BOM-TABLE',
    components: {
      'EMMA-DT180-OAK-ECO': 1,
      'EMMA-DT180-OAK-ECO-3': 1
    }
  }
};

assert.deepStrictEqual(
  normalizeBomComponentMap(bomMap['EMMA-NOAH-4S']),
  {
    'NOAH-DC-WHT-ECO': 2,
    'EMMA-DT180-OAK-ECO': 1
  },
  'multi-carton base and carton rows must represent one required table'
);

const sofa = resolveBomMasterLeaves('LIFELY-SOFA-2S-LB', bomMap);
assert.strictEqual(sofa.ok, true);
assert.deepStrictEqual(sofa.components, {
  'LFSF-CRNR-CV-LB': 2,
  'LFSF-CRNR-FC': 2
});

const radiant = resolveBomMasterLeaves('RDNT-K-MF-SET', bomMap);
assert.strictEqual(radiant.ok, true);
assert.deepStrictEqual(radiant.components, {
  'RDNT-K-MF': 2,
  'RDNT-K-BASE': 1
});
assert.deepStrictEqual(
  expandResolvedComponentMap(radiant.components),
  ['RDNT-K-MF', 'RDNT-K-MF', 'RDNT-K-BASE']
);

const ctp = resolveBomMasterLeaves('LLNA-CTP-TW-MSM-MSM', bomMap);
assert.strictEqual(ctp.ok, true);
assert.deepStrictEqual(ctp.components, {
  'DS-TWIN': 1,
  'LLNA-CB-TW-MSM-CV': 2,
  'LLNA-CB-TW-FRM': 1
});
assert.ok(ctp.provenance.some(row => row.bomSku === 'LLNA-CB-TW-MSM-SET' && row.alias));

const emma = resolveBomMasterLeaves('EMMA-NOAH-4S', bomMap);
assert.strictEqual(emma.ok, true);
assert.deepStrictEqual(emma.components, {
  'NOAH-DC-WHT-ECO': 2,
  'EMMA-DT180-OAK-ECO': 1
});

const missing = resolveBomMasterLeaves('LIFELY-SOFA-99S-UNKNOWN', bomMap);
assert.strictEqual(missing.ok, false);
assert.strictEqual(missing.reason, 'bom_master_missing');
assert.deepStrictEqual(missing.components, {});
assert.deepStrictEqual(
  bomMasterComponentsForPanel('lifely-sofa', 'LIFELY-SOFA-99S-UNKNOWN', bomMap),
  [],
  'known parent families must fail closed when BOM Master is missing'
);
assert.strictEqual(
  bomMasterComponentsForPanel('rdnt', 'UNRELATED-SKU', bomMap),
  null,
  'unrelated SKUs must remain outside BOM parent routing'
);

console.log('BOM Master demand resolver tests passed');
