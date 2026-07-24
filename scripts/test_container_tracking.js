#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  normalizeContainerNumber,
  isValidContainerNumber,
  selectLecangsRecords,
  lecangsSignature,
  normalizeFindTeu,
  normalizeLecangs,
  buildContainerJourney
} = require('../lib/container-tracking');

assert.strictEqual(normalizeContainerNumber('OOCU8815295 / EVER AIM'), 'OOCU8815295');
assert.strictEqual(isValidContainerNumber('OOCU8815295'), true);
assert.strictEqual(isValidContainerNumber('NO-CONTAINER'), false);
const currentLecangsRows = [
  { asnNo: 'ASN-ONE', poNo: 'PO-US14-4', erpNo: null, containerNo: 'HMMU4115585' },
  { asnNo: 'ASN-TWO', poNo: 'PO-US14-4-B', erpNo: null, containerNo: 'HMMU4115585' },
  { asnNo: 'ASN-OTHER', poNo: 'PO-US16-1', erpNo: null, containerNo: 'TLLU1234567' }
];
assert.deepStrictEqual(
  selectLecangsRecords(currentLecangsRows, 'PO-US14-4', 'HMMU4115585').map(row => row.asnNo),
  ['ASN-ONE'],
  'Exact PO and container matching must not pull an ASN from another reused-container journey'
);
assert.deepStrictEqual(
  selectLecangsRecords(currentLecangsRows, 'PO-US14-4', '').map(row => row.asnNo),
  ['ASN-ONE'],
  'PO matching must use poNo when erpNo is empty'
);
assert.strictEqual(
  lecangsSignature(
    'test-access',
    'test-secret',
    { pageNum: 1, pageSize: 200, erpNoList: ['PO-1'] },
    '1700000000000'
  ),
  '6d5fce0160eb856ac8c376d6f0ab78e70c8836cface4743fda9e78961d819b4c',
  'Lecangs signs sorted key=value pairs joined by ampersands, then appends the secret'
);

const findTeuPayload = {
  success: true,
  data: {
    scac: 'OOLU',
    container: { number: 'OOCU8815295', type: "40'HQ", completed: false },
    pol: {
      terminal: 'Yantian International',
      port: 'Yantian',
      country: 'China',
      iso_code: 'CNYTN',
      etd_date: '2026-06-12'
    },
    pod: {
      terminal: 'Trinity',
      port: 'Felixstowe',
      country: 'United Kingdom',
      iso_code: 'GBFXT',
      eta_date: '2026-07-17'
    },
    events: [
      {
        event_date: '2026-06-12',
        location: { terminal: 'Yantian International', port: 'Yantian', country: 'China', iso_code: 'CNYTN' },
        action: { action_name: 'Departed by' },
        mode: { transport_mode: 'Vessel', vessel: { vessel_name: 'EVER AIM' } },
        event_type: 'actual'
      },
      {
        event_date: '2026-07-17',
        location: { terminal: 'Trinity', port: 'Felixstowe', country: 'United Kingdom', iso_code: 'GBFXT' },
        action: { action_name: 'Arrived by' },
        mode: { transport_mode: 'Vessel', vessel: { vessel_name: 'EVER AIM' } },
        event_type: 'actual'
      },
      {
        event_date: '2026-07-19',
        location: { terminal: 'Trinity', port: 'Felixstowe', country: 'United Kingdom', iso_code: 'GBFXT' },
        action: { action_name: 'Gate out full by' },
        mode: { transport_mode: 'Truck', vessel: { vessel_name: '' } },
        event_type: 'actual'
      }
    ]
  }
};

const normalizedFindTeu = normalizeFindTeu(findTeuPayload);
assert.strictEqual(normalizedFindTeu.polDeparture.type, 'actual');
assert.strictEqual(normalizedFindTeu.polDeparture.timestamp, '2026-06-12');
assert.strictEqual(normalizedFindTeu.podArrival.type, 'actual');
assert.strictEqual(normalizedFindTeu.podArrival.timestamp, '2026-07-17');
assert.strictEqual(normalizedFindTeu.gateOut.timestamp, '2026-07-19');

const sailingJourney = buildContainerJourney({
  containerNumber: 'OOCU8815295',
  poReference: 'PO-UK006',
  findTeuPayload: {
    data: {
      container: { number: 'OOCU8815295', type: "40'HQ" },
      pol: findTeuPayload.data.pol,
      pod: findTeuPayload.data.pod,
      events: [findTeuPayload.data.events[0]]
    }
  },
  lecangsPayload: {},
  sourceState: { findteu: 'live', lecangs: 'no_data' }
});
assert.strictEqual(sailingJourney.timeline[0].label, 'Port departure');
assert.strictEqual(sailingJourney.timeline[0].state, 'complete');
assert.strictEqual(sailingJourney.timeline[1].state, 'expected');
assert.strictEqual(sailingJourney.currentStatus, 'Destination port arrival');

