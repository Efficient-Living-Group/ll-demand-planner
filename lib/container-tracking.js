'use strict';

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

function normalizeContainerNumber(value) {
  const match = String(value || '').toUpperCase().match(/\b[A-Z]{4}\d{6,7}\b/);
  return match ? match[0] : '';
}

function isValidContainerNumber(value) {
  return CONTAINER_RE.test(normalizeContainerNumber(value));
}

function compact(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
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

  const podIso = compact(pod.iso_code);
  const podPort = compact(pod.port);
  const atPod = event => {
    if (podIso && compact(event.isoCode) === podIso) return true;
    return !!(podPort && compact(event.location).includes(podPort));
  };
  const podEvents = events.filter(atPod);
  const podArrival = podEvents.find(event => /arriv|discharg/i.test(event.label))
    || podEvents.find(event => event.type === 'actual')
    || podEvents[0]
    || null;
  const gateOut = podEvents.find(event => /gate out|departed.*truck|left.*yard|delivered/i.test(event.label)) || null;
  const discharge = podEvents.find(event => /discharg|unload(ed)? from|available/i.test(event.label)) || null;

  return {
    available: !!(data.container || pod.port || events.length),
    error: payload?.error || data.error || null,
    container: data.container || {},
    pod: {
      port: pod.port || '',
      terminal: pod.terminal || '',
      country: pod.country || '',
      isoCode: pod.iso_code || '',
      eta: pod.eta_date || null
    },
    pol: data.pol || {},
    destination: data.destination || {},
    podArrival,
    discharge,
    gateOut,
    events: podEvents
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
  const container = compact(containerNumber);
  const po = compact(poReference);
  const rows = asRows(payload);
  const exactContainer = rows.filter(row => compact(row.containerNo) === container);
  const poMatches = rows.filter(row => {
    const values = [row.poNo, row.erpNo].map(compact);
    return po && values.includes(po);
  });
  const records = exactContainer.length ? exactContainer : poMatches;
  const activeRecords = records.filter(record => ![101210, 101213].includes(Number(record.status)));
  const scoped = activeRecords.length ? activeRecords : records;
  const statusCodes = scoped.map(record => Number(record.status || 0)).filter(Boolean);
  const conservativeStatus = statusCodes.length ? Math.min(...statusCodes) : null;

  return {
    available: records.length > 0,
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

function milestone(id, label, source, state, timestamp, detail) {
  return { id, label, source, state, timestamp: timestamp || null, detail: detail || '' };
}

function buildContainerJourney({ containerNumber, poReference, findTeuPayload, lecangsPayload, sourceState = {} }) {
  const container = normalizeContainerNumber(containerNumber);
  const findTeu = normalizeFindTeu(findTeuPayload);
  const lecangs = normalizeLecangs(lecangsPayload, container, poReference);
  const findTeuUnavailable = ['error', 'not_configured'].includes(sourceState.findteu);
  const lecangsUnavailable = ['error', 'not_configured'].includes(sourceState.lecangs);
  const podActual = findTeu.podArrival?.type === 'actual';
  const podTimestamp = findTeu.podArrival?.timestamp || findTeu.pod.eta || null;
  const podPlace = [findTeu.pod.terminal, findTeu.pod.port, findTeu.pod.country].filter(Boolean).join(' · ');
  const asnDetail = lecangs.linkedAsnCount
    ? `${lecangs.linkedAsnCount} linked ASN${lecangs.linkedAsnCount === 1 ? '' : 's'}${lecangs.warehouses.length ? ` · ${lecangs.warehouses.join(', ')}` : ''}`
    : 'No linked Lecangs ASN found';

  const timeline = [
    milestone(
      'pod-arrival',
      'Port of discharge',
      'FindTEU',
      podActual ? 'complete' : (podTimestamp ? 'expected' : (findTeuUnavailable ? 'unavailable' : 'pending')),
      podTimestamp,
      podPlace || 'POD not supplied by carrier'
    ),
    milestone(
      'terminal-release',
      'Terminal release / gate out',
      'FindTEU',
      findTeu.gateOut?.type === 'actual' ? 'complete' : (findTeu.discharge?.type === 'actual' ? 'current' : (findTeuUnavailable ? 'unavailable' : 'pending')),
      findTeu.gateOut?.timestamp || findTeu.discharge?.timestamp || null,
      findTeu.gateOut?.label || findTeu.discharge?.label || 'Carrier-dependent milestone'
    ),
    milestone(
      'appointment',
      'Warehouse appointment',
      'Lecangs',
      lecangs.appointment.complete ? 'complete' : (lecangs.available ? 'pending' : (lecangsUnavailable ? 'unavailable' : 'pending')),
      lecangs.appointment.timestamp,
      asnDetail
    ),
    milestone(
      'warehouse-arrival',
      'Arrived at warehouse',
      'Lecangs',
      lecangs.warehouseArrival.complete ? 'complete' : (lecangs.appointment.complete ? 'current' : (lecangsUnavailable ? 'unavailable' : 'pending')),
      lecangs.warehouseArrival.timestamp,
      asnDetail
    ),
    milestone(
      'handover',
      'Handover and unloading',
      'Lecangs',
      lecangs.handover.complete ? (lecangs.unloaded.complete ? 'complete' : 'current') : (lecangsUnavailable ? 'unavailable' : 'pending'),
      lecangs.handover.timestamp,
      lecangs.handover.complete && !lecangs.unloaded.complete ? 'Unloading is in progress or awaiting confirmation' : asnDetail
    ),
    milestone(
      'unloaded',
      'Unloading complete',
      'Lecangs',
      lecangs.unloaded.complete ? 'complete' : (lecangsUnavailable ? 'unavailable' : 'pending'),
      lecangs.unloaded.timestamp,
      lecangs.unloaded.complete ? `All ${lecangs.activeRecords.length} active linked ASN${lecangs.activeRecords.length === 1 ? '' : 's'} reached unloaded` : 'Requires every active linked ASN to reach unloaded'
    )
  ];

  const completeCount = timeline.filter(item => item.state === 'complete').length;
  const explicitCurrent = timeline.find(item => item.state === 'current');
  const latestComplete = [...timeline].reverse().find(item => item.state === 'complete');
  const nextExpected = timeline.find(item => item.state === 'expected');
  const current = lecangs.unloaded.complete
    ? 'Unloading complete'
    : (explicitCurrent?.label || latestComplete?.label || nextExpected?.label || 'Tracking active');

  return {
    containerNumber: container,
    poReference: poReference || '',
    currentStatus: current,
    complete: lecangs.unloaded.complete,
    progressPct: lecangs.unloaded.complete ? 100 : Math.round((completeCount / timeline.length) * 100),
    pod: findTeu.pod,
    containerType: findTeu.container?.type || '',
    carrierScac: findTeuPayload?.data?.scac || findTeuPayload?.scac || '',
    lecangs,
    timeline
  };
}

module.exports = {
  LECANG_STATUS,
  normalizeContainerNumber,
  isValidContainerNumber,
  normalizeFindTeu,
  normalizeLecangs,
  buildContainerJourney
};
