#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  normalizeContainerNumber,
  isValidContainerNumber,
  normalizeFindTeu,
  normalizeLecangs,
  buildContainerJourney
} = require('../lib/container-tracking');

assert.strictEqual(normalizeContainerNumber('OOCU8815295 / EVER AIM'), 'OOCU8815295');
assert.strictEqual(isValidContainerNumber('OOCU8815295'), true);
assert.strictEqual(isValidContainerNumber('NO-CONTAINER'), false);

const findTeuPayload = {
  success: true,
  data: {
    scac: 'OOLU',
    container: { number: 'OOCU8815295', type: "40'HQ", completed: false },
    pod: {
      terminal: 'Trinity',
      port: 'Felixstowe',
      country: 'United Kingdom',
      iso_code: 'GBFXT',
      eta_date: '2026-07-17'
    },
    events: [
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
assert.strictEqual(normalizedFindTeu.podArrival.type, 'actual');
assert.strictEqual(normalizedFindTeu.podArrival.timestamp, '2026-07-17');
assert.strictEqual(normalizedFindTeu.gateOut.timestamp, '2026-07-19');

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
