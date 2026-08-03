'use strict';

const crypto = require('crypto');

const CONTAINER_RE = /^[A-Z]{4}\d{6,7}$/;

const LECANG_STATUS = {
  101201: 'In transit',
  101202: 'Delivery appointment scheduled',
  101203: 'Arrived at warehouse',
  101204: 'Handover',
  101205: 'Unloaded',
  101206: 'Receiving',
  101207: 'Receiving complete',
  101208: 'Empty pickup notified',
  101209: 'Complete',
  101210: 'Cancelled',
  101212: 'After-sales confirmation',
  101213: 'After-sales rejected'
};

const WAREHOUSE_SOURCES = {
  'UNITED STATES': {
    key: 'lecangs_us',
    name: 'Lecangs US',
    market: 'United States',
    connected: true,
    recordLabel: 'ASN'
  },
  CANADA: {
    key: 'lecangs_ca',
    name: 'Lecangs Canada',
    market: 'Canada',
    connected: true,
    recordLabel: 'ASN'
  },
  'UNITED KINGDOM': {
    key: 'cirro',
    name: 'Cirro',
    market: 'United Kingdom',
    connected: true,
    recordLabel: 'inbound'
  },
  AUSTRALIA: {
    key: 'capital_logistics',
    name: 'Capital Logistics',
    market: 'Australia',
    connected: true,
    recordLabel: 'warehouse record'
  },
  'NEW ZEALAND': {
    key: 'pacificomm',
    name: 'Pacificomm',
    market: 'New Zealand',
    connected: true,
    recordLabel: 'inbound'
  }
};

const COUNTRY_ALIASES = {
  AU: 'Australia',
  AUS: 'Australia',
  AUSTRALIA: 'Australia',
  CA: 'Canada',
  CAN: 'Canada',
  CANADA: 'Canada',
  GB: 'United Kingdom',
  GBR: 'United Kingdom',
  UK: 'United Kingdom',
  ENGLAND: 'United Kingdom',
  'UNITED KINGDOM': 'United Kingdom',
  NZ: 'New Zealand',
  NZL: 'New Zealand',
  'NEW ZEALAND': 'New Zealand',
  SG: 'Singapore',
  SGP: 'Singapore',
  SINGAPORE: 'Singapore',
  US: 'United States',
  USA: 'United States',
  'UNITED STATES': 'United States',
  'UNITED STATES OF AMERICA': 'United States'
};

const BRANCH_DESTINATIONS = {
  3: 'Australia',
  60976: 'Australia',
  48391: 'New Zealand',
  68865: 'New Zealand',
  60701: 'United States',
  63764: 'United States',
  61831: 'Canada',
  62444: 'United Kingdom',
  57843: 'Singapore'
};

const PORT_DESTINATIONS = {
  AUCKLAND: 'New Zealand',
  BRISBANE: 'Australia',
  FELIXSTOWE: 'United Kingdom',
  'LONG BEACH': 'United States',
  'LOS ANGELES': 'United States',
  MELBOURNE: 'Australia',
  'NEW YORK': 'United States',
  SAVANNAH: 'United States',
  SINGAPORE: 'Singapore',
  SOUTHAMPTON: 'United Kingdom',
  SYDNEY: 'Australia',
  TAURANGA: 'New Zealand',
  TORONTO: 'Canada',
  VANCOUVER: 'Canada'
};

const CITY_DESTINATIONS = {
  ALTONA: 'Australia',
  DERRIMUT: 'Australia',
  FOOTSCRAY: 'Australia',
  LAVERTON: 'Australia',
  'LAVERTON NORTH': 'Australia',
  TRUGANINA: 'Australia'
};

function normalizeContainerNumber(value) {
  const match = String(value || '').toUpperCase().match(/\b[A-Z]{4}\d{6,7}\b/);
  return match ? match[0] : '';
}

function isValidContainerNumber(value) {
  return CONTAINER_RE.test(normalizeContainerNumber(value));
}

function warehouseSourceForDestination(destination) {
  const value = typeof destination === 'object'
    ? (destination?.country || destination?.name || '')
    : destination;
  const normalized = String(value || '').trim().toUpperCase();
  const source = WAREHOUSE_SOURCES[normalized];
  if (source) return { ...source };
  return {
    key: 'unsupported',
    name: 'Warehouse provider',
    market: String(value || '').trim() || 'Unknown',
    connected: false,
    recordLabel: 'warehouse record'
  };
}