const partialLecangsPayload = {
  success: true,
  data: [
    {
      asnNo: 'ASN-ONE',
      erpNo: 'PO-UK006',
      containerNo: 'OOCU8815295',
      deliveryWarehouse: 'UK01',
      status: 101205,
      requestApptDate: '2026-07-20 09:00:00',
      truckerDeliveryDate: '2026-07-20 09:12:00',
      receives: [
        { picType: '1', receivingDate: '2026-07-20 09:20:00' },
        { picType: '2', receivingDate: '2026-07-20 11:45:00' }
      ]
    },
    {
      asnNo: 'ASN-TWO',
      erpNo: 'PO-UK006',
      containerNo: 'OOCU8815295',
      deliveryWarehouse: 'UK01',
      status: 101204,
      requestApptDate: '2026-07-20 09:00:00',
      truckerDeliveryDate: '2026-07-20 09:12:00',
      receives: [{ picType: '1', receivingDate: '2026-07-20 09:20:00' }]
    }
  ]
};

const partial = normalizeLecangs(partialLecangsPayload, 'OOCU8815295', 'PO-UK006');
assert.strictEqual(partial.linkedAsnCount, 2);
assert.strictEqual(partial.handover.complete, true);
assert.strictEqual(partial.unloaded.complete, false, 'Every active ASN must reach unloaded');

const partialJourney = buildContainerJourney({
  containerNumber: 'OOCU8815295',
  poReference: 'PO-UK006',
  findTeuPayload,
  lecangsPayload: partialLecangsPayload,
  sourceState: { findteu: 'live', lecangs: 'live' }
});
assert.strictEqual(partialJourney.complete, false);
assert.strictEqual(partialJourney.currentStatus, 'Handover and unloading');
assert.strictEqual(partialJourney.timeline[0].label, 'Port departure');
assert.strictEqual(partialJourney.timeline[0].state, 'complete');
assert.strictEqual(partialJourney.timeline[1].label, 'Destination port arrival');
assert.strictEqual(partialJourney.timeline.at(-1).state, 'pending');

partialLecangsPayload.data[1].status = 101205;
partialLecangsPayload.data[1].receives.push({ picType: '2', receivingDate: '2026-07-20 12:10:00' });
const completeJourney = buildContainerJourney({
  containerNumber: 'OOCU8815295',
  poReference: 'PO-UK006',
  findTeuPayload,
  lecangsPayload: partialLecangsPayload,
  sourceState: { findteu: 'live', lecangs: 'live' }
});
assert.strictEqual(completeJourney.complete, true);
assert.strictEqual(completeJourney.currentStatus, 'Unloading complete');
assert.strictEqual(completeJourney.progressPct, 100);
assert.strictEqual(completeJourney.timeline.at(-1).timestamp, '2026-07-20 12:10:00');

const reusedContainerJourney = buildContainerJourney({
  containerNumber: 'OOCU8815295',
  poReference: 'PO-UK006',
  findTeuPayload: {
    data: {
      container: { number: 'OOCU8815295', type: "40'HQ" },
      pod: { port: 'Felixstowe', eta_date: '2026-08-29' },
      events: []
    }
  },
  lecangsPayload: partialLecangsPayload,
  sourceState: { findteu: 'live', lecangs: 'live' }
});
assert.strictEqual(reusedContainerJourney.findTeuVoyageMismatch, true);
assert.strictEqual(reusedContainerJourney.completedVoyageArchived, true);
assert.strictEqual(reusedContainerJourney.timeline[0].state, 'archived');
assert.strictEqual(reusedContainerJourney.timeline[1].state, 'archived');
assert.strictEqual(reusedContainerJourney.timeline[2].state, 'archived');
assert.deepStrictEqual(reusedContainerJourney.pol, {});
assert.deepStrictEqual(reusedContainerJourney.pod, {});
assert.strictEqual(reusedContainerJourney.complete, true);
assert.deepStrictEqual(reusedContainerJourney.journeyLock, {
  poReference: 'PO-UK006',
  containerNumber: 'OOCU8815295',
  asnNumbers: ['ASN-ONE', 'ASN-TWO']
});

const unavailableJourney = buildContainerJourney({
  containerNumber: 'OOCU8815295',
  poReference: 'PO-UK006',
  findTeuPayload: {},
  lecangsPayload: {},
  sourceState: { findteu: 'not_configured', lecangs: 'not_configured' }
});
assert.strictEqual(unavailableJourney.timeline[0].state, 'unavailable');
assert.strictEqual(unavailableJourney.timeline.at(-1).state, 'unavailable');

console.log('Container tracking tests passed');