function compact(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function canonicalDestination(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return COUNTRY_ALIASES[normalized] || '';
}

function destinationFromReference(value) {
  const reference = String(value || '').trim().toUpperCase();
  if (/^PO-(AU|LF)/.test(reference)) return 'Australia';
  if (/^PO-(US|10)/.test(reference)) return 'United States';
  if (/^PO-CA/.test(reference)) return 'Canada';
  if (/^PO-UK/.test(reference)) return 'United Kingdom';
  if (/^PO-NZ/.test(reference)) return 'New Zealand';
  if (/^PO-SG/.test(reference)) return 'Singapore';
  return '';
}

function destinationFromSkuEvidence(items) {
  const skus = Object.keys(items || {}).map(value => String(value || '').toUpperCase());
  const destinations = new Set();
  if (skus.some(sku => sku.startsWith('LLSG'))) destinations.add('Singapore');
  if (skus.some(sku => sku.startsWith('LLUK') || /-(UK)(?:-|$)/.test(sku))) destinations.add('United Kingdom');
  return destinations.size === 1 ? [...destinations][0] : '';
}

function resolveTrackingDestination(po = {}) {
  const evidence = [];
  const add = (source, destination) => {
    if (destination) evidence.push({ source, destination });
  };
  add('deliveryCountry', canonicalDestination(po.deliveryCountry));
  add('poReference', destinationFromReference(po.reference));
  add('branch', BRANCH_DESTINATIONS[Number(po.branchId || 0)] || '');
  add('port', PORT_DESTINATIONS[String(po.port || '').trim().toUpperCase()] || '');
  add('deliveryCity', CITY_DESTINATIONS[String(po.deliveryCity || '').trim().toUpperCase()] || '');
  add('sku', destinationFromSkuEvidence(po.items));

  const strongSources = new Set(['deliveryCountry', 'poReference', 'port']);
  const strongDestinations = [...new Set(
    evidence.filter(row => strongSources.has(row.source)).map(row => row.destination)
  )];
  if (strongDestinations.length === 1) {
    const destination = strongDestinations[0];
    const ignoredConflicts = [...new Set(
      evidence.filter(row => !strongSources.has(row.source) && row.destination !== destination)
        .map(row => row.destination)
    )];
    return { status: 'resolved', destination, evidence, conflicts: [], ignoredConflicts };
  }
  if (strongDestinations.length > 1) {
    return { status: 'conflict', destination: '', evidence, conflicts: strongDestinations, ignoredConflicts: [] };
  }
  const weakDestinations = [...new Set(evidence.map(row => row.destination))];
  if (weakDestinations.length === 1) {
    return { status: 'resolved', destination: weakDestinations[0], evidence, conflicts: [], ignoredConflicts: [] };
  }
  if (weakDestinations.length > 1) {
    return { status: 'conflict', destination: '', evidence, conflicts: weakDestinations, ignoredConflicts: [] };
  }
  return { status: 'unknown', destination: '', evidence, conflicts: [], ignoredConflicts: [] };
}

function selectLecangsRecords(rows, poReference, containerNumber) {
  const records = Array.isArray(rows) ? rows : [];
  const container = compact(containerNumber);
  const po = compact(poReference);
  if (!po || !container) return [];
  return records.filter(record => (
    !!compact(record?.asnNo)
    && [record?.poNo, record?.erpNo].some(value => compact(value) === po)
    && compact(record?.containerNo) === container
  ));
}

function lecangsSignature(accessKey, secretKey, body, timestamp) {
  const params = { accessKey, timestamp, ...body };
  const parts = Object.keys(params).sort().map(key => {
    const value = params[key];
    let encoded = value ?? '';
    if (typeof value === 'boolean') encoded = value ? 'true' : 'false';
    else if (Array.isArray(value) || (value && typeof value === 'object')) encoded = JSON.stringify(value);
    return `${key}=${encoded}`;
  });
  return crypto.createHash('sha256')
    .update(`${parts.join('&')}${secretKey}`)
    .digest('hex');
}

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.records)) return payload.data.records;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function normalizeFindTeu(payload) {
  const data = payload?.data && !Array.isArray(payload.data) ? payload.data : (payload || {});
  const pol = data.pol || {};
  const pod = data.pod || {};
  const events = Array.isArray(data.events) ? data.events.map((event, index) => {
    const location = event.location || {};
    const action = event.action || {};
    const mode = event.mode || {};
    return {
      id: `findteu-${index}`,
      timestamp: event.event_date || event.date || null,
      label: action.action_name || event.action_name || 'Carrier milestone',
      type: String(event.event_type || '').toLowerCase() === 'actual' ? 'actual' : 'expected',
      location: [location.terminal, location.port, location.country].filter(Boolean).join(' · '),
      isoCode: location.iso_code || '',
      transportMode: mode.transport_mode || '',
      vessel: mode.vessel?.vessel_name || ''
    };
  }) : [];

  const polIso = compact(pol.iso_code);
  const polPort = compact(pol.port);
  const atPol = event => {
    if (polIso && compact(event.isoCode) === polIso) return true;
    return !!(polPort && compact(event.location).includes(polPort));
  };
  const podIso = compact(pod.iso_code);
  const podPort = compact(pod.port);
  const atPod = event => {
    if (podIso && compact(event.isoCode) === podIso) return true;
    return !!(podPort && compact(event.location).includes(podPort));
  };
  const polEvents = events.filter(atPol);
  const podEvents = events.filter(atPod);
  const polDeparture = polEvents.find(event => event.type === 'actual' && /depart/i.test(event.label))
    || polEvents.find(event => /depart/i.test(event.label))
    || null;
  const podArrival = podEvents.find(event => /arriv|discharg/i.test(event.label))
    || podEvents.find(event => event.type === 'actual')
    || podEvents[0]
    || null;
  const gateOut = podEvents.find(event => /gate out|departed.*truck|left.*yard|delivered/i.test(event.label)) || null;
  const discharge = podEvents.find(event => /discharg|unload(ed)? from|available/i.test(event.label)) || null;

  return {
    available: !!(data.container || pol.port || pod.port || events.length),
    error: payload?.error || data.error || null,
    container: data.container || {},
    pol: {
      port: pol.port || '',
      terminal: pol.terminal || '',
      country: pol.country || '',
      isoCode: pol.iso_code || '',
      etd: pol.etd_date || null
    },
    pod: {
      port: pod.port || '',
      terminal: pod.terminal || '',
      country: pod.country || '',
      isoCode: pod.iso_code || '',
      eta: pod.eta_date || null
    },
    destination: data.destination || {},
    polDeparture,
    podArrival,
    discharge,
    gateOut,
    events: [...polEvents, ...podEvents]
  };
}

function isoCountryFromLocationCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  return raw.length >= 2 ? canonicalDestination(raw.slice(0, 2)) : '';
}

function validateFindTeuDestination(findTeu, expectedDestination) {
  const expected = canonicalDestination(expectedDestination);
  if (!expected) {
    return {
      status: 'unverified',
      expected: '',
      actual: '',
      reason: 'The PO destination could not be resolved safely.'
    };
  }
  const rawCountry = String(findTeu?.pod?.country || '').trim();
  const rawIsoCountry = String(findTeu?.pod?.isoCode || '').trim().toUpperCase().slice(0, 2);
  const countrySignals = [
    rawCountry
      ? (canonicalDestination(rawCountry) || rawCountry)
      : '',
    rawIsoCountry
      ? (isoCountryFromLocationCode(rawIsoCountry) || rawIsoCountry)
      : ''
  ].filter(Boolean);
  const countries = [...new Set(countrySignals)];
  if (countries.length) {
    if (countries.every(country => country === expected)) {
      return { status: 'verified', expected, actual: expected, reason: 'Destination country matched.' };
    }
    return {
      status: 'mismatch',
      expected,
      actual: countries.join(' / '),
      reason: `Carrier destination ${countries.join(' / ')} does not match PO destination ${expected}.`
    };
  }
  const portDestination = PORT_DESTINATIONS[String(findTeu?.pod?.port || '').trim().toUpperCase()] || '';
  if (portDestination) {
    if (portDestination === expected) {
      return { status: 'verified', expected, actual: portDestination, reason: 'Trusted destination port matched.' };
    }
    return {
      status: 'mismatch',
      expected,
      actual: portDestination,
      reason: `Carrier destination port maps to ${portDestination}, not ${expected}.`
    };
  }
  return {
    status: 'unverified',
    expected,
    actual: '',
    reason: 'FindTEU did not provide enough destination evidence to verify this voyage.'
  };
}

function receiveByType(record, type) {
  return (Array.isArray(record?.receives) ? record.receives : [])
    .find(row => Number(row?.picType) === Number(type)) || null;
}

function recordTimestamp(record, fields, receiveType = null) {
  for (const field of fields) if (record?.[field]) return record[field];
  const receive = receiveType === null ? null : receiveByType(record, receiveType);
  return receive?.receivingDate || null;
}

function latestTimestamp(records, fields, receiveType = null) {
  const values = records.map(record => recordTimestamp(record, fields, receiveType)).filter(Boolean);
  return values.sort((a, b) => String(a).localeCompare(String(b))).at(-1) || null;
}

function hasReached(record, status, fields = [], receiveType = null) {
  const code = Number(record?.status || 0);
  if (code >= status && code <= 101209) return true;
  return !!recordTimestamp(record, fields, receiveType);
}

function allReached(records, status, fields = [], receiveType = null) {
  return records.length > 0 && records.every(record => hasReached(record, status, fields, receiveType));
}

function normalizeLecangs(payload, containerNumber, poReference) {
  const rows = asRows(payload);
  const records = selectLecangsRecords(rows, poReference, containerNumber);
  const activeRecords = records.filter(record => ![101210, 101213].includes(Number(record.status)));
  const scoped = activeRecords.length ? activeRecords : records;
  const statusCodes = scoped.map(record => Number(record.status || 0)).filter(Boolean);
  const conservativeStatus = statusCodes.length ? Math.min(...statusCodes) : null;

  return {
    available: records.length > 0,
    recordLabel: 'ASN',
    records,
    activeRecords: scoped,
    linkedAsnCount: records.length,
    asnNumbers: records.map(record => record.asnNo).filter(Boolean),
    warehouses: [...new Set(records.map(record => record.deliveryWarehouse).filter(Boolean))],
    statusCode: conservativeStatus,
    statusLabel: LECANG_STATUS[conservativeStatus] || (conservativeStatus ? `Status ${conservativeStatus}` : ''),
    appointment: {
      complete: allReached(scoped, 101202, ['requestApptDate']),
      timestamp: latestTimestamp(scoped, ['requestApptDate'])
    },
    warehouseArrival: {
      complete: allReached(scoped, 101203, ['truckerDeliveryDate', 'landTime'], 0),
      timestamp: latestTimestamp(scoped, ['truckerDeliveryDate', 'landTime'], 0)
    },
    handover: {
      complete: allReached(scoped, 101204, [], 1),
      timestamp: latestTimestamp(scoped, [], 1)
    },
    unloaded: {
      complete: allReached(scoped, 101205, ['unloadTime'], 2),
      timestamp: latestTimestamp(scoped, ['unloadTime'], 2)
    }
  };
}

function normalizeCirro(payload, poReference, containerNumber) {
  const rows = asRows(payload);
  const po = compact(poReference);
  const container = compact(containerNumber);
  const records = po && container
    ? rows.filter(record => (
      !!compact(record?.receiving_code)
      && compact(record?.reference_no) === po
      && compact(record?.query_container || record?.container_number) === container
    ))
    : [];
  const activeRecords = records.filter(record => Number(record?.receiving_status) !== 0);
  const scoped = activeRecords.length ? activeRecords : records;
  const statusCodes = scoped.map(record => Number(record?.receiving_status)).filter(Number.isFinite);
  const conservativeStatus = statusCodes.length ? Math.min(...statusCodes) : null;
  const updateTimestamp = record => record?.update_at || record?.udpate_at || record?.create_at || null;
  const latestForStatus = minimumStatus => scoped
    .filter(record => Number(record?.receiving_status) >= minimumStatus)
    .map(updateTimestamp)
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)))
    .at(-1) || null;
  const allAtStatus = minimumStatus => scoped.length > 0
    && scoped.every(record => Number(record?.receiving_status) >= minimumStatus);
  const appointmentValues = scoped.map(record => record?.appointment_date || record?.eta_date).filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
  const actualArrivalValues = scoped.map(record => record?.arrival_date).filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
  const allHaveActualArrival = scoped.length > 0 && scoped.every(record => !!record?.arrival_date);
  const receivingCodes = records.map(record => record?.receiving_code).filter(Boolean);

  return {
    available: activeRecords.length > 0,
    recordLabel: 'inbound',
    records,
    activeRecords: scoped,
    linkedAsnCount: activeRecords.length,
    asnNumbers: receivingCodes,
    warehouses: [...new Set(records.map(record => record?.warehouse_code).filter(Boolean))],
    statusCode: conservativeStatus,
    statusLabel: {
      0: 'Discarded',
      1: 'Draft',
      5: 'Preparing and shipping',
      7: 'Warehouse processing',
      8: 'Stock-in complete'
    }[conservativeStatus] || (conservativeStatus === null ? '' : `Status ${conservativeStatus}`),
    appointment: {
      complete: false,
      timestamp: appointmentValues.at(-1) || null
    },
    warehouseArrival: {
      complete: allAtStatus(7),
      timestamp: allHaveActualArrival ? (actualArrivalValues.at(-1) || null) : null,
      evidenceTimestamp: allHaveActualArrival
        ? (actualArrivalValues.at(-1) || null)
        : latestForStatus(7)
    },
    handover: {
      complete: allAtStatus(8),
      current: allAtStatus(7) && !allAtStatus(8),
      timestamp: null,
      evidenceTimestamp: latestForStatus(7)
    },
    unloaded: {
      complete: allAtStatus(8),
      timestamp: null,
      evidenceTimestamp: latestForStatus(8)
    }
  };
}

function referenceTokens(value) {
  return String(value || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

function referenceContainsToken(reference, value) {
  const referenceParts = referenceTokens(reference);
  const valueParts = referenceTokens(value);
  if (!valueParts.length || valueParts.length > referenceParts.length) return false;
  for (let index = 0; index <= referenceParts.length - valueParts.length; index += 1) {
    if (valueParts.every((part, offset) => referenceParts[index + offset] === part)) return true;
  }
  return false;
}

function selectCartonCloudRecords(rows, poReference, containerNumber, providerReferences = []) {
  const records = Array.isArray(rows) ? rows : [];
  const container = normalizeContainerNumber(containerNumber);
  const trustedReferences = [poReference, ...providerReferences]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (!container || !trustedReferences.length) return [];
  return records.filter(record => {
    const providerReference = record?.reference || record?.references?.customer || '';
    return !!String(record?.id || '').trim()
      && referenceContainsToken(providerReference, container)
      && trustedReferences.some(value => referenceContainsToken(providerReference, value));
  });
}

function cartonCloudStatus(record) {
  return String(record?.status || '').trim().toUpperCase().replace(/[ -]+/g, '_');
}

function normalizeCartonCloud(payload, poReference, containerNumber, providerReferences = []) {
  const rows = asRows(payload);
  const records = selectCartonCloudRecords(rows, poReference, containerNumber, providerReferences);
  const activeRecords = records.filter(record => !['CANCELLED', 'DELETED', 'REJECTED'].includes(cartonCloudStatus(record)));
  const scoped = activeRecords.length ? activeRecords : records;
  const statuses = scoped.map(cartonCloudStatus);
  const allAt = accepted => scoped.length > 0 && statuses.every(status => accepted.includes(status));
  const received = allAt(['RECEIVED', 'VERIFIED', 'ALLOCATED']);
  const verified = allAt(['VERIFIED', 'ALLOCATED']);
  const latest = fields => scoped.map(record => {
    for (const field of fields) {
      const value = field.split('.').reduce((current, key) => current?.[key], record);
      if (value) return value;
    }
    return null;
  }).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b))).at(-1) || null;
  const ids = records.map(record => String(record?.id || '')).filter(Boolean);
  const statusLabel = statuses.length === 1 ? statuses[0].replace(/_/g, ' ').toLowerCase() : (statuses.length ? 'mixed status' : '');
  return {
    available: records.length > 0,
    recordLabel: 'inbound',
    records,
    activeRecords: scoped,
    linkedAsnCount: records.length,
    asnNumbers: ids,
    warehouses: [...new Set(records.map(record => record?.warehouse?.name || record?.warehouseName).filter(Boolean))],
    statusCode: statuses.length === 1 ? statuses[0] : null,
    statusLabel,
    appointment: { complete: false, timestamp: latest(['details.arrivalDate']) },
    warehouseArrival: { complete: received, timestamp: latest(['timestamps.received']) },
    handover: {
      complete: verified,
      current: received && !verified,
      timestamp: verified ? latest(['timestamps.verified', 'timestamps.allocated']) : null
    },
    unloaded: {
      complete: verified,
      timestamp: verified ? latest(['timestamps.verified', 'timestamps.allocated']) : null
    }
  };
}

function normalizeUnavailableWarehouse(warehouse) {
  return {
    available: false,
    recordLabel: warehouse?.recordLabel || 'warehouse record',
    records: [],
    activeRecords: [],
    linkedAsnCount: 0,
    asnNumbers: [],
    warehouses: [],
    statusCode: null,
    statusLabel: '',
    appointment: { complete: false, timestamp: null },
    warehouseArrival: { complete: false, timestamp: null },
    handover: { complete: false, current: false, timestamp: null },
    unloaded: { complete: false, timestamp: null }
  };
}

function normalizeWarehousePayload(payload, warehouse, containerNumber, poReference, providerReferences = []) {
  if (['lecangs_us', 'lecangs_ca'].includes(warehouse?.key)) {
    return normalizeLecangs(payload, containerNumber, poReference);
  }
  if (warehouse?.key === 'cirro') {
    return normalizeCirro(payload, poReference, containerNumber);
  }
  if (warehouse?.key === 'pacificomm') {
    return normalizeCartonCloud(payload, poReference, containerNumber, providerReferences);
  }
  return normalizeUnavailableWarehouse(warehouse);
}

function milestone(id, label, source, state, timestamp, detail) {
  return { id, label, source, state, timestamp: timestamp || null, detail: detail || '' };
}

function timelineTime(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function expectedMilestoneState(value, now, toleranceHours = 36) {
  const timestamp = timelineTime(value);
  const nowTime = timelineTime(now instanceof Date ? now.toISOString() : now);
  if (timestamp !== null && nowTime !== null && timestamp + (toleranceHours * 60 * 60 * 1000) < nowTime) {
    return 'overdue';
  }
  return 'expected';
}

function buildContainerJourney({
  containerNumber,
  poReference,
  findTeuPayload,
  lecangsPayload,
  warehousePayload,
  sourceState = {},
  warehouseSource = null,
  warehouseMessage = '',
  expectedDestination = '',
  providerReferences = [],
  journeyClosed = false,
  now = new Date()
}) {
  const container = normalizeContainerNumber(containerNumber);
  const findTeu = normalizeFindTeu(findTeuPayload);
  const warehouse = warehouseSource || {
    key: 'unsupported',
    name: 'Warehouse provider',
    market: 'Unknown',
    connected: false,
    recordLabel: 'warehouse record'
  };
  const normalizedWarehousePayload = warehousePayload === undefined ? lecangsPayload : warehousePayload;
  const isCirro = warehouse.key === 'cirro';
  const isPacificomm = warehouse.key === 'pacificomm';
  const isLecangs = ['lecangs_us', 'lecangs_ca'].includes(warehouse.key);
  const warehouseData = normalizeWarehousePayload(normalizedWarehousePayload, warehouse, container, poReference, providerReferences);
  const warehouseName = warehouse.name || 'Warehouse provider';
  const destinationValidation = validateFindTeuDestination(findTeu, expectedDestination || warehouse.market);
  const rawPodTimestamp = findTeu.podArrival?.timestamp || findTeu.pod.eta || null;
  const downstreamTimestamp = warehouseData.unloaded.timestamp
    || warehouseData.handover.timestamp
    || warehouseData.warehouseArrival.timestamp
    || null;
  const podTime = timelineTime(rawPodTimestamp);
  const downstreamTime = timelineTime(downstreamTimestamp);
  const chronologyMismatch = !!(
    podTime
    && downstreamTime
    && podTime > downstreamTime + (36 * 60 * 60 * 1000)
  );
  const destinationMismatch = findTeu.available && destinationValidation.status === 'mismatch';
  const destinationUnverified = findTeu.available && destinationValidation.status === 'unverified';
  const findTeuVoyageMismatch = chronologyMismatch || destinationMismatch;
  const carrierHistoryArchived = sourceState.findteu === 'archived';
  const completedVoyageArchived = warehouseData.unloaded.complete
    && (findTeuVoyageMismatch || carrierHistoryArchived || !findTeu.available);
  const findTeuMilestonesUsable = sourceState.findteu === 'live'
    && findTeu.available
    && destinationValidation.status === 'verified'
    && !findTeuVoyageMismatch;
  const findTeuUnavailable = !findTeuMilestonesUsable;
  const warehouseUnavailable = ['error', 'not_configured', 'not_connected', 'unsupported', 'permission_blocked', 'scope_limited'].includes(
    sourceState.warehouse || sourceState.lecangs
  );
  const polActual = findTeuMilestonesUsable && findTeu.polDeparture?.type === 'actual';
  const polTimestamp = findTeuMilestonesUsable ? (findTeu.polDeparture?.timestamp || findTeu.pol.etd || null) : null;
  const polPlace = !findTeuMilestonesUsable
    ? ''
    : [findTeu.pol.terminal, findTeu.pol.port, findTeu.pol.country].filter(Boolean).join(' · ');
  const podActual = findTeuMilestonesUsable && findTeu.podArrival?.type === 'actual';
  const podTimestamp = findTeuMilestonesUsable ? rawPodTimestamp : null;
  const podPlace = !findTeuMilestonesUsable
    ? ''
    : [findTeu.pod.terminal, findTeu.pod.port, findTeu.pod.country].filter(Boolean).join(' · ');
  const findTeuUnavailableDetail = completedVoyageArchived
    ? (findTeuVoyageMismatch
      ? 'Original voyage completed. This container number has since been reused.'
      : 'Original carrier history was not retained after warehouse completion.')
    : (carrierHistoryArchived
      ? 'This PO is already received in Cin7, so the reusable container number is not queried for a newer voyage.'
    : (destinationMismatch
      ? destinationValidation.reason
      : (destinationUnverified
        ? destinationValidation.reason
        : (chronologyMismatch
          ? 'Carrier data appears to belong to a different voyage for this reused container number.'
          : (sourceState.findteu === 'archived'
            ? 'Original carrier history was not retained after warehouse completion.'
            : 'Carrier milestones are not currently available.')))));
  const mismatchedMilestoneState = completedVoyageArchived ? 'archived' : 'unavailable';
  const carrierUnavailableState = (completedVoyageArchived || carrierHistoryArchived) ? 'archived' : 'unavailable';
  const recordLabel = warehouseData.recordLabel || warehouse.recordLabel || 'warehouse record';
  const linkedDetail = warehouseData.linkedAsnCount
    ? `${warehouseData.linkedAsnCount} linked ${recordLabel}${warehouseData.linkedAsnCount === 1 ? '' : 's'}${warehouseData.warehouses.length ? ` · ${warehouseData.warehouses.join(', ')}` : ''}`
    : (warehouseUnavailable
      ? (warehouseMessage || `${warehouseName} warehouse tracking is not connected yet.`)
      : `No linked ${warehouseName} ${recordLabel} found`);

  const timeline = [
    milestone(
      'pol-departure',
      'Port departure',
      'FindTEU',
      polActual ? 'complete' : (polTimestamp
        ? expectedMilestoneState(polTimestamp, now)
        : ((completedVoyageArchived || carrierHistoryArchived) ? 'archived' : (findTeuVoyageMismatch ? mismatchedMilestoneState : (findTeuUnavailable ? carrierUnavailableState : 'pending')))),
      polTimestamp,
      !findTeuMilestonesUsable ? findTeuUnavailableDetail : (polPlace || 'Departure port not supplied by carrier')
    ),
    milestone(
      'pod-arrival',
      'Destination port arrival',
      'FindTEU',
      podActual ? 'complete' : (podTimestamp
        ? expectedMilestoneState(podTimestamp, now)
        : ((completedVoyageArchived || carrierHistoryArchived) ? 'archived' : (findTeuVoyageMismatch ? mismatchedMilestoneState : (findTeuUnavailable ? carrierUnavailableState : 'pending')))),
      podTimestamp,
      !findTeuMilestonesUsable ? findTeuUnavailableDetail : (podPlace || 'Destination port not supplied by carrier')
    ),
    milestone(
      'terminal-release',
      'Terminal release / gate out',
      'FindTEU',
      findTeuMilestonesUsable && findTeu.gateOut?.type === 'actual'
        ? 'complete'
        : (findTeuMilestonesUsable && findTeu.discharge?.type === 'actual'
          ? 'current'
          : ((completedVoyageArchived || carrierHistoryArchived)
            ? 'archived'
            : (findTeuVoyageMismatch
              ? mismatchedMilestoneState
              : (findTeuUnavailable ? carrierUnavailableState : 'pending')))),
      findTeuMilestonesUsable ? (findTeu.gateOut?.timestamp || findTeu.discharge?.timestamp || null) : null,
      !findTeuMilestonesUsable ? findTeuUnavailableDetail : (findTeu.gateOut?.label || findTeu.discharge?.label || 'Carrier-dependent milestone')
    ),
    milestone(
      'appointment',
      'Warehouse appointment',
      warehouseName,
      warehouseData.appointment.complete ? 'complete' : (warehouseData.appointment.timestamp && warehouseData.available ? expectedMilestoneState(warehouseData.appointment.timestamp, now) : (warehouseData.available ? 'pending' : (warehouseUnavailable ? 'unavailable' : 'pending'))),
      warehouseData.appointment.timestamp,
      isCirro && warehouseData.appointment.timestamp
        ? (warehouseData.activeRecords.some(record => record?.appointment_date)
          ? `${linkedDetail}. Cirro reservation provides the warehouse appointment time; it is not an actual arrival.`
          : `${linkedDetail}. Cirro ETA is an expected appointment, not an actual warehouse event.`)
        : (isPacificomm && warehouseData.appointment.timestamp
          ? `${linkedDetail}. Pacificomm arrival date is expected, not an actual warehouse event.`
          : linkedDetail)
    ),
    milestone(
      'warehouse-arrival',
      'Arrived at warehouse',
      warehouseName,
      warehouseData.warehouseArrival.complete ? 'complete' : (warehouseData.appointment.complete ? 'current' : (warehouseUnavailable ? 'unavailable' : 'pending')),
      warehouseData.warehouseArrival.timestamp,
      isCirro && warehouseData.warehouseArrival.timestamp
        ? `${linkedDetail}. Cirro reservation provides the actual delivery time.`
        : (isCirro && warehouseData.warehouseArrival.complete
          ? `${linkedDetail}. Cirro confirms warehouse processing; exact arrival time is not provided.`
          : linkedDetail)
    ),
    milestone(
      'handover',
      'Handover and unloading',
      warehouseName,
      warehouseData.handover.complete ? 'complete' : (warehouseData.handover.current ? 'current' : (warehouseUnavailable ? 'unavailable' : 'pending')),
      warehouseData.handover.timestamp,
      warehouseData.handover.current
        ? `${warehouseName} reports warehouse receiving. Exact handover time is not provided.`
        : (warehouseData.handover.complete && !warehouseData.unloaded.complete ? 'Unloading is in progress or awaiting confirmation' : linkedDetail)
    ),
    milestone(
      'unloaded',
      'Unloading complete',
      warehouseName,
      warehouseData.unloaded.complete ? 'complete' : (warehouseUnavailable ? 'unavailable' : 'pending'),
      warehouseData.unloaded.timestamp,
      warehouseData.unloaded.complete
        ? (isCirro
          ? `Cirro confirms stock-in complete for all ${warehouseData.activeRecords.length} linked inbound${warehouseData.activeRecords.length === 1 ? '' : 's'}; exact unload time is not provided.`
          : (isPacificomm
            ? `Pacificomm confirms verified and allocated receipt for all ${warehouseData.activeRecords.length} linked inbound${warehouseData.activeRecords.length === 1 ? '' : 's'}.`
            : `All ${warehouseData.activeRecords.length} active linked ${recordLabel}${warehouseData.activeRecords.length === 1 ? '' : 's'} reached unloaded`))
        : linkedDetail
    )
  ];

  // Keep each provider's sequence monotonic without inventing event times.
  // If a later verified milestone exists, an earlier expected/missing milestone
  // becomes archived history rather than remaining pending or overdue.
  for (const [start, end] of [[0, 2], [3, 6]]) {
    let furthestVerified = -1;
    for (let index = start; index <= end; index += 1) {
      if (['complete', 'current'].includes(timeline[index].state)) furthestVerified = index;
    }
    for (let index = start; index < furthestVerified; index += 1) {
      if (!['pending', 'expected', 'overdue'].includes(timeline[index].state)) continue;
      timeline[index].state = 'archived';
      timeline[index].timestamp = null;
      timeline[index].detail = 'A later milestone is verified; the exact time for this earlier stage was not retained.';
    }
  }

  const completeCount = timeline.filter(item => item.state === 'complete').length;
  const explicitCurrent = timeline.findLast(item => item.state === 'current');
  const latestCompleteIndex = timeline.findLastIndex(item => item.state === 'complete');
  const latestComplete = latestCompleteIndex >= 0 ? timeline[latestCompleteIndex] : null;
  const nextAttention = timeline.find(
    (item, index) => ['expected', 'overdue'].includes(item.state) && index > latestCompleteIndex
  );
  const allUnavailable = timeline.every(item => ['unavailable', 'archived'].includes(item.state));
  const current = warehouseData.unloaded.complete
    ? 'Unloading complete'
    : (journeyClosed
      ? 'PO received · warehouse completion unverified'
      : (destinationMismatch
        ? 'Voyage mismatch · review required'
        : (destinationUnverified
          ? 'Voyage unverified · review required'
          : (explicitCurrent?.label
            || (nextAttention?.state === 'overdue' ? `${nextAttention.label} overdue` : nextAttention?.label)
            || latestComplete?.label
            || (allUnavailable ? 'Tracking unavailable' : 'Tracking active')))));

  return {
    containerNumber: container,
    poReference: poReference || '',
    currentStatus: current,
    complete: warehouseData.unloaded.complete,
    progressPct: warehouseData.unloaded.complete ? 100 : Math.round((completeCount / timeline.length) * 100),
    pol: findTeuMilestonesUsable ? findTeu.pol : {},
    pod: findTeuMilestonesUsable ? findTeu.pod : {},
    containerType: findTeuMilestonesUsable ? (findTeu.container?.type || '') : '',
    carrierScac: findTeuMilestonesUsable ? (findTeuPayload?.data?.scac || findTeuPayload?.scac || '') : '',
    findTeuVoyageMismatch,
    findTeuDestinationMismatch: destinationMismatch,
    findTeuDestinationUnverified: destinationUnverified,
    findTeuIdentity: destinationValidation,
    carrierHistoryArchived,
    completedVoyageArchived,
    journeyClosedWithoutWarehouseConfirmation: !!journeyClosed && !warehouseData.unloaded.complete,
    journeyLock: {
      poReference: poReference || '',
      containerNumber: container,
      asnNumbers: isLecangs ? [...warehouseData.asnNumbers].sort() : [],
      warehouseReferences: [...warehouseData.asnNumbers].sort()
    },
    warehouse: {
      ...warehouseData,
      providerKey: warehouse.key,
      providerName: warehouseName,
      market: warehouse.market
    },
    ...(isCirro ? { cirro: warehouseData } : (isLecangs ? { lecangs: warehouseData } : {})),
    timeline
  };
}

module.exports = {
  LECANG_STATUS,
  normalizeContainerNumber,
  isValidContainerNumber,
  canonicalDestination,
  destinationFromReference,
  resolveTrackingDestination,
  warehouseSourceForDestination,
  selectLecangsRecords,
  lecangsSignature,
  normalizeFindTeu,
  validateFindTeuDestination,
  normalizeLecangs,
  normalizeCirro,
  selectCartonCloudRecords,
  normalizeCartonCloud,
  normalizeWarehousePayload,
  buildContainerJourney
};
