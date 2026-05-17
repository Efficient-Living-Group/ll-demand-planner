const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const WebSocket = require('ws');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CONFIG =====
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'lifely2026';
const MASTERHUB_URL = (process.env.MASTERHUB_URL || 'https://lifely-report.onrender.com').replace(/\/$/, '');
const MASTERHUB_SSO_SECRET = process.env.MASTERHUB_SSO_SECRET || '';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const CIN7_USER = process.env.CIN7_USER || '';
const CIN7_KEY = process.env.CIN7_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const AIS_API_KEY = process.env.AIS_API_KEY || '';
const CIN7_REQUEST_SPACING_MS = 1500;
const CIN7_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CIN7_MIN_REFRESH_INTERVAL_MS = CIN7_REFRESH_INTERVAL_MS;
const CIN7_RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;
const ENABLE_RENDER_CIN7_SCHEDULER = process.env.ENABLE_RENDER_CIN7_SCHEDULER === 'true';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`${APP_PASSWORD}|ll-demand-planner-session-v1`).digest('hex');
const LL_AU_BRANCH_IDS = [3, 60976];
const LL_NZ_BRANCH_IDS = [48391];

// Shopify stores
const SHOPIFY_STORES = {
  lifely: {
    domain: 'lifelystore.myshopify.com',
    token: process.env.SHOPIFY_TOKEN || ''
  },
  cushie: {
    domain: 'cushie-2235.myshopify.com',
    token: process.env.SHOPIFY_TOKEN_CUSHIE || ''
  },
  littlelifely: {
    domain: 'little-lifely.myshopify.com',
    token: process.env.SHOPIFY_TOKEN_LL || ''
  }
};

// ===== CK DEFINITIONS =====
const CK_DEFS = {
  'llau':      { name: 'Little Lifely AU',              prefix: 'LLAU-CB-', logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'Australia', salesCountry: 'AU', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Little Lifely', filter: sku => !sku.includes('CBCF'), sizes: {'PACK':'Swatch Packs','-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llnz':      { name: 'Little Lifely NZ',              prefix: 'LLAU-CB-', logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'New Zealand', salesCountry: 'NZ', stockBranches: LL_NZ_BRANCH_IDS, strictStockBranches: true, option1: 'Category Killer - Little Lifely', filter: sku => !sku.includes('CBCF'), sizes: {'PACK':'Swatch Packs','-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llau-cbcf': { name: 'LL AU Combos',            prefix: 'LLAU-CBCF-', logo: 'little-lifely.png', store: 'lifely', excludeCV: true, salesCountry: 'AU', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Little Lifely', sizes: {'-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llna':     { name: 'Little Lifely NA',       prefix: 'LLNA',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'United States', salesCountry: 'US', stockBranches: [60701], option1: 'Category Killer - Little Lifely', sizes: {'-TWX-':'Twin XL','-TW-':'Twin','-F-':'Full'} },
  'llca':     { name: 'Little Lifely CA',       prefix: 'LLNA',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'Canada', salesCountry: 'CA', stockBranches: [61831], option1: 'Category Killer - Little Lifely', sizes: {'-TWX-':'Twin XL','-TW-':'Twin','-F-':'Full'} },
  'lluk':     { name: 'Little Lifely UK',       prefix: 'LLUK',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, salesCountry: 'GB', stockBranches: [62444], option1: 'Category Killer - Little Lifely', sizes: {'-S-':'Single','-SD-':'Small Double','-D-':'Double'} },
  'llsg':     { name: 'Little Lifely SG',       prefix: 'LLSG',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, salesCountry: 'SG', stockBranches: [57843], strictStockBranches: true, option1: 'Category Killer - Little Lifely', sizes: {'-SS-':'Super Single','-S-':'Single','-Q-':'Queen'} },
  'll-mattresses': { name: 'LL Mattresses',     prefix: 'MULTI',  logo: 'little-lifely.png', store: 'lifely', option1: ['Category Killer - 21cm Mattress', 'Category Killer - Deep Dream'], filter: sku => ['DD-21915CF','DD-21107CF','DD-21137CF'].includes(sku) || sku.startsWith('DDUK'), sizes: {'21915':'Single','21107':'King Single','21137':'Double','2190':'Single UK','21120':'Small Double UK','21135':'Double UK'} },
  'dd':       { name: 'Deep Dream',             prefix: 'MULTI',  logo: 'deep-dream.png',    store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: ['Category Killer - Deepdream', 'Category Killer - Deep Dream'], sizes: {'915':'Single','107':'King Single','137':'Double','153':'Queen','183':'King'} },
  'cocoon':   { name: 'Cocoon Bed',             prefix: 'COCOON', logo: 'cocoon-bed.png',    store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Cocoon Bed', sizes: {'-DOUBLE-':'Double','-QUEEN-':'Queen','-KING-':'King'} },
  'rdnt':     { name: 'Radiant',                prefix: 'RDNT',   logo: 'radiant.png',       store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Radiant', sizes: {'-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'wfhcr':    { name: 'WFH Chair',              prefix: 'WFHCR',  logo: 'wfh-chair.png',     store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - WFH Chair', sizes: {} },
  'cusb-au-snuggle': { name: 'Cushie Snuggle Bed',    prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', poDestination: 'Australia', salesCountry: 'AU', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Cushie V3 Snuggle', filter: sku => sku.startsWith('CUSB') && !sku.includes('-UK') && !sku.includes('SGE'), excludeCV: true, sizes: {'ARST':'Armrest','-TW-':'Twin','-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'cusb-au-lifely':  { name: 'Lifely Sofabed',         prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', poDestination: 'Australia', salesCountry: 'AU', stockBranches: LL_AU_BRANCH_IDS, option1: ['Category Killer - Cushie V2', 'Category Killer - Lifely Sofa'], filter: sku => sku.startsWith('LFSB') && !sku.includes('-UK'), excludeCV: true, sizes: {'-TW-':'Twin','-S-':'Single','-D-':'Double','-Q-':'Queen','-CHS-':'Chaise','-SOTM-':'Ottoman','-AMST-':'Armrest'} },
  'cusb-us':  { name: 'Cushie US',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', salesCountry: 'US', stockBranches: [60701], option1: ['Category Killer - Cushie V2', 'Category Killer - Cushie V3 Snuggle'], filter: sku => sku.startsWith('V2-') || sku.startsWith('V3-'), excludeCV: true, sizes: {'-TB-':'Twin','-DB-':'Full','-QB-':'Queen','-KB-':'King','-CH-':'Chaise','-OS-':'Ottoman','-OB-':'Ottoman Bed','-RMST-':'Armrest','-ARM-':'Armrest'} },
  'cusb-uk':  { name: 'Cushie UK',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', salesCountry: 'GB', stockBranches: [62444], option1: ['Category Killer - Cushie V2', 'Category Killer - Cushie V3 Snuggle'], filter: sku => (sku.startsWith('CUSB') || sku.startsWith('LFSB')) && sku.includes('-UK'), excludeCV: true, sizes: {'-TW-':'Twin','-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King','-CHS-':'Chaise','-SOTM-':'Ottoman','-AMST-':'Armrest'} },

  'cmss':     { name: 'Cushie Modular Sleeper', prefix: 'CMSS',   logo: 'cushie.png',        store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Cushie V2', sizes: {'-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'lifely-sofa': { name: 'Modular Sofa',        prefix: 'LIFELY', logo: 'lifely-sofa.png',   store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Lifely Sofa', sizes: {} },
  'case-goods': { name: 'Case Goods',           prefix: 'MULTI',  logo: 'lifely-sofa.png',   store: 'lifely', option1: ['Case goods - Active', 'Case goods - Discontinued'], filter: isCaseGoodsSku, sizes: {} }
};

// ===== COMBO BOM (Bill of Materials) =====
const COMBO_BOM = {
  // LLAU-CBCF-{size}-{colour} = 1× LLAU-CB-{size}-{colour} + 1× DD mattress
  mattress: { 'S': 'DD-21915CF', 'KS': 'DD-21107CF', 'D': 'DD-21137CF' }
};

const COCOON_SIZE_WORD = { 'D': 'DOUBLE', 'Q': 'QUEEN', 'K': 'KING' };

function getComboSize(sku) {
  if (sku.includes('-S-')) return 'S';
  if (sku.includes('-KS-')) return 'KS';
  if (sku.includes('-D-')) return 'D';
  return null;
}

function getComboColour(sku) {
  const parts = sku.split('-');
  return parts[parts.length - 1]; // Last segment is colour
}

function explodeComboBOM(comboSku) {
  const size = getComboSize(comboSku);
  const colour = getComboColour(comboSku);
  if (!size || !colour) return null;
  return {
    bed: 'LLAU-CB-' + size + '-' + colour,
    mattress: COMBO_BOM.mattress[size],
    bedQty: 1,
    mattressQty: 1
  };
}

function explodeRadiantSetSku(setSku) {
  if (!setSku.startsWith('RDNT-') || !setSku.endsWith('-SET')) return null;
  const parts = setSku.split('-');
  const size = parts[1];
  const types = parts.slice(2, -1);
  if (!['D', 'Q', 'K'].includes(size) || types.length === 0) return null;
  return {
    size,
    components: ['RDNT-' + size + '-BASE', ...types.map(type => 'RDNT-' + size + '-' + type)]
  };
}

function explodeCocoonRadiantCombo(comboSku) {
  if (!comboSku.startsWith('COCOON-RDNT-')) return null;
  const parts = comboSku.split('-');
  if (parts.length < 5) return null;
  const colour = parts[2];
  const size = parts[3];
  const types = parts.slice(4);
  if (!COCOON_SIZE_WORD[size] || types.length === 0) return null;
  return {
    size,
    colour,
    bed: 'COCOON-' + COCOON_SIZE_WORD[size] + '-' + colour,
    bedQty: 1,
    mattressComponents: ['RDNT-' + size + '-BASE', ...types.map(type => 'RDNT-' + size + '-' + type)]
  };
}

// ===== SESSION STORE =====
// Sessions are stateless signed tokens so users stay signed in across Render restarts/deploys.
// The browser stores the token with a 30-day localStorage expiry.
const sessions = new Map(); // legacy in-memory sessions kept for older open tabs until restart
function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}
function signSessionPayload(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
function createSession() {
  const now = Date.now();
  const payload = base64Url(JSON.stringify({ iat: now, exp: now + SESSION_TTL_MS, nonce: crypto.randomBytes(12).toString('hex') }));
  return `${payload}.${signSessionPayload(payload)}`;
}
function validSession(id) {
  if (!id || typeof id !== 'string') return false;

  // Legacy support for old in-memory 24h sessions.
  const s = sessions.get(id);
  if (s?.valid) {
    if (Date.now() - s.created > 24 * 60 * 60 * 1000) { sessions.delete(id); return false; }
    return true;
  }

  const parts = id.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const expected = signSessionPayload(payload);
  const sig = Buffer.from(signature);
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length || !crypto.timingSafeEqual(sig, exp)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp || 0) > Date.now();
  } catch (_) {
    return false;
  }
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateMasterhubToken(token, expectedAudience) {
  if (!MASTERHUB_SSO_SECRET || !token) return null;
  const [encodedPayload, signature] = String(token).split('.');
  if (!encodedPayload || !signature) return null;
  const expectedSignature = crypto
    .createHmac('sha256', MASTERHUB_SSO_SECRET)
    .update(encodedPayload)
    .digest('base64url');
  if (!timingSafeStringEqual(expectedSignature, signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== expectedAudience) return null;
    if (payload.iss !== 'lifely-masterhub') return null;
    if (!payload.email || typeof payload.exp !== 'number' || payload.exp < now) return null;
    if (typeof payload.iat === 'number' && payload.iat > now + 60) return null;
    return payload;
  } catch {
    return null;
  }
}

// ===== AUTH MIDDLEWARE =====
function requireAuth(req, res, next) {
  const sid = req.headers['x-session'] || req.query.session;
  if (validSession(sid)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

// ===== DATA CACHE =====
let dataCache = {
  lastRefresh: null,
  lastCin7Refresh: null,
  lastPoRefresh: null,
  lastShopifyRefresh: null,
  lastSnapshotWrite: null,
  cin7Products: {},   // sku -> {soh, available, costAUD, cbm}
  cin7StockByBranch: {}, // sku -> { branchId -> { soh, available, branchName } }
  cin7POs: [],        // [{reference, status, stage, arrival, items: {sku: qty}}]
  shopifyVelocity: {}, // store -> {sku -> weekly_velocity}
  shopifyInventory: {}, // store -> {sku -> inventory_level}
  shopifyOpenDemand: {}, // store -> { country -> { sku -> open qty } }
  shopifyVelocityByCountry: {}, // store -> { country -> { velocity/trend maps } }
  error: null
};
const CACHE_SNAPSHOT_PATH = path.join(__dirname, 'data', 'cache-snapshot.json');
const PO_LINE_OVERRIDES_PATH = path.join(__dirname, 'data', 'po-line-overrides.json');
const SNAPSHOT_PUSH_STATE_PATH = path.join(__dirname, 'data', 'snapshot-push-state.json');
let cacheSnapshotPushInFlight = false;
const CIN7_DATA_SOURCE = 'live-cin7-api-cache';

function getStoreKeysForCk(ckId, primaryStore) {
  const keys = new Set([primaryStore]);
  if (ckId.startsWith('ll')) keys.add('littlelifely');
  if (primaryStore === 'lifely') keys.add('cushie');
  return [...keys];
}

function normalizeOption1(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function skuOption1(sku, override = '') {
  return dataCache.cin7Products?.[sku]?.option1 || override || '';
}

function skuMatchesOption1(sku, def, override = '') {
  if (!def.option1) return true;
  const actual = normalizeOption1(skuOption1(sku, override));
  if (!actual) return false;
  const allowed = Array.isArray(def.option1) ? def.option1 : [def.option1];
  return allowed.some(value => normalizeOption1(value) === actual);
}

function skuMatchesDef(sku, def, option1Override = '') {
  const filter = def.filter || (() => true);
  const prefix = def.prefix;
  if (prefix === 'MULTI') {
    if (!filter(sku)) return false;
  } else if (!(sku.startsWith(prefix) && filter(sku))) {
    return false;
  }
  if (def.excludeCV && sku.includes('-CV')) return false;
  if (!skuMatchesOption1(sku, def, option1Override)) return false;
  return true;
}

function poStageValue(po) {
  return String(po?.stage || '').trim().toLowerCase();
}

function poStatusValue(po) {
  return String(po?.status || '').trim().toLowerCase();
}

function isReceivedPO(po) {
  return !!po?.fullyReceivedDate || poStageValue(po) === 'received';
}

function isVoidPO(po) {
  const stage = poStageValue(po);
  const status = poStatusValue(po);
  return /void|cancel|deleted/.test(stage) || /void|cancel|deleted/.test(status);
}

function isOpenPO(po) {
  return !!po && !isReceivedPO(po) && !isVoidPO(po);
}

function ckCategoryForSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  if (!s) return 'Uncategorised';
  for (const [id, def] of Object.entries(CK_DEFS)) {
    if (skuMatchesDef(s, def)) return def.name;
  }
  return 'Uncategorised';
}

function loadPoLineOverrides() {
  try { return JSON.parse(fs.readFileSync(PO_LINE_OVERRIDES_PATH, 'utf8')); }
  catch (_) { return {}; }
}

function applyPoLineOverride(po, overrides = {}) {
  const override = overrides[rawPoReference(po.reference)];
  if (!override) return po;
  const currentItems = po.items || {};
  if (Object.keys(currentItems).length > 0) return po;
  return {
    ...po,
    items: override.items || {},
    itemNames: { ...(po.itemNames || {}), ...(override.itemNames || {}) },
    itemOption1: { ...(po.itemOption1 || {}), ...(override.itemOption1 || {}) }
  };
}

function cin7Option1CategoriesForPoItems(items, itemOption1 = {}) {
  return Object.fromEntries(Object.keys(items || {}).map(sku => [sku, dataCache.cin7Products?.[sku]?.option1 || itemOption1?.[sku] || '']));
}

function isCaseGoodsSku(sku) {
  const s = String(sku || '').toUpperCase();
  if (!s) return false;
  const compact = s.replace(/[^A-Z0-9]/g, '');
  if (['LIFELYCARE', 'CAREINSURANCE', 'INSURANCE', 'GIFTCARD'].some(x => compact.includes(x))) return false;

  // Case Goods is the residual Lifely catalogue bucket. Keep this aligned with
  // the weekly Category Killer dashboard: exclude named CKs, insurance, and gift cards.
  if (s.startsWith('LLAU') || s.startsWith('LLUS') || s.startsWith('LLUK') || s.startsWith('LLNZ') || s.startsWith('LLSG') || s.startsWith('LLCA') || s.startsWith('LLNA') || s.startsWith('LL-')) return false;
  if (s.startsWith('CUSB') || s.startsWith('V2-') || s.startsWith('V3-') || s.startsWith('CMSS') || s.startsWith('CLV2') || s.startsWith('CSV2') || s.startsWith('LFSB')) return false;
  if (s.startsWith('LFSF') || s.startsWith('LIFELY-SOFA')) return false;
  if (s.startsWith('CCN') || s.startsWith('COCOON')) return false;
  if (s.startsWith('DD-') || s.startsWith('DDM') || s.startsWith('DDRM')) return false;
  if (s.startsWith('RAD') || s.startsWith('RDNT')) return false;
  if (s.startsWith('WFH')) return false;
  if (['QB+ARMREST', 'TB+ARMREST', 'TB-ARMREST', 'DB+ARMREST', 'OB-', 'OS-'].some(p => s.includes(p))) return false;
  return true;
}

function snapshotHasCin7Data(snap) {
  return !!(snap && (
    (snap.cin7Products && Object.keys(snap.cin7Products).length > 0) ||
    (Array.isArray(snap.cin7POs) && snap.cin7POs.length > 0)
  ));
}

function rawPoReference(ref) {
  return String(ref || '');
}


const PO_ETA_HISTORY_PATH = path.join(__dirname, 'data', 'po-eta-history.json');
const PO_ETA_HISTORY_BACKUP_PATH = path.join(__dirname, 'data', 'po-eta-history.last-good.json');

function parsePoDateKey(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const dmy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  let d;
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    d = new Date(`${year}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}T00:00:00Z`);
  } else {
    d = new Date(str);
  }
  if (Number.isNaN(d.getTime())) return str;
  return d.toISOString().slice(0, 10);
}

function daysBetweenDateKeys(from, to) {
  if (!from || !to) return null;
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function poHistoryKey(po) {
  const id = po.id || po.orderId || po.purchaseOrderId;
  if (id) return `id:${id}`;
  return `ref:${rawPoReference(po.reference || '')}`;
}

function loadPoEtaHistory() {
  for (const historyPath of [PO_ETA_HISTORY_PATH, PO_ETA_HISTORY_BACKUP_PATH]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (parsed && typeof parsed === 'object') return { ...parsed, pos: parsed.pos || {} };
    } catch (_) {}
  }
  return { version: 1, generatedAt: null, pos: {} };
}

function savePoEtaHistory(history) {
  fs.mkdirSync(path.dirname(PO_ETA_HISTORY_PATH), { recursive: true });
  const payload = JSON.stringify(history, null, 2);
  fs.writeFileSync(PO_ETA_HISTORY_PATH, payload);
  fs.writeFileSync(PO_ETA_HISTORY_BACKUP_PATH, payload);
}

function updatePoEtaHistory(pos, detectedAt = new Date().toISOString()) {
  if (!Array.isArray(pos) || pos.length === 0) return loadPoEtaHistory();
  const history = loadPoEtaHistory();
  history.version = 1;
  history.generatedAt = detectedAt;
  history.pos = history.pos || {};

  for (const po of pos) {
    const key = poHistoryKey(po);
    if (!key || key === 'ref:') continue;
    const reference = rawPoReference(po.reference || '');
    const currentEta = parsePoDateKey(po.estimatedArrivalDate || po.arrival);
    const originalEta = parsePoDateKey(po.customFields?.orders_1000);
    const receivedDate = parsePoDateKey(po.fullyReceivedDate);
    const id = po.id || po.orderId || po.purchaseOrderId || null;
    const record = history.pos[key] || {
      key,
      id,
      reference,
      firstSeenAt: detectedAt,
      events: []
    };

    const addEvent = (type, from, to, extra = {}) => {
      const last = record.events[record.events.length - 1];
      if (last && last.type === type && last.from === from && last.to === to) return;
      record.events.push({ detectedAt, type, from: from || null, to: to || null, ...extra });
    };

    if (!history.pos[key]) {
      if (originalEta || currentEta) {
        addEvent('first_seen', null, currentEta || originalEta, {
          originalEta: originalEta || null,
          currentEta: currentEta || null,
          deltaDaysFromOriginal: daysBetweenDateKeys(originalEta, currentEta)
        });
      }
    } else {
      if (record.currentEta !== currentEta) {
        addEvent('eta_changed', record.currentEta || null, currentEta || null, {
          deltaDays: daysBetweenDateKeys(record.currentEta, currentEta),
          deltaDaysFromOriginal: daysBetweenDateKeys(originalEta || record.originalEta, currentEta)
        });
      }
      if (record.originalEta !== originalEta) {
        addEvent('original_eta_changed', record.originalEta || null, originalEta || null);
      }
      if (record.receivedDate !== receivedDate && receivedDate) {
        addEvent('received', record.receivedDate || null, receivedDate, {
          deltaDaysFromOriginal: daysBetweenDateKeys(originalEta || record.originalEta, receivedDate)
        });
      }
    }

    record.id = id;
    record.reference = reference;
    record.supplier = po.company || record.supplier || '';
    record.stage = po.stage || '';
    record.status = po.status || '';
    record.deliveryCountry = po.deliveryCountry || record.deliveryCountry || '';
    record.originalEta = originalEta || null;
    record.currentEta = currentEta || null;
    record.receivedDate = receivedDate || null;
    record.lastSeenAt = detectedAt;
    history.pos[key] = record;
  }

  try { savePoEtaHistory(history); }
  catch (e) { console.warn('PO ETA history save failed:', e.message); }
  return history;
}

function getPoEtaHistoryRecord(po) {
  const history = loadPoEtaHistory();
  return history.pos?.[poHistoryKey(po)] || null;
}

function saveSnapshotPushState(state) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PUSH_STATE_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PUSH_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('Snapshot push state save failed:', e.message);
  }
}

function loadSnapshotPushState() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PUSH_STATE_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function maybePushCacheSnapshotToGit(reason = 'cin7-refresh') {
  const now = Date.now();
  const state = loadSnapshotPushState();
  // Every successful scheduled CIN7 refresh should persist a repo cache, but avoid
  // duplicate commits when a manual refresh and scheduled refresh happen close together.
  if (cacheSnapshotPushInFlight || (state.cacheLastSuccessAtMs && now - state.cacheLastSuccessAtMs < 30 * 60 * 1000)) return;
  cacheSnapshotPushInFlight = true;
  const command = [
    'git add data/cache-snapshot.json data/po-eta-history.json data/po-eta-history.last-good.json',
    'git diff --cached --quiet && exit 0',
    `git commit -m "Update cache snapshot (${reason})"`,
    'git push'
  ].join(' && ');
  exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
    cacheSnapshotPushInFlight = false;
    if (stdout) console.log(stdout.trim());
    if (stderr) console.log(stderr.trim());
    if (error) {
      if (error.code !== 0) console.error('Cache snapshot git push failed:', error.message);
      return;
    }
    saveSnapshotPushState({ ...state, cacheLastSuccessAtMs: Date.now(), cacheLastReason: reason, cachePushedAt: new Date().toISOString() });
    console.log('Cache snapshot pushed to GitHub');
  });
}

function loadCacheSnapshot(silent = false) {
  let loaded = false;
  for (const snapPath of [CACHE_SNAPSHOT_PATH]) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      if (snapshotHasCin7Data(snap)) {
        dataCache = {
          ...dataCache,
          ...snap,
          shopifyVelocityByCountry: snap.shopifyVelocityByCountry || Object.fromEntries(
            Object.entries(snap.shopifyVelocity || {}).map(([store, velocity]) => [store, velocity?._byCountry || {}])
          ),
          error: null
        };
        dataCache.cin7POs = dataCache.cin7POs || [];
        if (!silent) console.log(`Loaded cache snapshot from ${path.basename(snapPath)}: ${Object.keys(dataCache.cin7Products).length} CIN7 SKUs, ${dataCache.cin7POs.length} POs`);
        loaded = true;
        break;
      }
      if (!silent) console.log(`Cache snapshot empty at ${path.basename(snapPath)} - ignoring`);
    } catch (e) {
      // try next path
    }
  }
  if (!silent && !snapshotHasCin7Data(dataCache)) console.log('No usable cache snapshot found - starting cold');
  return loaded;
}

function reloadSnapshotIfNewer() {
  loadCacheSnapshot(true);
}

function saveCacheSnapshot(pushToGit = false, pushReason = 'cin7-refresh') {
  try {
    const snapshotTs = new Date().toISOString();
    dataCache.lastSnapshotWrite = snapshotTs;
    dataCache.lastRefresh = snapshotTs;
    const snapshot = {
      snapshotCreatedAt: snapshotTs,
      lastSnapshotWrite: dataCache.lastSnapshotWrite,
      lastRefresh: dataCache.lastRefresh,
      lastCin7Refresh: dataCache.lastCin7Refresh,
      lastPoRefresh: dataCache.lastPoRefresh,
      lastShopifyRefresh: dataCache.lastShopifyRefresh,
      cin7Products: dataCache.cin7Products,
      cin7StockByBranch: dataCache.cin7StockByBranch,
      cin7POs: dataCache.cin7POs || [],
      shopifyVelocity: dataCache.shopifyVelocity,
      shopifyVelocityByCountry: dataCache.shopifyVelocityByCountry,
      shopifyInventory: dataCache.shopifyInventory,
      shopifyOpenDemand: dataCache.shopifyOpenDemand,
      error: dataCache.error,
      fxRate
    };

    if (!snapshotHasCin7Data(snapshot)) {
      console.warn('Refusing to save empty Cin7 snapshot - keeping last good cache on disk');
      return;
    }

    updatePoEtaHistory(snapshot.cin7POs || [], snapshotTs);
    fs.mkdirSync(path.dirname(CACHE_SNAPSHOT_PATH), { recursive: true });
    const payload = JSON.stringify(snapshot);
    fs.writeFileSync(CACHE_SNAPSHOT_PATH, payload);
    console.log('Saved cache snapshot');
    if (pushToGit) maybePushCacheSnapshotToGit(pushReason);
  } catch (e) {
    console.error('Cache snapshot save failed:', e.message);
  }
}

loadCacheSnapshot();

// Load Excel-derived landed costs (SOH Stock Value ÷ SOH Stock Qty from CIN7 report)
let excelLandedCosts = {};
try {
  excelLandedCosts = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'landed-costs.json'), 'utf8'));
  console.log(`Loaded ${Object.keys(excelLandedCosts).length} Excel landed costs`);
} catch (e) { console.log('No Excel landed costs file found - will use estimated only'); }

// ===== LIVE FX RATE =====
let fxRate = { USDAUD: 1.45, lastFetch: null }; // fallback
async function refreshFxRate() {
  try {
    const { body } = await apiRequest({ hostname: 'open.er-api.com', path: '/v6/latest/USD', headers: {} });
    if (body?.rates?.AUD) {
      fxRate.USDAUD = body.rates.AUD;
      fxRate.lastFetch = new Date().toISOString();
      console.log(`FX rate updated: 1 USD = ${fxRate.USDAUD} AUD`);
    }
  } catch (e) { console.log('FX rate fetch failed:', e.message); }
}
refreshFxRate();
setInterval(refreshFxRate, 6 * 60 * 60 * 1000); // Refresh every 6 hours

// ===== HTTPS REQUEST HELPER =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let cin7LastRequestAt = 0;
let cin7BackoffUntil = 0;
let cin7RecoveryTimer = null;
let refreshPromise = null;
const CIN7_REFRESH_ANCHOR_UTC_HOUR = 0; // every 4h from midnight UTC

async function throttleCin7Request() {
  const waitMs = Math.max(0, cin7LastRequestAt + CIN7_REQUEST_SPACING_MS - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  cin7LastRequestAt = Date.now();
}

function hasCin7Cache() {
  return Object.keys(dataCache.cin7Products || {}).length > 0;
}

function scheduleCin7Recovery(reason) {
  if (cin7RecoveryTimer) return;
  const delayMs = Math.max(CIN7_RATE_LIMIT_BACKOFF_MS, cin7BackoffUntil > Date.now() ? cin7BackoffUntil - Date.now() : CIN7_RATE_LIMIT_BACKOFF_MS);
  console.warn(`Scheduling delayed CIN7 recovery in ${Math.ceil(delayMs / 60000)} min (${reason})`);
  cin7RecoveryTimer = setTimeout(async () => {
    cin7RecoveryTimer = null;
    console.log('Running scheduled CIN7 recovery refresh...');
    try {
      await refreshAllData();
    } catch (e) {
      console.error('Scheduled CIN7 recovery failed:', e.message);
    }
  }, delayMs);
  if (typeof cin7RecoveryTimer.unref === 'function') cin7RecoveryTimer.unref();
}

function getCin7SkipReason(force = false) {
  const now = Date.now();
  const lastCin7RefreshMs = dataCache.lastCin7Refresh ? new Date(dataCache.lastCin7Refresh).getTime() : 0;

  if (cin7BackoffUntil > now && hasCin7Cache()) {
    return `rate limit backoff active for ${Math.ceil((cin7BackoffUntil - now) / 60000)} more min`;
  }

  if (!force && lastCin7RefreshMs && hasCin7Cache() && (now - lastCin7RefreshMs) < CIN7_MIN_REFRESH_INTERVAL_MS) {
    return `last CIN7 refresh was ${Math.round((now - lastCin7RefreshMs) / 60000)} min ago`;
  }

  return null;
}

function markCin7Backoff(reason, retryAfterSeconds) {
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Math.max(CIN7_RATE_LIMIT_BACKOFF_MS, retryAfterSeconds * 1000)
    : CIN7_RATE_LIMIT_BACKOFF_MS;
  cin7BackoffUntil = Math.max(cin7BackoffUntil, Date.now() + retryAfterMs);
  console.warn(`CIN7 backoff enabled for ${Math.ceil(retryAfterMs / 60000)} min (${reason})`);
  scheduleCin7Recovery(reason);
}

function msUntilNextFourHourlyRefresh(anchorHourUtc = CIN7_REFRESH_ANCHOR_UTC_HOUR) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  const currentHour = next.getUTCHours();
  const hoursSinceAnchor = ((currentHour - anchorHourUtc) % 4 + 4) % 4;
  const addHours = hoursSinceAnchor === 0 && next > now ? 0 : 4 - hoursSinceAnchor;
  next.setUTCHours(currentHour + addHours, 0, 0, 0);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 4, 0, 0, 0);
  return next.getTime() - now.getTime();
}

function scheduleFourHourlyCin7Refresh() {
  const delayMs = msUntilNextFourHourlyRefresh();
  console.log(`Next scheduled CIN7 refresh in ${Math.ceil(delayMs / 60000)} min (every 4h UTC)`);
  const timer = setTimeout(async () => {
    try {
      console.log('Running scheduled CIN7 refresh (every 4h)...');
      await refreshAllData(true);
    } catch (e) {
      console.error('Scheduled CIN7 refresh failed:', e.message);
    } finally {
      scheduleFourHourlyCin7Refresh();
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function apiRequest(options, postData, attempt = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', async () => {
        const status = res.statusCode || 0;

        // Cin7 can return 429 during cold starts or concurrent refreshes.
        // Retry briefly, but never honor giant Retry-After values that can stall
        // the whole refresh loop for hours and leave the planner empty on restart.
        if (options.hostname === 'api.cin7.com' && status === 429 && attempt < 2) {
          const retryAfterHeader = parseInt(res.headers['retry-after'] || '2', 10);
          const retryAfter = Math.min(15, Math.max(2, Number.isFinite(retryAfterHeader) ? retryAfterHeader : 2));
          console.warn(`Cin7 429 for ${options.path} - retrying in ${retryAfter}s (attempt ${attempt + 1}/2)`);
          await sleep(retryAfter * 1000);
          try {
            const retried = await apiRequest(options, postData, attempt + 1);
            return resolve(retried);
          } catch (e) {
            return reject(e);
          }
        }

        try { resolve({ body: JSON.parse(data), headers: res.headers, status }); }
        catch(e) { resolve({ body: data, headers: res.headers, status }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// ===== CIN7: FETCH ALL PRODUCTS =====
async function fetchCin7AllProducts() {
  if (!CIN7_USER || !CIN7_KEY) { console.log('CIN7 SKIPPED: no credentials. USER=' + (CIN7_USER ? 'set' : 'empty') + ' KEY=' + (CIN7_KEY ? 'set' : 'empty')); return { products: {}, stockByBranch: {} }; }
  const auth = Buffer.from(`${CIN7_USER}:${CIN7_KEY}`).toString('base64');
  const products = {};
  const stockByBranch = {};

  for (let page = 1; page <= 50; page++) {
    try {
      console.log('CIN7 Products: fetching page ' + page);
      let body, status, headers;
      try {
        await throttleCin7Request();
        const resp = await apiRequest({
          hostname: 'api.cin7.com',
          path: `/api/v1/Products?page=${page}&rows=250`,
          headers: { 'Authorization': `Basic ${auth}` }
        });
        body = resp.body;
        status = resp.status;
        headers = resp.headers || {};
      } catch (fetchErr) {
        console.error(`CIN7 Products page ${page} failed:`, fetchErr.message);
        break;
      }
      console.log('CIN7 Products page ' + page + ': status=' + status + ' isArray=' + Array.isArray(body) + ' length=' + (Array.isArray(body) ? body.length : 'N/A'));
      if (status === 429) {
        markCin7Backoff(`Products page ${page}`, parseInt(headers['retry-after'] || '0', 10));
        break;
      }
      if (!Array.isArray(body) || body.length === 0) break;
      for (const product of body) {
        const variants = product.productOptions || [];
        const cbm = product.volume || 0;
        for (const v of variants) {
          if (v.code) {
            const pc = v.priceColumns || {};
            const costAUD = pc.costAUD || (pc.costUSD ? pc.costUSD * fxRate.USDAUD : 0);
            products[v.code] = { soh: v.stockOnHand || 0, available: v.stockAvailable || 0, costAUD, cbm, option1: v.option1 || product.option1 || '' };
          }
        }
        if (product.styleCode && product.stockOnHand > 0) {
          products[product.styleCode] = { soh: product.stockOnHand, available: product.stockAvailable || 0, cbm, option1: product.option1 || '' };
        }
      }
    } catch (e) { console.error(`CIN7 Products page ${page} error:`, e.message); continue; }
  }

  for (let page = 1; page <= 50; page++) {
    try {
      console.log('CIN7 ProductOptions: fetching page ' + page);
      let body, status, headers;
      try {
        await throttleCin7Request();
        const resp = await apiRequest({
          hostname: 'api.cin7.com',
          path: `/api/v1/ProductOptions?page=${page}&rows=250`,
          headers: { 'Authorization': `Basic ${auth}` }
        });
        body = resp.body;
        status = resp.status;
        headers = resp.headers || {};
      } catch (fetchErr) {
        console.error(`CIN7 ProductOptions page ${page} failed:`, fetchErr.message);
        break;
      }
      console.log('CIN7 ProductOptions page ' + page + ': status=' + status + ' isArray=' + Array.isArray(body) + ' length=' + (Array.isArray(body) ? body.length : 'N/A'));
      if (status === 429) {
        markCin7Backoff(`ProductOptions page ${page}`, parseInt(headers['retry-after'] || '0', 10));
        break;
      }
      if (!Array.isArray(body) || body.length === 0) break;
      for (const option of body) {
        const sku = option.code || option.productOptionCode;
        if (!sku) continue;
        const pc = option.priceColumns || {};
        const costAUD = pc.costAUD || (pc.costUSD ? pc.costUSD * fxRate.USDAUD : 0);
        const existing = products[sku] || {};
        products[sku] = {
          ...existing,
          soh: existing.soh ?? (option.stockOnHand || 0),
          available: existing.available ?? (option.stockAvailable || 0),
          costAUD: existing.costAUD || costAUD || 0,
          cbm: existing.cbm || 0,
          option1: option.option1 || existing.option1 || ''
        };
      }
    } catch (e) { console.error(`CIN7 ProductOptions page ${page} error:`, e.message); continue; }
  }

  for (let page = 1; page <= 50; page++) {
    try {
      console.log('CIN7 Stock: fetching page ' + page);
      let body, status, headers;
      try {
        await throttleCin7Request();
        const resp = await apiRequest({
          hostname: 'api.cin7.com',
          path: `/api/v1/Stock?page=${page}&rows=250`,
          headers: { 'Authorization': `Basic ${auth}` }
        });
        body = resp.body;
        status = resp.status;
        headers = resp.headers || {};
      } catch (fetchErr) {
        console.error(`CIN7 Stock page ${page} failed:`, fetchErr.message);
        break;
      }
      if (status === 429) {
        markCin7Backoff(`Stock page ${page}`, parseInt(headers['retry-after'] || '0', 10));
        break;
      }
      if (!Array.isArray(body) || body.length === 0) break;
      for (const row of body) {
        const sku = row.code;
        const branchId = Number(row.branchId || 0);
        if (!sku || !branchId) continue;
        if (!stockByBranch[sku]) stockByBranch[sku] = {};
        stockByBranch[sku][branchId] = {
          soh: Number(row.stockOnHand || 0),
          available: Number(row.available || 0),
          branchName: row.branchName || ''
        };
      }
    } catch (e) { console.error(`CIN7 Stock page ${page} error:`, e.message); continue; }
  }

  for (const [sku, branches] of Object.entries(stockByBranch)) {
    const totalSoh = Object.values(branches).reduce((sum, b) => sum + (Number(b.soh) || 0), 0);
    const totalAvailable = Object.values(branches).reduce((sum, b) => sum + (Number(b.available) || 0), 0);
    if (products[sku]) {
      products[sku].soh = totalSoh;
      products[sku].available = totalAvailable;
    } else {
      products[sku] = { soh: totalSoh, available: totalAvailable, costAUD: 0, cbm: 0 };
    }
  }

  return { products, stockByBranch };
}

// ===== CIN7: FETCH PURCHASE ORDERS =====
async function fetchCin7POs() {
  if (!CIN7_USER || !CIN7_KEY) return [];
  const auth = Buffer.from(`${CIN7_USER}:${CIN7_KEY}`).toString('base64');
  const results = [];
  for (let page = 1; ; page++) {
    try {
      await throttleCin7Request();
      const { body, status, headers } = await apiRequest({
        hostname: 'api.cin7.com',
        path: `/api/v1/PurchaseOrders?page=${page}&rows=250`,
        headers: { 'Authorization': `Basic ${auth}` }
      });
      if (status === 429) {
        markCin7Backoff(`PurchaseOrders page ${page}`, parseInt(headers['retry-after'] || '0', 10));
        break;
      }
      if (!Array.isArray(body) || body.length === 0) break;
      for (const po of body) {
        if (po.isVoid) continue; // Skip void POs only - keep Received for shipment tracker
        const items = {};
        const itemNames = {};
        const itemOption1 = {};
        for (const li of (po.lineItems || [])) {
          if (li.code && li.qty > 0) {
            items[li.code] = (items[li.code] || 0) + li.qty;
            if (li.name && !itemNames[li.code]) itemNames[li.code] = li.name;
            if (li.option1 && !itemOption1[li.code]) itemOption1[li.code] = li.option1;
          }
        }
        results.push({
          id: po.id || po.ID || po.purchaseOrderId || po.orderId || null,
          reference: rawPoReference(po.reference),
          status: po.status,
          stage: po.stage || '',
          arrival: po.estimatedArrivalDate || null, // ETA only - never fall back to ETD
          etd: po.estimatedDeliveryDate || null,
          estimatedArrivalDate: po.estimatedArrivalDate || null,
          fullyReceivedDate: po.fullyReceivedDate || null,
          customFields: po.customFields || {},
          company: po.company || '',
          total: po.total || 0,
          currencyCode: po.currencyCode || 'USD',
          deliveryCountry: po.deliveryCountry || '',
          deliveryCity: po.deliveryCity || '',
          trackingCode: po.trackingCode || '',
          port: po.port || '',
          logisticsCarrier: po.logisticsCarrier || '',
          internalComments: po.internalComments || '',
          freightTotal: po.freightTotal || 0,
          createdBy: po.createdBy || null,
          invoiceDate: po.invoiceDate || null,
          supplierInvoiceReference: po.supplierInvoiceReference || '',
          itemNames,
          itemOption1,
          items
        });
      }
    } catch (e) { console.error(`CIN7 POs page ${page} error:`, e.message); break; }
  }
  return results;
}

// ===== SHOPIFY: FETCH ORDERS & CALCULATE VELOCITY =====
async function fetchShopifyVelocity(storeKey) {
  const store = SHOPIFY_STORES[storeKey];
  if (!store || !store.token) return { ok: false, data: {} };

  const skuUnits = {};
  const skuWeekly = {};
  const sku7d = {};
  const sku30d = {};
  const skuFirstSeen = {};
  const byCountry = {};
  const now7d = new Date(Date.now() - 7 * 86400000);
  const now30d = new Date(Date.now() - 30 * 86400000);
  const days = 30;
  const historyDays = 90; // longer window for weekly breakdown + last in-stock velocity
  const since = new Date(Date.now() - historyDays * 86400000).toISOString();
  let url = `/admin/api/2026-01/orders.json?status=any&limit=250&created_at_min=${since}&fields=id,created_at,line_items,financial_status,shipping_address`;

  const ensureCountry = (country) => {
    if (!byCountry[country]) {
      byCountry[country] = { skuUnits: {}, skuWeekly: {}, sku7d: {}, sku30d: {}, skuFirstSeen: {} };
    }
    return byCountry[country];
  };

  for (let page = 1; page <= 30; page++) {
    try {
      const { body, headers } = await apiRequest({
        hostname: store.domain,
        path: url,
        headers: { 'X-Shopify-Access-Token': store.token }
      });
      const orders = body.orders || [];
      if (orders.length === 0) break;

      for (const o of orders) {
        if (o.financial_status === 'refunded' || o.financial_status === 'voided') continue;
        const dt = new Date(o.created_at);
        const jan4 = new Date(dt.getFullYear(), 0, 4);
        const dayOfYear = Math.floor((dt - new Date(dt.getFullYear(), 0, 1)) / 86400000);
        const weekNum = Math.ceil((dayOfYear + jan4.getDay() + 1) / 7);
        const weekKey = dt.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
        const rawCountry = (o.shipping_address?.country_code || o.shipping_address?.country || '').toString().trim();
        const country = rawCountry ? (rawCountry.length === 2 ? rawCountry.toUpperCase() : rawCountry) : null;
        const countryBucket = country ? ensureCountry(country) : null;

        for (const li of (o.line_items || [])) {
          if (li.sku) {
            const qty = li.quantity || 0;
            skuUnits[li.sku] = (skuUnits[li.sku] || 0) + qty;
            if (dt >= now7d) sku7d[li.sku] = (sku7d[li.sku] || 0) + qty;
            if (dt >= now30d) sku30d[li.sku] = (sku30d[li.sku] || 0) + qty;
            if (!skuFirstSeen[li.sku] || dt < skuFirstSeen[li.sku]) skuFirstSeen[li.sku] = dt;
            if (!skuWeekly[li.sku]) skuWeekly[li.sku] = {};
            skuWeekly[li.sku][weekKey] = (skuWeekly[li.sku][weekKey] || 0) + qty;

            if (countryBucket) {
              countryBucket.skuUnits[li.sku] = (countryBucket.skuUnits[li.sku] || 0) + qty;
              if (dt >= now7d) countryBucket.sku7d[li.sku] = (countryBucket.sku7d[li.sku] || 0) + qty;
              if (dt >= now30d) countryBucket.sku30d[li.sku] = (countryBucket.sku30d[li.sku] || 0) + qty;
              if (!countryBucket.skuFirstSeen[li.sku] || dt < countryBucket.skuFirstSeen[li.sku]) countryBucket.skuFirstSeen[li.sku] = dt;
              if (!countryBucket.skuWeekly[li.sku]) countryBucket.skuWeekly[li.sku] = {};
              countryBucket.skuWeekly[li.sku][weekKey] = (countryBucket.skuWeekly[li.sku][weekKey] || 0) + qty;
            }
          }
        }
      }

      const link = headers.link || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      if (!nextMatch) break;
      url = new URL(nextMatch[1]).pathname + new URL(nextMatch[1]).search;
    } catch (e) { console.error(`Shopify ${storeKey} page ${page} error:`, e.message); return { ok: false, data: {} }; }
  }

  const weeks = days / 7;
  const velocity = {};
  for (const [sku, units] of Object.entries(sku30d)) {
    velocity[sku] = Math.round((units / weeks) * 10) / 10;
  }
  for (const sku of Object.keys(skuUnits)) {
    if (!(sku in velocity)) velocity[sku] = 0;
  }
  velocity._weeklyBreakdown = skuWeekly || {};
  velocity._7d = sku7d;
  velocity._30d = sku30d;
  velocity._firstSeen = {};
  for (const [sku, dt] of Object.entries(skuFirstSeen)) {
    velocity._firstSeen[sku] = dt.toISOString();
  }
  velocity._byCountry = {};
  for (const [country, bucket] of Object.entries(byCountry)) {
    const countryVel = {};
    for (const [sku, units] of Object.entries(bucket.sku30d)) {
      countryVel[sku] = Math.round((units / weeks) * 10) / 10;
    }
    for (const sku of Object.keys(bucket.skuUnits)) {
      if (!(sku in countryVel)) countryVel[sku] = 0;
    }
    countryVel._weeklyBreakdown = bucket.skuWeekly || {};
    countryVel._7d = bucket.sku7d;
    countryVel._30d = bucket.sku30d;
    countryVel._firstSeen = {};
    for (const [sku, dt] of Object.entries(bucket.skuFirstSeen)) {
      countryVel._firstSeen[sku] = dt.toISOString();
    }
    velocity._byCountry[country] = countryVel;
  }

  return { ok: true, data: velocity };
}

async function fetchShopifyOpenDemand(storeKey) {
  const store = SHOPIFY_STORES[storeKey];
  if (!store || !store.token) return { ok: false, data: {} };

  const openDemand = {};
  let url = `/admin/api/2026-01/orders.json?status=open&limit=250&fields=id,financial_status,shipping_address,line_items`;

  for (let page = 1; page <= 40; page++) {
    try {
      const { body, headers } = await apiRequest({
        hostname: store.domain,
        path: url,
        headers: { 'X-Shopify-Access-Token': store.token }
      });
      const orders = body.orders || [];
      if (orders.length === 0) break;

      for (const o of orders) {
        if (o.financial_status === 'refunded' || o.financial_status === 'voided') continue;
        const rawCountry = (o.shipping_address?.country_code || o.shipping_address?.country || '').toString().trim();
        if (!rawCountry) continue;
        const country = rawCountry.length === 2 ? rawCountry.toUpperCase() : rawCountry;
        if (!openDemand[country]) openDemand[country] = {};
        for (const li of (o.line_items || [])) {
          if (!li.sku) continue;
          const qty = Number(li.fulfillable_quantity ?? li.current_quantity ?? li.quantity ?? 0);
          if (qty <= 0) continue;
          openDemand[country][li.sku] = (openDemand[country][li.sku] || 0) + qty;
        }
      }

      const link = headers.link || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      if (!nextMatch) break;
      url = new URL(nextMatch[1]).pathname + new URL(nextMatch[1]).search;
    } catch (e) {
      console.error(`Shopify open demand ${storeKey} error:`, e.message);
      return { ok: false, data: {} };
    }
  }

  return { ok: true, data: openDemand };
}

// ===== SHOPIFY: FETCH INVENTORY LEVELS =====
async function fetchShopifyInventory(storeKey) {
  const store = SHOPIFY_STORES[storeKey];
  if (!store || !store.token) { console.log('ShopifyInv: no store/token for ' + storeKey); return { ok: false, data: {} }; }

  console.log('ShopifyInv: fetching from ' + store.domain);
  const inventory = {};
  const inactive = new Set();
  let url = `/admin/api/2026-01/products.json?limit=250&fields=id,status,variants`;

  for (let page = 1; page <= 20; page++) {
    try {
      const { body, headers } = await apiRequest({
        hostname: store.domain,
        path: url,
        headers: { 'X-Shopify-Access-Token': store.token }
      });
      const products = body.products || [];
      if (products.length === 0) break;

      for (const p of products) {
        const pStatus = p.status || 'active';
        for (const v of (p.variants || [])) {
          if (v.sku) {
            inventory[v.sku] = (inventory[v.sku] || 0) + (v.inventory_quantity || 0);
            if (pStatus !== 'active') inactive.add(v.sku);
          }
        }
      }

      const link = headers.link || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      if (!nextMatch) break;
      url = new URL(nextMatch[1]).pathname + new URL(nextMatch[1]).search;
    } catch (e) { console.error(`Shopify inventory ${storeKey} error:`, e.message); return { ok: false, data: {} }; }
  }
  inventory.__inactive__ = [...inactive];
  const realSkus = Object.keys(inventory).filter(k => !k.startsWith('__'));
  console.log('ShopifyInv ' + storeKey + ': ' + realSkus.length + ' SKUs fetched');
  return { ok: true, data: inventory };
}

// ===== FULL DATA REFRESH =====
async function refreshAllData(forceCin7 = false) {
  if (refreshPromise) {
    console.log('Refresh already in progress - reusing existing run');
    return refreshPromise;
  }

  refreshPromise = (async () => {
    console.log('Starting full data refresh...');
    const start = Date.now();
    try {
      const nowIso = new Date().toISOString();
      const [lifelyVelRes, cushieVelRes, littleLifelyVelRes, lifelyInvRes, cushieInvRes, littleLifelyInvRes, lifelyOpenDemandRes, cushieOpenDemandRes, littleLifelyOpenDemandRes] = await Promise.all([
        fetchShopifyVelocity('lifely'),
        fetchShopifyVelocity('cushie'),
        fetchShopifyVelocity('littlelifely'),
        fetchShopifyInventory('lifely'),
        fetchShopifyInventory('cushie'),
        fetchShopifyInventory('littlelifely'),
        fetchShopifyOpenDemand('lifely'),
        fetchShopifyOpenDemand('cushie'),
        fetchShopifyOpenDemand('littlelifely')
      ]);

      let cin7Products = {};
      let cin7StockByBranch = {};
      let cin7POs = [];
      let fetchedCin7Count = 0;
      let fetchedPoCount = 0;
      const cin7SkipReason = getCin7SkipReason(forceCin7);

      if (cin7SkipReason) {
        console.log(`Skipping CIN7 refresh, ${cin7SkipReason}. Reusing cached CIN7 data.`);
      } else {
        const cin7Data = await fetchCin7AllProducts();
        cin7Products = cin7Data.products || {};
        cin7StockByBranch = cin7Data.stockByBranch || {};
        cin7POs = await fetchCin7POs();
        fetchedCin7Count = Object.keys(cin7Products).length;
        fetchedPoCount = cin7POs.length;
      }

      const nextCache = {
        ...dataCache,
        shopifyVelocity: { ...(dataCache.shopifyVelocity || {}) },
        shopifyVelocityByCountry: { ...(dataCache.shopifyVelocityByCountry || {}) },
        shopifyInventory: { ...(dataCache.shopifyInventory || {}) },
        shopifyOpenDemand: { ...(dataCache.shopifyOpenDemand || {}) }
      };

      let cin7Updated = false;
      let shopifyUpdated = false;

      if (fetchedCin7Count > 0) {
        nextCache.cin7Products = cin7Products;
        nextCache.cin7StockByBranch = cin7StockByBranch;
        nextCache.lastCin7Refresh = nowIso;
        cin7BackoffUntil = 0;
        if (cin7RecoveryTimer) {
          clearTimeout(cin7RecoveryTimer);
          cin7RecoveryTimer = null;
        }
        cin7Updated = true;
      } else if (Object.keys(dataCache.cin7Products).length > 0) {
        console.warn(`CIN7 products returned empty - preserving existing cache (${Object.keys(dataCache.cin7Products).length} SKUs)`);
      }

      if (fetchedPoCount > 0) {
        nextCache.cin7POs = cin7POs;
        nextCache.lastCin7Refresh = nowIso;
        nextCache.lastPoRefresh = nowIso;
        cin7Updated = true;
      } else if (dataCache.cin7POs.length > 0) {
        console.warn(`CIN7 POs returned empty - preserving existing cache (${dataCache.cin7POs.length} POs)`);
      }

      const shopifyResults = [
        ['lifely', lifelyVelRes, lifelyInvRes, lifelyOpenDemandRes],
        ['cushie', cushieVelRes, cushieInvRes, cushieOpenDemandRes],
        ['littlelifely', littleLifelyVelRes, littleLifelyInvRes, littleLifelyOpenDemandRes]
      ];
      for (const [storeKey, velRes, invRes, demandRes] of shopifyResults) {
        if (velRes.ok) {
          nextCache.shopifyVelocity[storeKey] = velRes.data;
          nextCache.shopifyVelocityByCountry[storeKey] = velRes.data._byCountry || {};
          shopifyUpdated = true;
        }
        if (invRes.ok) {
          nextCache.shopifyInventory[storeKey] = invRes.data;
          shopifyUpdated = true;
        }
        if (demandRes.ok) {
          nextCache.shopifyOpenDemand[storeKey] = demandRes.data;
          shopifyUpdated = true;
        }
      }
      if (shopifyUpdated) nextCache.lastShopifyRefresh = nowIso;

      if (cin7Updated || shopifyUpdated) {
        nextCache.error = Object.keys(nextCache.cin7Products || {}).length > 0 ? null : 'CIN7 data unavailable (likely rate limited)';
        dataCache = nextCache;
        saveCacheSnapshot(true, cin7Updated ? 'daily-cin7-refresh' : 'shopify-refresh');
        loadCacheSnapshot(true);
        if (cin7Updated) refreshAIS();
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const liveCin7Count = Object.keys(dataCache.cin7Products).length;
      const livePoCount = dataCache.cin7POs.length;
      console.log(`Data refresh complete in ${elapsed}s. Fetched CIN7: ${fetchedCin7Count} SKUs, ${fetchedPoCount} POs. Live cache: ${liveCin7Count} SKUs, ${livePoCount} POs.`);
    } catch (e) {
      console.error('Data refresh failed:', e.message);
      dataCache.error = e.message;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ===== SKU NORMALIZATION =====
// CIN7 tracks multi-box products as SKU-1, SKU-2 etc.
// Shopify and sales use the base SKU. We need to merge box variants.
function normalizeCIN7(cin7Raw) {
  const result = {};
  const boxPattern = /^(.+)-(\d)$/;
  const boxGroups = {};

  for (const [sku, data] of Object.entries(cin7Raw)) {
    const match = sku.match(boxPattern);
    if (match) {
      const base = match[1];
      if (!boxGroups[base]) boxGroups[base] = [];
      boxGroups[base].push(data);
    } else {
      // Non-box SKU - keep as-is
      result[sku] = data;
    }
  }

  // For box-split products, buildable = min across all boxes
  for (const [base, boxes] of Object.entries(boxGroups)) {
    const soh = Math.min(...boxes.map(b => typeof b === 'object' ? b.soh : b));
    const available = Math.min(...boxes.map(b => typeof b === 'object' ? (b.available || b.soh) : b));
    // Sum costs across all boxes (each box is a separate shipped piece)
    const costAUD = boxes.reduce((sum, b) => sum + (typeof b === 'object' ? (b.costAUD || 0) : 0), 0);
    const cbm = boxes.reduce((sum, b) => sum + (typeof b === 'object' ? (b.cbm || 0) : 0), 0);
    const option1 = boxes.map(b => typeof b === 'object' ? (b.option1 || '') : '').find(Boolean) || '';
    result[base] = { soh, available, costAUD, cbm, option1 };
  }

  return result;
}

// Radiant: map component SKUs to set SKUs
// Swatch Pack: LLAU-CB-CS-PACK = 1× each swatch colour (6 swatches)
// CIN7 tracks individual swatches: LLAU-CB-CS-{colour}
// PACK SOH = min(all swatch SOH), cost = sum(all swatch costs)
// Individual swatches inherit PACK velocity (they're only sold as a set)
const SWATCH_COLOURS = ['DSBL', 'DGY', 'PST', 'BABL', 'CTCN', 'MSM'];
function normalizeSwatchPack(cin7) {
  const result = { ...cin7 };
  const swatchKeys = SWATCH_COLOURS.map(c => 'LLAU-CB-CS-' + c);
  const sohValues = swatchKeys.map(k => {
    const d = cin7[k];
    return typeof d === 'object' ? (d.soh || 0) : (d || 0);
  });
  const costs = swatchKeys.map(k => {
    const d = cin7[k];
    return typeof d === 'object' ? (d.costAUD || 0) : 0;
  });
  const packSoh = Math.min(...sohValues);
  const packCost = costs.reduce((a, b) => a + b, 0);
  result['LLAU-CB-CS-PACK'] = { soh: packSoh, available: packSoh, costAUD: packCost };
  return result;
}

// Shopify sells: RDNT-{size}-{type}-SET (e.g. RDNT-Q-MF-SET)
// CIN7 tracks: RDNT-{size}-{type} (e.g. RDNT-Q-MF) + RDNT-{size}-BASE
// A SET = BASE + topper. Buildable = min(BASE, topper)
function normalizeRadiant(cin7, shopifySkus) {
  const result = {};
  // Preserve raw RDNT component SKUs so POs and drilldown can resolve them.
  // SET keys are added alongside and used for display/reorder.
  for (const [sku, data] of Object.entries(cin7)) {
    if (sku.startsWith('RDNT-')) result[sku] = data;
  }
  const sizes = ['D', 'K', 'Q'];
  const types = ['S', 'MF', 'F'];

  for (const size of sizes) {
    const baseKey = 'RDNT-' + size + '-BASE';
    const baseSoh = cin7[baseKey]?.soh || cin7[baseKey] || 0;

    for (const type of types) {
      const compKey = 'RDNT-' + size + '-' + type;
      const setKey = compKey + '-SET';
      const compSoh = cin7[compKey]?.soh || cin7[compKey] || 0;

      // Single topper set
      const baseCost = cin7[baseKey]?.costAUD || 0;
      const compCost = cin7[compKey]?.costAUD || 0;
      const baseCbm = cin7[baseKey]?.cbm || 0;
      const compCbm = cin7[compKey]?.cbm || 0;
      result[setKey] = { soh: Math.min(baseSoh, compSoh), available: Math.min(baseSoh, compSoh), costAUD: baseCost + compCost, cbm: baseCbm + compCbm };

      // Multi-topper combos (e.g. RDNT-Q-S-MF-SET = BASE + S + MF)
      for (const type2 of types) {
        if (type2 <= type) continue; // avoid duplicates
        const comp2Key = 'RDNT-' + size + '-' + type2;
        const comboSetKey = 'RDNT-' + size + '-' + type + '-' + type2 + '-SET';
        const comp2Soh = cin7[comp2Key]?.soh || cin7[comp2Key] || 0;
        const comp2Cost = cin7[comp2Key]?.costAUD || 0;
        const comp2Cbm = cin7[comp2Key]?.cbm || 0;
        result[comboSetKey] = { soh: Math.min(baseSoh, compSoh, comp2Soh), available: Math.min(baseSoh, compSoh, comp2Soh), costAUD: baseCost + compCost + comp2Cost, cbm: baseCbm + compCbm + comp2Cbm };
      }
    }

    // Protector
    const protKey = 'RDNT-PROT-' + size;
    if (cin7[protKey]) {
      result[protKey] = cin7[protKey];
    }
  }

  return result;
}

// Cushie: normalize AU SKUs
// CIN7: CUSB-Q-LTGN-1, CUSB-Q-LTGN-2 (box split) + CUSB-ARST-SET-LTGN (armrest sets)
// Shopify: CUSB-Q-LTGN-SET, CUSB-D-LTGN-SET etc.
function normalizeCushie(cin7Normalized) {
  const result = {};
  for (const [sku, data] of Object.entries(cin7Normalized)) {
    // Website sells the set SKU, so standardize dashboard display to -SET.
    if (sku.match(/^CUSB-(TW|D|Q|K)-(LTGN|DNM|TBRN|TWHT)$/) && !sku.includes('-SET')) {
      const setData = typeof data === 'object' ? { ...data } : { soh: data, available: data };
      if (!setData.costAUD && typeof data === 'object') setData.costAUD = data.costAUD || 0;
      result[sku + '-SET'] = setData;
      continue;
    }
    result[sku] = data;
  }
  return result;
}

function normalizeCushiePoItems(items) {
  const result = {};
  for (const [sku, qty] of Object.entries(items || {})) {
    if (sku.match(/^CUSB-(TW|D|Q|K)-(LTGN|DNM|TBRN|TWHT)$/) && !sku.includes('-SET')) {
      result[sku + '-SET'] = (result[sku + '-SET'] || 0) + qty;
      continue;
    }
    result[sku] = (result[sku] || 0) + qty;
  }
  return result;
}


// ===== BUILD CK DATA FROM CACHE =====
function buildCKData(ckId) {
  const def = CK_DEFS[ckId];
  if (!def) return null;

  const prefix = def.prefix;
  const storeKey = def.store;
  const poDestination = def.poDestination || null;
  const salesCountry = def.salesCountry || null;
  const stockBranches = def.stockBranches || null;
  const strictStockBranches = !!(stockBranches && Array.isArray(stockBranches)) || !!def.strictStockBranches;
  const relatedStores = getStoreKeysForCk(ckId, storeKey);

  let sizes = def.sizes;
  if (ckId === 'llau') sizes = { ...sizes, 'DD-21915CF': 'Single Mattress', 'DD-21107CF': 'King Single Mattress', 'DD-21137CF': 'Double Mattress' };
  let costs = {};
  // CIN7 stock - first collect raw, then normalize
  const cin7Raw = {};
  for (const [sku, data] of Object.entries(dataCache.cin7Products)) {
    if (skuMatchesDef(sku, def)) {
      if (stockBranches && Array.isArray(stockBranches)) {
        const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
        const branchData = stockBranches.reduce((acc, branchId) => {
          const row = branchRows[branchId];
          if (!row) return acc;
          acc.soh += Number(row.soh || 0);
          acc.available += Number(row.available || 0);
          acc.matched += 1;
          return acc;
        }, { soh: 0, available: 0, matched: 0 });
        cin7Raw[sku] = branchData.matched > 0
          ? { ...data, soh: branchData.soh, available: branchData.available }
          : { ...data, soh: 0, available: 0 };
      } else {
        cin7Raw[sku] = data;
      }
    }
  }

  // Normalize: merge box-splits, map components to sets
  let cin7Normalized = normalizeCIN7(cin7Raw);

  // Special handling per CK
  if (ckId.startsWith('rdnt')) cin7Normalized = normalizeRadiant(cin7Normalized, Object.keys(dataCache.shopifyInventory[storeKey] || {}));
  if (ckId.startsWith('cusb')) cin7Normalized = normalizeCushie(cin7Normalized);
  if (ckId === 'llau') {
    cin7Normalized = normalizeSwatchPack(cin7Normalized);
    const auMattressSkus = ['DD-21915CF', 'DD-21107CF', 'DD-21137CF'];
    for (const sku of auMattressSkus) {
      const data = dataCache.cin7Products?.[sku];
      if (!data) continue;
      const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
      const branchData = LL_AU_BRANCH_IDS.reduce((acc, branchId) => {
        const row = branchRows[branchId];
        if (!row) return acc;
        acc.soh += Number(row.soh || 0);
        acc.available += Number(row.available || 0);
        acc.matched += 1;
        return acc;
      }, { soh: 0, available: 0, matched: 0 });
      cin7Normalized[sku] = branchData.matched > 0 ? { ...data, soh: branchData.soh, available: branchData.available } : { ...data, soh: 0, available: 0 };
    }
  }

  const cin7 = {};
  const cin7Available = {};
  let cbmMap = {};
  for (const [sku, data] of Object.entries(cin7Normalized)) {
    cin7[sku] = typeof data === 'object' ? data.soh : data;
      if (typeof data === 'object') {
        cin7Available[sku] = Number(data.available || 0);
      }
      if (typeof data === 'object' && data.costAUD) {
        if (!costs) costs = {};
        costs[sku] = data.costAUD;
      }
      if (typeof data === 'object' && data.cbm > 0) {
        cbmMap[sku] = data.cbm;
      }
  }

  // Shopify inventory
  const shopify = {};
  for (const sourceStore of relatedStores) {
    const storeInv = dataCache.shopifyInventory[sourceStore] || {};
    for (const [sku, qty] of Object.entries(storeInv)) {
      if (!skuMatchesDef(sku, def)) continue;
      shopify[sku] = (shopify[sku] || 0) + qty;
    }
  }

  // Country panels should use Shopify open demand split by shipping destination as the preorder source of truth.
  // CIN7 SOH stays branch-filtered from /Stock above, oversold comes from Shopify destination-country demand.
  if (ckId === 'llau' || ckId === 'llau-cbcf' || ckId === 'llnz' || ckId === 'llna' || ckId === 'llca' || ckId === 'lluk' || ckId === 'llsg' || ckId === 'cusb-au' || ckId.startsWith('cusb-au-')) {
    const demandCountry = ckId === 'llau' || ckId === 'llau-cbcf' || ckId === 'cusb-au' || ckId.startsWith('cusb-au-')
      ? 'AU'
      : ckId === 'llca'
        ? 'CA'
        : ckId === 'llnz'
          ? 'NZ'
          : ckId === 'lluk'
            ? 'GB'
            : ckId === 'llsg'
              ? 'SG'
              : 'US';
    for (const sku of Object.keys(cin7)) {
      let totalOpenDemand = relatedStores.reduce((sum, sourceStore) => {
        return sum + Number(dataCache.shopifyOpenDemand?.[sourceStore]?.[demandCountry]?.[sku] || 0);
      }, 0);
      if (ckId === 'llau' && sku.startsWith('DD-21')) {
        const comboMap = { 'DD-21915CF': 'LLAU-CBCF-S-', 'DD-21107CF': 'LLAU-CBCF-KS-', 'DD-21137CF': 'LLAU-CBCF-D-' };
        const comboPrefix = comboMap[sku];
        if (comboPrefix) {
          for (const sourceStore of relatedStores) {
            const countryDemand = dataCache.shopifyOpenDemand?.[sourceStore]?.[demandCountry] || {};
            for (const [demandSku, qty] of Object.entries(countryDemand)) {
              if (demandSku.startsWith(comboPrefix)) totalOpenDemand += Number(qty || 0);
            }
          }
        }
      }
      shopify[sku] = -totalOpenDemand;
    }
  }

  // Velocity
  const velocity = {};
  const mergeVelocitySource = (source) => {
    for (const [sku, vel] of Object.entries(source || {})) {
      if (sku.startsWith('_')) continue;
      if (!skuMatchesDef(sku, def)) continue;
      velocity[sku] = (velocity[sku] || 0) + vel;
    }
  };

  if (salesCountry) {
    for (const sourceStore of relatedStores) {
      mergeVelocitySource(dataCache.shopifyVelocityByCountry?.[sourceStore]?.[salesCountry] || {});
    }
  } else {
    for (const sourceStore of relatedStores) {
      mergeVelocitySource(dataCache.shopifyVelocity?.[sourceStore] || {});
    }
  }

  // LLNA/LLCA dashboards: absorb dropship combo demand into the matching stocked bed SKU.
  // This affects the visible Shopify / Net / velocity metrics, not just coverage columns.
  if (ckId === 'llna' || ckId === 'llca') {
    for (const sku of Object.keys(cin7)) {
      if (!sku.startsWith('LLNA-CB-')) continue;
      const comboSku = sku.replace('LLNA-CB-', 'LLNA-CFDS-');
      const comboDemand = Math.max(-(shopify[comboSku] || 0), 0);
      if (comboDemand > 0) {
        shopify[sku] = (shopify[sku] || 0) - comboDemand;
        shopify[comboSku] = 0;
      }
      if (velocity[comboSku]) {
        velocity[sku] = (velocity[sku] || 0) + velocity[comboSku];
        velocity[comboSku] = 0;
      }
    }
  }

  if (ckId === 'llau') {
    const mattressVelocityMap = { 'DD-21915CF': 'LLAU-CBCF-S-', 'DD-21107CF': 'LLAU-CBCF-KS-', 'DD-21137CF': 'LLAU-CBCF-D-' };
    for (const [mattressSku, comboPrefix] of Object.entries(mattressVelocityMap)) {
      for (const [sku, vel] of Object.entries({ ...velocity })) {
        if (sku.startsWith(comboPrefix)) velocity[mattressSku] = (velocity[mattressSku] || 0) + vel;
      }
    }
  }

  // Swatch pack: propagate PACK velocity to individual swatches
  if (ckId === 'llau' && velocity['LLAU-CB-CS-PACK']) {
    const packVel = velocity['LLAU-CB-CS-PACK'];
    for (const colour of SWATCH_COLOURS) {
      const swatchKey = 'LLAU-CB-CS-' + colour;
      if (cin7[swatchKey] !== undefined) {
        velocity[swatchKey] = packVel; // each swatch consumed at pack rate
      }
    }
  }

  // Purchase Orders (open = for incoming calculations, all = for PO tab)
  const pos = [];
  const allPos = [];
  for (const po of dataCache.cin7POs) {
    if (poDestination && resolvePoDestination(po) !== poDestination) continue;
    const relevantItems = {};
    for (const [sku, qty] of Object.entries(po.items)) {
      if (skuMatchesDef(sku, def, po.itemOption1?.[sku]) || (ckId === 'llau' && ['DD-21915CF','DD-21107CF','DD-21137CF'].includes(sku))) {
        relevantItems[sku] = qty;
      }
    }
    if (Object.keys(relevantItems).length > 0) {
      const normalizedPoItems = ckId.startsWith('cusb') ? normalizeCushiePoItems(relevantItems) : relevantItems;
      allPos.push({ ...po, items: relevantItems, analyticsItems: normalizedPoItems });
      if (isOpenPO(po)) {
        pos.push({ ...po, items: relevantItems, analyticsItems: normalizedPoItems });
      }
    }
  }

  // Build human-readable names from SKU + best-known supplier by SKU from CIN7 POs
  const names = {};
  const suppliers = {};
  const allSkus = new Set([...Object.keys(cin7), ...Object.keys(velocity), ...Object.keys(shopify)]);
  for (const sku of allSkus) {
    names[sku] = sku; // Default to SKU code; frontend can prettify
  }
  for (const po of dataCache.cin7POs || []) {
    const company = po.company || '';
    if (!company) continue;
    for (const sku of Object.keys(po.items || {})) {
      if (skuMatchesDef(sku, def, po.itemOption1?.[sku]) || (ckId === 'llau' && ['DD-21915CF','DD-21107CF','DD-21137CF'].includes(sku))) {
        if (!suppliers[sku]) suppliers[sku] = company;
      }
    }
  }

  // BOM/preorder support for Little Lifely panels.
  // AU/NZ/UK use this for component-level coverage; all Little Lifely country
  // panels use openDemandBySku for the summary preorder breakdown card.
  let coverageAux = null;
  const littleLifelyCoverageConfigs = {
    llau: { demandCountry: 'AU', bedPrefix: 'LLAU-CB-', comboPrefix: 'LLAU-CBCF-', mattressMap: { S: 'DD-21915CF', KS: 'DD-21107CF', D: 'DD-21137CF' }, mattressSkus: ['DD-21915CF', 'DD-21107CF', 'DD-21137CF'] },
    llnz: { demandCountry: 'NZ', bedPrefix: 'LLAU-CB-', comboPrefix: 'LLAU-CBCF-', mattressMap: { S: 'DD-21915CF', KS: 'DD-21107CF', D: 'DD-21137CF' }, mattressSkus: ['DD-21915CF', 'DD-21107CF', 'DD-21137CF'] },
    llna: { demandCountry: 'US', bedPrefix: 'LLNA-CB-', comboPrefix: 'LLNA-CFDS-', mattressMap: {}, mattressSkus: [] },
    llca: { demandCountry: 'CA', bedPrefix: 'LLNA-CB-', comboPrefix: 'LLNA-CFDS-', mattressMap: {}, mattressSkus: [] },
    lluk: { demandCountry: 'GB', bedPrefix: 'LLUK-CB-', comboPrefix: 'LLUK-CBDS-', mattressMap: { S: 'DD-21107CF', SD: 'DD-21137CF', D: 'DD-21153CF' }, mattressSkus: ['DD-21107CF', 'DD-21137CF', 'DD-21153CF'] },
    llsg: { demandCountry: 'SG', bedPrefix: 'LLSG-CB-', comboPrefix: 'LLSG-CFDS-', mattressMap: {}, mattressSkus: [] }
  };
  const coverageConfig = littleLifelyCoverageConfigs[ckId];
  if (coverageConfig) {
    const openDemandBySku = {};
    for (const sourceStore of relatedStores) {
      for (const [sku, qty] of Object.entries(dataCache.shopifyOpenDemand?.[sourceStore]?.[coverageConfig.demandCountry] || {})) {
        openDemandBySku[sku] = (openDemandBySku[sku] || 0) + Number(qty || 0);
      }
    }
    const stockBySku = {};
    for (const sku of coverageConfig.mattressSkus) {
      const data = dataCache.cin7Products?.[sku];
      if (!data) continue;
      const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
      const branchData = (stockBranches || []).reduce((acc, branchId) => {
        const row = branchRows[branchId];
        if (!row) return acc;
        acc.soh += Number(row.soh || 0);
        acc.available += Number(row.available || 0);
        return acc;
      }, { soh: 0, available: 0 });
      stockBySku[sku] = { soh: branchData.soh, available: branchData.available };
    }
    const poRows = {};
    for (const po of dataCache.cin7POs || []) {
      if (!isOpenPO(po)) continue;
      if (poDestination && resolvePoDestination(po) !== poDestination) continue;
      const etaRaw = po.arrival || po.estimatedArrivalDate || null;
      for (const [sku, qty] of Object.entries(po.items || {})) {
        if (!(sku.startsWith(coverageConfig.bedPrefix) || sku.startsWith(coverageConfig.comboPrefix) || coverageConfig.mattressSkus.includes(sku))) continue;
        if (!poRows[sku]) poRows[sku] = [];
        poRows[sku].push({ reference: po.reference, qty: Number(qty || 0), eta: etaRaw });
      }
    }
    coverageAux = { ...coverageConfig, openDemandBySku, stockBySku, poRows };
  }
  let bomData = null;
  if (ckId === 'llau-cbcf') {
    bomData = {};
    const allCin7 = dataCache.cin7Products;
    const aggregatedShopifyInventory = {};
    const aggregatedShopifyVelocity = {};
    const aggregatedOpenDemand = {};
    for (const sourceStore of relatedStores) {
      for (const [sku, qty] of Object.entries(dataCache.shopifyInventory?.[sourceStore] || {})) {
        if (!sku.startsWith('__')) aggregatedShopifyInventory[sku] = (aggregatedShopifyInventory[sku] || 0) + qty;
      }
      for (const [sku, vel] of Object.entries(dataCache.shopifyVelocity?.[sourceStore] || {})) {
        if (!sku.startsWith('_')) aggregatedShopifyVelocity[sku] = (aggregatedShopifyVelocity[sku] || 0) + vel;
      }
      for (const [sku, qty] of Object.entries(dataCache.shopifyOpenDemand?.[sourceStore]?.['AU'] || {})) {
        aggregatedOpenDemand[sku] = (aggregatedOpenDemand[sku] || 0) + Number(qty || 0);
      }
    }

    // Get all combo SKUs
    const comboSkus = [...new Set([...Object.keys(velocity), ...Object.keys(cin7)])];

    // Component-level aggregation
    const components = {};

    // Get incoming POs for components
    const componentIncoming = {};
    const componentPoRows = {};
    for (const po of dataCache.cin7POs) {
      if (!isOpenPO(po)) continue;
      const etaRaw = po.arrival || po.estimatedArrivalDate || null;
      for (const [sku, qty] of Object.entries(po.items || {})) {
        if (sku.startsWith('LLAU-CB-') && !sku.includes('CBCF')) {
          componentIncoming[sku] = (componentIncoming[sku] || 0) + qty;
          if (!componentPoRows[sku]) componentPoRows[sku] = [];
          componentPoRows[sku].push({ reference: po.reference, qty, eta: etaRaw });
        }
        if (sku.startsWith('DD-21')) {
          componentIncoming[sku] = (componentIncoming[sku] || 0) + qty;
          if (!componentPoRows[sku]) componentPoRows[sku] = [];
          componentPoRows[sku].push({ reference: po.reference, qty, eta: etaRaw });
        }
      }
    }

    for (const comboSku of comboSkus) {
      const bom = explodeComboBOM(comboSku);
      if (!bom) continue;

      const comboVel = velocity[comboSku] || 0;

      // Bed component
      if (!components[bom.bed]) {
        const bedData = allCin7[bom.bed] || {};
        const bedSoh = typeof bedData === 'object' ? (bedData.soh || 0) : (bedData || 0);
        const standaloneVel = aggregatedShopifyVelocity[bom.bed] || 0;
        const shopifyInv = aggregatedShopifyInventory[bom.bed] || 0;
        const standalonePreorders = aggregatedOpenDemand[bom.bed] || 0;
        components[bom.bed] = {
          soh: bedSoh,
          standaloneDemand: standaloneVel,
          comboDemand: 0,
          totalDemand: standaloneVel,
          incoming: componentIncoming[bom.bed] || 0,
          shopifyInv: shopifyInv,
          standalonePreorders,
          comboPreorders: 0,
          totalPreorders: standalonePreorders,
          standaloneOversold: -standalonePreorders,
          comboOversold: 0,
          combos: [],
          type: 'bed',
          size: getComboSize(comboSku)
        };
      }
      components[bom.bed].comboDemand += comboVel * bom.bedQty;
      components[bom.bed].totalDemand = components[bom.bed].standaloneDemand + components[bom.bed].comboDemand;
      // Combo oversold: from combo Shopify inventory
      const comboOpenDemand = aggregatedOpenDemand[comboSku] || 0;
      if (comboOpenDemand > 0) {
        components[bom.bed].comboPreorders += comboOpenDemand;
        components[bom.bed].comboOversold -= comboOpenDemand;
      }
      components[bom.bed].totalPreorders = components[bom.bed].standalonePreorders + components[bom.bed].comboPreorders;
      components[bom.bed].combos.push(comboSku);

      // Mattress component (dedicated to combos - 0 standalone demand)
      if (!components[bom.mattress]) {
        const mattData = allCin7[bom.mattress] || {};
        const mattSoh = typeof mattData === 'object' ? (mattData.soh || 0) : (mattData || 0);
        const mattressStandaloneVel = aggregatedShopifyVelocity[bom.mattress] || 0;
        const mattressStandalonePreorders = aggregatedOpenDemand[bom.mattress] || 0;
        components[bom.mattress] = {
          soh: mattSoh,
          standaloneDemand: mattressStandaloneVel,
          comboDemand: 0,
          totalDemand: mattressStandaloneVel,
          incoming: componentIncoming[bom.mattress] || 0,
          shopifyInv: aggregatedShopifyInventory[bom.mattress] || 0,
          standalonePreorders: mattressStandalonePreorders,
          comboPreorders: 0,
          totalPreorders: mattressStandalonePreorders,
          standaloneOversold: -mattressStandalonePreorders,
          comboOversold: 0,
          combos: [],
          type: 'mattress',
          size: getComboSize(comboSku)
        };
      }
      components[bom.mattress].comboDemand += comboVel * bom.mattressQty;
      components[bom.mattress].totalDemand = components[bom.mattress].standaloneDemand + components[bom.mattress].comboDemand;
      if (comboOpenDemand > 0) {
        components[bom.mattress].comboPreorders += comboOpenDemand;
        components[bom.mattress].comboOversold -= comboOpenDemand;
      }
      components[bom.mattress].totalPreorders = components[bom.mattress].standalonePreorders + components[bom.mattress].comboPreorders;
      components[bom.mattress].combos.push(comboSku);
    }

    // Calculate per-size bundle ATP and binding constraints
    const sizeData = {}; // S, KS, D
    for (const size of ['S', 'KS', 'D']) {
      const mattressSku = COMBO_BOM.mattress[size];
      const matt = components[mattressSku];
      const beds = Object.entries(components).filter(([k,v]) => v.type === 'bed' && v.size === size);

      // Total bed available for this size = sum of all colour bed SOH
      const totalBedSOH = beds.reduce((t, [k,v]) => t + v.soh, 0);
      const totalBedIncoming = beds.reduce((t, [k,v]) => t + v.incoming, 0);
      const totalBedDemand = beds.reduce((t, [k,v]) => t + v.totalDemand, 0);
      const totalBedOversold = beds.reduce((t, [k,v]) => t + v.standaloneOversold + v.comboOversold, 0);

      const mattSOH = matt ? matt.soh : 0;
      const mattIncoming = matt ? matt.incoming : 0;
      const mattDemand = matt ? matt.totalDemand : 0;

      const bedWks = totalBedDemand > 0 ? totalBedSOH / totalBedDemand : 99;
      const mattWks = mattDemand > 0 ? mattSOH / mattDemand : 99;
      const comboATP = Math.min(totalBedSOH, mattSOH);
      const constraint = bedWks <= mattWks ? 'bed' : 'mattress';

      sizeData[size] = {
        totalBedSOH, totalBedIncoming, totalBedDemand, totalBedOversold,
        mattSOH, mattIncoming, mattDemand, mattressSku,
        bedWks: Math.round(bedWks * 10) / 10,
        mattWks: Math.round(mattWks * 10) / 10,
        comboATP,
        constraint,
        beds: Object.fromEntries(beds)
      };
    }

    bomData._components = components;
    bomData._sizeData = sizeData;
    bomData._componentIncoming = componentIncoming;
    bomData._componentPoRows = componentPoRows;
    bomData._sizeOrder = ['S', 'KS', 'D'];
    bomData._sizeLabels = { 'S': 'Single', 'KS': 'King Single', 'D': 'Double' };
    bomData._summary = {
      primaryType: 'mattress',
      stockLabel: 'Combo SOH',
      stockSub: 'Mattress stock (binding constraint)',
      incomingSub: 'Mattress POs',
      oversoldSub: 'Combo pre-orders',
      weeksSub: 'At combo velocity'
    };
  }

  if (ckId === 'cocoon') {
    const allCin7 = dataCache.cin7Products || {};
    const aggregatedShopifyInventory = {};
    const aggregatedShopifyVelocity = {};
    const componentStats = {};
    const componentCin7 = {};
    const componentShopify = {};
    const componentVelocity = {};
    const componentSkus = new Set();
    const componentPos = [];
    const componentAllPos = [];
    const sizeLabels = { 'D': 'Double', 'Q': 'Queen', 'K': 'King' };

    const readCin7Sku = (sku) => {
      if (sku.startsWith('COCOON-') && cin7[sku] !== undefined) {
        return { soh: cin7[sku], costAUD: costs[sku] || 0, cbm: cbmMap[sku] || 0 };
      }
      const data = allCin7[sku];
      if (!data) return { soh: 0, costAUD: 0, cbm: 0 };
      if (stockBranches && Array.isArray(stockBranches)) {
        const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
        const branchData = stockBranches.reduce((acc, branchId) => {
          const row = branchRows[branchId];
          if (!row) return acc;
          acc.soh += Number(row.soh || 0);
          acc.available += Number(row.available || 0);
          acc.matched += 1;
          return acc;
        }, { soh: 0, available: 0, matched: 0 });
        if (branchData.matched > 0) return { ...data, soh: branchData.soh, available: branchData.available };
        return { ...data, soh: 0, available: 0 };
      }
      return data;
    };

    const ensureComponent = (sku, meta = {}) => {
      componentSkus.add(sku);
      if (!componentStats[sku]) {
        const data = readCin7Sku(sku) || {};
        const soh = typeof data === 'object' ? Number(data.soh || 0) : Number(data || 0);
        componentStats[sku] = {
          soh,
          standaloneDemand: 0,
          comboDemand: 0,
          totalDemand: 0,
          incoming: 0,
          standaloneOversold: 0,
          comboOversold: 0,
          combos: [],
          type: meta.type || 'component',
          size: meta.size || null
        };
        componentCin7[sku] = soh;
        componentShopify[sku] = 0;
        componentVelocity[sku] = 0;
        names[sku] = sku;
        if (typeof data === 'object' && data.costAUD) costs[sku] = data.costAUD;
        if (typeof data === 'object' && data.cbm > 0) cbmMap[sku] = data.cbm;
      }
      if (meta.type) componentStats[sku].type = meta.type;
      if (meta.size) componentStats[sku].size = meta.size;
      return componentStats[sku];
    };

    const addStandalone = (sku, vel, oversold, meta = {}) => {
      const c = ensureComponent(sku, meta);
      c.standaloneDemand += vel;
      c.standaloneOversold += oversold;
    };

    const addCombo = (sku, vel, oversold, comboSku, meta = {}) => {
      const c = ensureComponent(sku, meta);
      c.comboDemand += vel;
      c.comboOversold += oversold;
      if (comboSku && !c.combos.includes(comboSku)) c.combos.push(comboSku);
    };

    for (const sourceStore of relatedStores) {
      for (const [sku, qty] of Object.entries(dataCache.shopifyInventory?.[sourceStore] || {})) {
        if (!sku.startsWith('__')) aggregatedShopifyInventory[sku] = (aggregatedShopifyInventory[sku] || 0) + qty;
      }
      for (const [sku, vel] of Object.entries(dataCache.shopifyVelocity?.[sourceStore] || {})) {
        if (!sku.startsWith('_')) aggregatedShopifyVelocity[sku] = (aggregatedShopifyVelocity[sku] || 0) + vel;
      }
    }

    for (const [sku, vel] of Object.entries(aggregatedShopifyVelocity)) {
      const oversold = Math.min(aggregatedShopifyInventory[sku] || 0, 0);

      if (sku.match(/^COCOON-(DOUBLE|QUEEN|KING)-/) && !sku.includes('-CV') && !sku.startsWith('COCOON-RDNT-')) {
        const size = sku.includes('-DOUBLE-') ? 'D' : sku.includes('-QUEEN-') ? 'Q' : sku.includes('-KING-') ? 'K' : null;
        addStandalone(sku, vel, oversold, { type: 'bed', size });
        continue;
      }

      const radiantSet = explodeRadiantSetSku(sku);
      if (radiantSet) {
        for (const componentSku of radiantSet.components) {
          addStandalone(componentSku, vel, oversold, { type: 'mattress', size: radiantSet.size });
        }
        continue;
      }

      const cocoonCombo = explodeCocoonRadiantCombo(sku);
      if (cocoonCombo) {
        addCombo(cocoonCombo.bed, vel, oversold, sku, { type: 'bed', size: cocoonCombo.size });
        for (const componentSku of cocoonCombo.mattressComponents) {
          addCombo(componentSku, vel, oversold, sku, { type: 'mattress', size: cocoonCombo.size });
        }
      }
    }

    for (const sku of Object.keys(cin7)) {
      if (sku.match(/^COCOON-(DOUBLE|QUEEN|KING)-/) && !sku.includes('-CV')) {
        const size = sku.includes('-DOUBLE-') ? 'D' : sku.includes('-QUEEN-') ? 'Q' : sku.includes('-KING-') ? 'K' : null;
        ensureComponent(sku, { type: 'bed', size });
      }
    }

    for (const sku of Object.keys(allCin7)) {
      if (sku.match(/^RDNT-(D|Q|K)-(BASE|S|MF|F)$/)) {
        const size = sku.split('-')[1];
        ensureComponent(sku, { type: 'mattress', size });
      }
    }

    const normalizePoSku = (sku) => {
      if (sku.match(/^COCOON-(DOUBLE|QUEEN|KING)-[A-Z]+-[12]$/)) return sku.replace(/-[12]$/, '');
      return sku;
    };

    for (const po of dataCache.cin7POs || []) {
      if (poDestination && resolvePoDestination(po) !== poDestination) continue;
      const poOpen = isOpenPO(po);
      const relevantItems = {};
      for (const [rawSku, qty] of Object.entries(po.items || {})) {
        const sku = normalizePoSku(rawSku);
        if (!componentSkus.has(sku)) continue;
        relevantItems[sku] = (relevantItems[sku] || 0) + qty;
        ensureComponent(sku);
        if (poOpen) componentStats[sku].incoming += qty;
      }
      if (Object.keys(relevantItems).length > 0) {
        componentAllPos.push({ ...po, items: relevantItems });
        if (poOpen) componentPos.push({ ...po, items: relevantItems });
      }
    }

    for (const sku of Object.keys(componentStats)) {
      const c = componentStats[sku];
      c.totalDemand = c.standaloneDemand + c.comboDemand;
      c.totalOversold = c.standaloneOversold + c.comboOversold;
      c.totalPreorders = Math.max(-c.totalOversold, 0);
      componentVelocity[sku] = c.totalDemand;
      componentShopify[sku] = c.totalOversold;
    }

    // Keep the main Cocoon tab category-pure: COCOON Option1 rows stay in the
    // primary table. Radiant mattress/base rows are required components for
    // Cocoon+Radiant bundles, so expose them as a separate component panel like
    // Little Lifely exposes DD mattress dependency separately from LL beds.
    sizes = {
      '-DOUBLE-': 'Double',
      '-QUEEN-': 'Queen',
      '-KING-': 'King'
    };

    bomData = {
      _components: componentStats,
      _sizeOrder: ['D', 'Q', 'K'],
      _sizeLabels: sizeLabels,
      _separateFromMain: true,
      _title: 'Cocoon required components',
      _componentsSub: 'Radiant mattress/base requirements shown separately from Cocoon category rows',
      _summary: {
        primaryType: 'mattress',
        stockLabel: 'Radiant Component SOH',
        stockSub: 'Radiant mattress/base components',
        incomingSub: 'Radiant component POs',
        oversoldSub: 'Radiant + Cocoon combo commitments',
        weeksSub: 'At total component velocity'
      }
    };
  }

  let reorderBomData = null;
  if (ckId === 'cusb-au-snuggle') {
    const microStats = {};
    const microCin7 = {};
    const microShopify = {};
    const microVelocity = {};
    const microIncoming = {};
    const sizeLabels = { 'ARST': 'Armrest', '-TW-': 'Twin', '-D-': 'Double', '-Q-': 'Queen', '-K-': 'King' };
    const boxBases = new Set();

    for (const sku of Object.keys(cin7Raw || {})) {
      const m = sku.match(/^(CUSB-(TW|D|Q|K)-(LTGN|DNM|TBRN|TWHT))-(1|2)$/);
      if (m) boxBases.add(m[1]);
    }

    const shouldSkipMicroSku = (sku) => {
      if (!sku || !sku.startsWith('CUSB')) return true;
      if (sku.includes('-UK') || sku.includes('SGE')) return true;
      if (sku.endsWith('-SET')) return true;
      if (boxBases.has(sku)) return true;
      return false;
    };

    const ensureMicro = (sku) => {
      if (!microStats[sku]) {
        const data = cin7Raw?.[sku] || {};
        const soh = typeof data === 'object' ? Number(data.soh || 0) : Number(data || 0);
        microStats[sku] = { soh, incoming: 0, standaloneDemand: 0, standaloneOversold: 0, totalDemand: 0 };
        microCin7[sku] = soh;
        microShopify[sku] = 0;
        microVelocity[sku] = 0;
      }
      return microStats[sku];
    };

    const explodeSnuggleSetSku = (sku) => {
      const m = sku.match(/^(CUSB-(TW|D|Q|K)-(LTGN|DNM|TBRN|TWHT))-SET$/);
      if (!m) return null;
      const base = m[1];
      const components = [];
      if (cin7Raw?.[base + '-1'] !== undefined) components.push(base + '-1');
      if (cin7Raw?.[base + '-2'] !== undefined) components.push(base + '-2');
      if (!components.length) components.push(base);
      if (cin7Raw?.[base + '-CV'] !== undefined) components.push(base + '-CV');
      return components;
    };

    for (const sku of Object.keys(cin7Raw || {})) {
      if (shouldSkipMicroSku(sku)) continue;
      ensureMicro(sku);
    }

    for (const [sku, vel] of Object.entries(velocity || {})) {
      if (sku.startsWith('_')) continue;
      const oversold = Math.min(shopify?.[sku] || 0, 0);
      const exploded = explodeSnuggleSetSku(sku);
      if (exploded) {
        for (const componentSku of exploded) {
          const c = ensureMicro(componentSku);
          c.standaloneDemand += vel;
          c.standaloneOversold += oversold;
        }
        continue;
      }
      if (sku.startsWith('CUSB') && !sku.includes('-UK') && !sku.includes('SGE')) {
        const c = ensureMicro(sku);
        c.standaloneDemand += vel;
        c.standaloneOversold += oversold;
      }
    }

    for (const po of dataCache.cin7POs || []) {
      if (poDestination && resolvePoDestination(po) !== poDestination) continue;
      if (!isOpenPO(po)) continue;
      for (const [sku, qty] of Object.entries(po.items || {})) {
        if (shouldSkipMicroSku(sku)) continue;
        const c = ensureMicro(sku);
        c.incoming += qty;
        microIncoming[sku] = (microIncoming[sku] || 0) + qty;
      }
    }

    for (const sku of Object.keys(microStats)) {
      const c = microStats[sku];
      c.totalDemand = c.standaloneDemand;
      microVelocity[sku] = c.totalDemand;
      microShopify[sku] = c.standaloneOversold;
    }

    reorderBomData = {
      mode: 'micro-bom',
      cin7: microCin7,
      shopify: microShopify,
      velocity: microVelocity,
      incoming: microIncoming,
      sizes: sizeLabels
    };
  }

  // Remove inactive Shopify SKUs (draft/archived)
  const inactiveSet = new Set(relatedStores.flatMap(sourceStore => dataCache.shopifyInventory?.[sourceStore]?.['__inactive__'] || []));
  const keepInactiveForPanel = ckId === 'll-mattresses';
  for (const sku of Object.keys(cin7)) {
    if (!keepInactiveForPanel && inactiveSet.has(sku)) { delete cin7[sku]; delete velocity[sku]; delete shopify[sku]; }
  }
  for (const sku of Object.keys(velocity)) {
    if (!keepInactiveForPanel && inactiveSet.has(sku)) { delete velocity[sku]; }
  }

  // === Per-SKU landed cost calculation ===
  // Source 1: Excel report (SOH Stock Value / SOH Stock Qty) = actual landed cost for existing stock
  // Source 2: CBM-based freight estimation for incoming POs
  // Skip swatches, covers, protectors - only main CK products
  const SKIP_LANDED = sku => /(-CV-|-CV$|-CS-|-CS$|-FS-|PROTECTOR|SWATCH|PACK$|SAMPLE)/i.test(sku);
  const landedCosts = {};

  // Step 1: Load actual landed costs from Excel for all matching SKUs
  for (const sku of Object.keys(cin7)) {
    if (SKIP_LANDED(sku)) continue;
    const fob = (costs ? costs[sku] : 0) || 0;
    const xl = excelLandedCosts[sku];
    if (xl && xl.landedPerUnit > 0) {
      const freightTariff = Math.max(0, xl.landedPerUnit - fob);
      landedCosts[sku] = {
        fob,
        freightPerUnit: freightTariff,
        tariffPerUnit: 0, // combined in freightPerUnit since Excel doesn't split them
        landedPerUnit: xl.landedPerUnit,
        cbm: cbmMap[sku] || 0,
        source: 'actual',
        sohQty: xl.sohQty,
        sohValue: xl.sohValue
      };
    }
  }

  // Step 2: For SKUs NOT in Excel, use CBM-based estimation from open POs
  for (const po of allPos) {
    if (!isOpenPO(po)) continue;
    const destination = inferDestination(po);
    const landed = estimateLandedCost(po, destination);
    const containerFreight = landed.freight || 0;
    const tariffRate = landed.tariffRate || 0;

    // Calculate total CBM for this PO
    let totalPoCbm = 0;
    const skuItems = Object.entries(po.items || {});
    for (const [sku, qty] of skuItems) {
      if (!SKIP_LANDED(sku) && cbmMap[sku]) {
        totalPoCbm += cbmMap[sku] * qty;
      }
    }

    if (totalPoCbm <= 0 || containerFreight <= 0) continue;

    // Allocate freight to each SKU by its CBM share (only for SKUs without Excel data)
    for (const [sku, qty] of skuItems) {
      if (SKIP_LANDED(sku) || !cbmMap[sku]) continue;
      if (landedCosts[sku]?.source === 'actual') continue; // Already have real data

      const skuCbm = cbmMap[sku];
      const cbmShare = (skuCbm * qty) / totalPoCbm;
      const freightForSku = containerFreight * cbmShare / qty; // per unit
      const fob = (costs ? costs[sku] : 0) || 0;
      const tariffPerUnit = fob * tariffRate;
      const landedPerUnit = fob + freightForSku + tariffPerUnit;

      if (!landedCosts[sku]) {
        landedCosts[sku] = { fob, freightPerUnit: freightForSku, tariffPerUnit, landedPerUnit, cbm: skuCbm, source: 'estimated', poCount: 1 };
      } else {
        const lc = landedCosts[sku];
        lc.freightPerUnit = (lc.freightPerUnit * lc.poCount + freightForSku) / (lc.poCount + 1);
        lc.tariffPerUnit = (lc.tariffPerUnit * lc.poCount + tariffPerUnit) / (lc.poCount + 1);
        lc.landedPerUnit = lc.fob + lc.freightPerUnit + lc.tariffPerUnit;
        lc.poCount++;
      }
    }
  }

  let mattressRegions = null;
  if (ckId === 'll-mattresses') {
    const mattressRegionConfigs = {
      AU: {
        skus: ['DD-21915CF', 'DD-21107CF', 'DD-21137CF'],
        branchIds: LL_AU_BRANCH_IDS,
        destination: 'Australia',
        salesCountry: 'AU',
        comboMap: { 'LLAU-CBCF-S-': 'DD-21915CF', 'LLAU-CBCF-KS-': 'DD-21107CF', 'LLAU-CBCF-D-': 'DD-21137CF' }
      },
      NZ: {
        skus: ['DD-21915CF', 'DD-21107CF', 'DD-21137CF'],
        branchIds: LL_NZ_BRANCH_IDS,
        destination: 'New Zealand',
        salesCountry: 'NZ',
        comboMap: { 'LLAU-CBCF-S-': 'DD-21915CF', 'LLAU-CBCF-KS-': 'DD-21107CF', 'LLAU-CBCF-D-': 'DD-21137CF' }
      },
      UK: {
        skus: ['DDUK-2190CF', 'DDUK-21120CF', 'DDUK-21135CF'],
        branchIds: [62444],
        destination: 'United Kingdom',
        salesCountry: 'GB',
        comboMap: { 'LLUK-CBDS-S-': 'DDUK-2190CF', 'LLUK-CBDS-SD-': 'DDUK-21120CF', 'LLUK-CBDS-D-': 'DDUK-21135CF' }
      }
    };
    mattressRegions = Object.fromEntries(Object.entries(mattressRegionConfigs).map(([region, cfg]) => {
      const regionCin7 = {};
      const regionShopify = {};
      const regionVelocity = { _7d: {}, _30d: {}, _weeklyBreakdown: {}, _firstSeen: {} };
      const regionTrendData = {};
      const regionWeeklyData = {};
      for (const sku of cfg.skus) {
        const data = dataCache.cin7Products?.[sku];
        if (!data) continue;
        const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
        const branchData = cfg.branchIds.reduce((acc, branchId) => {
          const row = branchRows[branchId];
          if (!row) return acc;
          acc.soh += Number(row.soh || 0);
          acc.available += Number(row.available || 0);
          acc.matched += 1;
          return acc;
        }, { soh: 0, available: 0, matched: 0 });
        regionCin7[sku] = branchData.matched > 0 ? branchData.soh : 0;
        regionShopify[sku] = 0;
      }

      // Little Lifely mattresses are not sold as standalone Shopify SKUs.
      // Each Little Lifely bed + mattress combo consumes one matching mattress, so
      // drive open demand and velocity from combo line items by shipping country.
      for (const sourceStore of relatedStores) {
        const velSource = dataCache.shopifyVelocityByCountry?.[sourceStore]?.[cfg.salesCountry] || {};
        const demandSource = dataCache.shopifyOpenDemand?.[sourceStore]?.[cfg.salesCountry] || {};

        for (const [comboSku, qty] of Object.entries(demandSource)) {
          const mattressSku = Object.entries(cfg.comboMap).find(([prefix]) => comboSku.startsWith(prefix))?.[1];
          if (!mattressSku) continue;
          regionShopify[mattressSku] = (regionShopify[mattressSku] || 0) - Number(qty || 0);
        }

        for (const [comboSku, vel] of Object.entries(velSource)) {
          if (comboSku.startsWith('_')) continue;
          const mattressSku = Object.entries(cfg.comboMap).find(([prefix]) => comboSku.startsWith(prefix))?.[1];
          if (!mattressSku) continue;
          regionVelocity[mattressSku] = (regionVelocity[mattressSku] || 0) + Number(vel || 0);
          regionVelocity._7d[mattressSku] = (regionVelocity._7d[mattressSku] || 0) + Number(velSource._7d?.[comboSku] || 0);
          regionVelocity._30d[mattressSku] = (regionVelocity._30d[mattressSku] || 0) + Number(velSource._30d?.[comboSku] || 0);
          const firstSeen = velSource._firstSeen?.[comboSku] || null;
          if (firstSeen && (!regionVelocity._firstSeen[mattressSku] || String(firstSeen) < String(regionVelocity._firstSeen[mattressSku]))) {
            regionVelocity._firstSeen[mattressSku] = firstSeen;
          }
          for (const [week, qty] of Object.entries(velSource._weeklyBreakdown?.[comboSku] || {})) {
            if (!regionVelocity._weeklyBreakdown[mattressSku]) regionVelocity._weeklyBreakdown[mattressSku] = {};
            regionVelocity._weeklyBreakdown[mattressSku][week] = (regionVelocity._weeklyBreakdown[mattressSku][week] || 0) + Number(qty || 0);
            if (!regionWeeklyData[mattressSku]) regionWeeklyData[mattressSku] = {};
            regionWeeklyData[mattressSku][week] = (regionWeeklyData[mattressSku][week] || 0) + Number(qty || 0);
          }
        }
      }

      for (const sku of cfg.skus) {
        regionVelocity[sku] = Math.round((Number(regionVelocity._30d[sku] || 0) / 30 * 7) * 10) / 10;
        const wk = regionVelocity._weeklyBreakdown[sku] || {};
        const weekKeys = Object.keys(wk).sort().slice(-5);
        const allWeekKeys = Object.keys(wk).sort();
        const weeksWithSales = allWeekKeys.filter(k => wk[k] > 0);
        let lastInStockVel = null;
        if (weeksWithSales.length >= 2) {
          const lastActive = weeksWithSales.slice(-4);
          const avgSales = lastActive.reduce((t, k) => t + wk[k], 0) / lastActive.length;
          lastInStockVel = Math.round(avgSales * 10) / 10;
        }
        regionTrendData[sku] = {
          v7: Math.round(Number(regionVelocity._7d[sku] || 0) * 10) / 10,
          v30: Math.round((Number(regionVelocity._30d[sku] || 0) / 30 * 7) * 10) / 10,
          sparkline: weekKeys.map(k => wk[k] || 0),
          firstSeen: regionVelocity._firstSeen[sku] || null,
          lastInStockVel
        };
      }

      const regionAllPos = [];
      const regionPos = [];
      for (const po of dataCache.cin7POs || []) {
        if (resolvePoDestination(po) !== cfg.destination) continue;
        const relevantItems = {};
        for (const [sku, qty] of Object.entries(po.items || {})) {
          if (cfg.skus.includes(sku)) relevantItems[sku] = Number(qty || 0);
        }
        if (!Object.keys(relevantItems).length) continue;
        const row = { ...po, items: relevantItems, analyticsItems: relevantItems };
        regionAllPos.push(row);
        if (isOpenPO(po)) regionPos.push(row);
      }
      return [region, { cin7: regionCin7, shopify: regionShopify, velocity: regionVelocity, trendData: regionTrendData, weeklyData: regionWeeklyData, pos: regionPos, allPos: regionAllPos }];
    }));
  }

  return {
    ck: def,
    cin7,
    shopify,
    velocity,
    pos,
    allPos,
    names,
    sizes,
    costs,
    cbmMap,
    suppliers,
    landedCosts,
    coverageAux,
    mattressRegions,
    fx: { USDAUD: fxRate.USDAUD, lastFetch: fxRate.lastFetch },
    trendData: (() => {
      const result = {};
      const allSkus = [...new Set([...Object.keys(cin7), ...Object.keys(velocity)])];
      for (const sku of allSkus) {
        let d7Qty = 0;
        let d30Qty = 0;
        let firstSeenValue = null;
        const wk = {};
        for (const sourceStore of relatedStores) {
          const velSource = salesCountry
            ? dataCache.shopifyVelocityByCountry?.[sourceStore]?.[salesCountry] || {}
            : dataCache.shopifyVelocity?.[sourceStore] || {};
          d7Qty += Number(velSource._7d?.[sku] || 0);
          d30Qty += Number(velSource._30d?.[sku] || 0);
          const fs = velSource._firstSeen?.[sku] || null;
          if (fs && (!firstSeenValue || String(fs) < String(firstSeenValue))) firstSeenValue = fs;
          for (const [week, qty] of Object.entries(velSource._weeklyBreakdown?.[sku] || {})) {
            wk[week] = (wk[week] || 0) + Number(qty || 0);
          }
        }
        const v7 = d7Qty; // already a 7-day total, shown as weekly rate
        const v30 = d30Qty / 30 * 7;
        const weekKeys = Object.keys(wk).sort().slice(-5);
        const sparkline = weekKeys.map(k => wk[k] || 0);
        const allWeekKeys = Object.keys(wk).sort();
        const weeksWithSales = allWeekKeys.filter(k => wk[k] > 0);
        let lastInStockVel = null;
        if (weeksWithSales.length >= 2) {
          const lastActive = weeksWithSales.slice(-4);
          const avgSales = lastActive.reduce((t, k) => t + wk[k], 0) / lastActive.length;
          lastInStockVel = Math.round(avgSales * 10) / 10;
        }
        result[sku] = { v7: Math.round(v7*10)/10, v30: Math.round(v30*10)/10, sparkline, firstSeen: firstSeenValue, lastInStockVel };
      }
      return result;
    })(),
    bomData,
    reorderBomData,
    weeklyData: (() => {
      const result = {};
      const allSkus = [...new Set([...Object.keys(cin7), ...Object.keys(velocity)])];
      const addWeekly = (weekly = {}) => {
        for (const sku of allSkus) {
          if (!weekly[sku]) continue;
          if (!result[sku]) result[sku] = {};
          for (const [week, qty] of Object.entries(weekly[sku])) {
            result[sku][week] = (result[sku][week] || 0) + Number(qty || 0);
          }
        }
      };
      for (const sourceStore of relatedStores) {
        const weekly = salesCountry
          ? dataCache.shopifyVelocityByCountry?.[sourceStore]?.[salesCountry]?._weeklyBreakdown
          : dataCache.shopifyVelocity?.[sourceStore]?._weeklyBreakdown;
        addWeekly(weekly || {});
      }
      return Object.keys(result).length > 0 ? result : null;
    })(),
    lastRefresh: dataCache.lastRefresh,
    lastCin7Refresh: dataCache.lastCin7Refresh,
    lastPoRefresh: dataCache.lastPoRefresh,
    lastShopifyRefresh: dataCache.lastShopifyRefresh
  };
}

// ===== ROUTES =====

// Login
app.post('/api/login', (req, res) => {
  res.status(401).json({ ok: false, error: 'Use Masterhub to open Demand Planner.' });
});

app.get('/sso/masterhub', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const payload = validateMasterhubToken(token, 'demand-planner');
  if (!payload) return res.redirect(MASTERHUB_URL);
  const session = createSession();
  return res.redirect('/?session=' + encodeURIComponent(session));
});

app.get('/login', (req, res) => res.redirect(MASTERHUB_URL));

// Public assets
app.use('/logos', express.static(path.join(__dirname, 'public', 'logos')));

// CK list
function getBrandGroup(id, def) {
  if (id.startsWith('cusb') || id === 'cmss') return { id: 'cushie', name: 'Cushie', logo: 'cushie.png' };
  if (id.startsWith('ll')) return { id: 'little-lifely', name: 'Little Lifely', logo: 'little-lifely.png' };
  if (id === 'case-goods') return { id: 'case-goods', name: 'Case Goods', logo: def.logo };
  if (id === 'lifely-sofa' || id === 'dd' || id === 'cocoon' || id === 'rdnt' || id === 'wfhcr') return { id: 'lifely-home', name: 'Lifely', logo: def.logo };
  return { id: 'other', name: 'Other', logo: def.logo };
}

function getBrandSubgroup(id, def) {
  if (id === 'cusb-au-snuggle' || id === 'cusb-au-lifely' || id === 'cmss') return { id: 'cushie-au', name: 'Cushie AU' };
  if (id === 'cusb-us') return { id: 'cushie-us', name: 'Cushie US' };
  if (id === 'cusb-uk') return { id: 'cushie-uk', name: 'Cushie UK' };
  return null;
}

app.get('/api/ck-list', requireAuth, (req, res) => {
  reloadSnapshotIfNewer();
  const list = Object.entries(CK_DEFS).filter(([id]) => id !== 'llau-cbcf').map(([id, def]) => {
    const data = buildCKData(id);
    const skuCount = data ? Object.keys(data.cin7).length + Object.keys(data.velocity).length : 0;
    const brand = getBrandGroup(id, def);
    const subgroup = getBrandSubgroup(id, def);
    return { id, name: def.name, logo: def.logo, skuCount, brand, subgroup };
  });
  res.json({ list, lastRefresh: dataCache.lastRefresh });
});

// CK data
// Infer destination from CIN7 deliveryCountry, port, or SKU prefixes
const PORT_TO_DEST = {
  'melbourne': 'Australia',
  'sydney': 'Australia',
  'brisbane': 'Australia',
  'toronto': 'Canada',
  'vancouver': 'Canada',
  'felixstowe': 'United Kingdom',
  'southampton': 'United Kingdom',
  'la': 'United States',
  'ny': 'United States',
  'los angeles': 'United States',
  'new york': 'United States',
  'long beach': 'United States',
  'savannah': 'United States',
  'singapore': 'Singapore',
  'auckland': 'New Zealand',
  'tauranga': 'New Zealand',
};
function inferDestination(po) {
  // 1. CIN7 deliveryCountry if filled
  if (po.deliveryCountry) return po.deliveryCountry;
  // 2. Port mapping
  if (po.port) {
    const portLower = po.port.toLowerCase().trim();
    if (PORT_TO_DEST[portLower]) return PORT_TO_DEST[portLower];
  }
  // 3. Delivery city mapping (e.g. Laverton North = Melbourne warehouse = Australia)
  if (po.deliveryCity) {
    const cityLower = po.deliveryCity.toLowerCase().trim();
    if (['laverton north', 'laverton', 'truganina', 'derrimut', 'altona', 'footscray'].includes(cityLower)) return 'Australia';
  }
  // 4. SKU prefix inference
  const skus = Object.keys(po.items || {});
  const dests = new Set();
  for (const sku of skus) {
    const u = sku.toUpperCase();
    if (u.startsWith('LLSG')) dests.add('Singapore');
    else if (u.match(/^(LFSB|CUSB).*-UK/)) dests.add('United Kingdom');
    else if (u.match(/^(V2-|V3-)/)) dests.add('United States');
    else if (u.match(/^LLNA/)) dests.add('United States');
    else if (u.match(/^(LLAU|DD|COCOON|RDNT|WFHCR|CMSS|LIFELY|LFSB|CUSB)/)) dests.add('Australia');
  }
  if (dests.size === 1) return [...dests][0];
  if (dests.size > 1) return [...dests].join(' / ');
  // 5. Fallback: all remaining unmatched POs go to Australia (Melbourne port)
  return 'Australia';
}

// Estimated freight + tariff by destination (from yk's shipping data)
const FREIGHT_TARIFF = {
  'United States':  { freight: 8404, freightCurrency: 'AUD', tariff: 0.19, tariffNote: '19% US tariff' },
  'Canada':         { freight: 8404, freightCurrency: 'AUD', tariff: 0.08, tariffNote: '~8% MFN (⚠️ 188% if upholstered seating)' },
  'United Kingdom': { freight: 7245, freightCurrency: 'AUD', tariff: 0,    tariffNote: '' },
  'Australia':      { freight: 7000, freightCurrency: 'AUD', tariff: 0,    tariffNote: '' },
  'Singapore':      { freight: 2898, freightCurrency: 'AUD', tariff: 0,    tariffNote: '0% (free trade)' },
  'New Zealand':    { freight: 2898, freightCurrency: 'AUD', tariff: 0,    tariffNote: '' },
};

function estimateLandedCost(po, destination) {
  const freightActual = po.freightTotal > 0 ? po.freightTotal : 0;
  const productValue = po.total || 0;
  const productCurrency = po.currencyCode || 'USD';
  const toAud = (value, currency) => {
    const n = Number(value || 0);
    const c = String(currency || 'AUD').toUpperCase();
    if (!n) return 0;
    if (c === 'AUD') return n;
    if (c === 'USD') return n * (fxRate.USDAUD || 1.45);
    return n;
  };
  const productValueAUD = toAud(productValue, productCurrency);
  const dest = FREIGHT_TARIFF[destination];
  const isEstimated = freightActual === 0;
  const freight = freightActual > 0 ? toAud(freightActual, productCurrency) : (dest ? dest.freight : 0);
  const freightCurrency = 'AUD';
  const tariffRate = dest ? dest.tariff : 0;
  const tariffAmount = productValueAUD * tariffRate;
  const tariffNote = dest ? dest.tariffNote : '';
  return { productValueAUD, freight, freightCurrency, tariffRate, tariffAmount, tariffNote, isEstimated, landedTotal: productValueAUD + freight + tariffAmount };
}

// PO Data Quality Score
function scorePO(po) {
  const crd = po.crd || po.etd;
  const isReceived = isReceivedPO(po);
  const isInTransitOrReceived = isReceived || (crd && po.estimatedArrivalDate && new Date(crd) <= new Date() && hasContainerNumber(po) && (po.stage !== 'Draft' && po.stage !== 'Confirmed'));

  let score = 0;
  let maxScore = 0;
  const checks = [];

  // Always evaluated
  const addCheck = (name, points, filled) => { maxScore += points; if (filled) score += points; checks.push({ name, points, filled }); };

  addCheck('Created By', 5, !!po.createdBy);
  addCheck('ETA', 20, !!(po.estimatedArrivalDate || po.arrival));
  addCheck('Original ETA', 15, !!(po.customFields?.orders_1000));
  addCheck('CRD', 15, !!(po.crd || po.etd));
  addCheck('Port', 10, !!po.port);

  // Tracking code: only if in transit or received
  if (isInTransitOrReceived) {
    addCheck('Tracking Code', 15, !!po.trackingCode);
  }

  // Landed costs: check if freightTotal > 0 (actual landed cost entered)
  addCheck('Landed Costs', 10, po.freightTotal > 0);

  // Received-only checks
  if (isReceived) {
    addCheck('Fully Received Date', 5, !!po.fullyReceivedDate);
    addCheck('Invoice Date', 5, !!po.invoiceDate);
    addCheck('Supplier Inv No', 5, !!po.supplierInvoiceReference);
  }

  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  return { score, maxScore, pct, checks };
}

app.get('/api/all-pos', requireAuth, (req, res) => {
  reloadSnapshotIfNewer();
  const sourcePos = dataCache.cin7POs || [];
  const poLineOverrides = loadPoLineOverrides();
  const pos = sourcePos.map(sourcePo => {
    const po = applyPoLineOverride(sourcePo, poLineOverrides);
    const destination = inferDestination(po);
    const landed = estimateLandedCost(po, destination);
    const quality = scorePO(po);
    return {
      id: po.id || po.orderId || po.purchaseOrderId || null,
      reference: po.reference,
      stage: po.stage || '',
      company: po.company || '',
      arrival: po.arrival || null,
      etd: po.etd || null,
      crd: po.crd || po.etd || null,
      estimatedArrivalDate: po.estimatedArrivalDate || null,
      customFields: po.customFields || {},
      trackingCode: po.trackingCode || '',
      containerNumber: extractContainerNumber(po.trackingCode),
      fullyReceivedDate: po.fullyReceivedDate || null,
      total: po.total || 0,
      currencyCode: po.currencyCode || 'USD',
      productTotalAUD: landed.productValueAUD,
      deliveryCountry: destination,
      freight: landed.freight,
      freightCurrency: landed.freightCurrency,
      tariffRate: landed.tariffRate,
      tariffAmount: landed.tariffAmount,
      tariffNote: landed.tariffNote,
      isEstFreight: landed.isEstimated,
      landedTotal: landed.landedTotal,
      createdBy: po.createdBy || null,
      invoiceDate: po.invoiceDate || null,
      supplierInvoiceReference: po.supplierInvoiceReference || '',
      port: po.port || '',
      freightTotal: po.freightTotal || 0,
      quality,
      etaHistory: getPoEtaHistoryRecord(po),
      itemNames: po.itemNames || {},
      itemCategories: cin7Option1CategoriesForPoItems(po.items || {}, po.itemOption1 || {}),
      items: po.items || {}
    };
  });
  res.json({ pos, lastRefresh: dataCache.lastPoRefresh || dataCache.lastRefresh, poSource: CIN7_DATA_SOURCE, poSnapshotExportedAt: null, fx: { USDAUD: fxRate.USDAUD, lastFetch: fxRate.lastFetch } });
});

app.get('/api/ck/:id', requireAuth, (req, res) => {
  reloadSnapshotIfNewer();
  const data = buildCKData(req.params.id);
  if (!data) return res.status(404).json({ error: 'Unknown CK' });
  res.json(data);
});

// Manual refresh
let _lastManualRefresh = 0;
app.post('/api/refresh', requireAuth, async (req, res) => {
  const now = Date.now();
  const cooldown = 10 * 60 * 1000; // 10 min cooldown between manual refreshes
  if (now - _lastManualRefresh < cooldown) {
    const waitMin = Math.ceil((cooldown - (now - _lastManualRefresh)) / 60000);
    return res.json({ ok: false, error: `Please wait ${waitMin} min before refreshing again`, lastRefresh: dataCache.lastRefresh });
  }
  _lastManualRefresh = now;
  // Manual refresh should update Shopify/open demand and reuse the durable CIN7
  // cache when it is already fresh, instead of burning the Cin7 key on every click.
  await refreshAllData(false);
  res.json({ ok: true, lastRefresh: dataCache.lastRefresh });
});

// Chat endpoint
app.post('/api/chat', requireAuth, async (req, res) => {
  reloadSnapshotIfNewer();
  if (!GEMINI_API_KEY) return res.json({ reply: 'Chat is not configured (no Gemini API key).' });

  const { message, history, ckId } = req.body;
  const ckData = ckId ? buildCKData(ckId) : null;

  let context = 'You are a demand planning assistant for Lifely. ';
  if (ckData) {
    context += `Currently viewing: ${ckData.ck.name}. `;
    context += `Stock data: ${JSON.stringify(ckData.cin7).substring(0, 2000)}. `;
    context += `Velocity: ${JSON.stringify(ckData.velocity).substring(0, 1000)}. `;
  }

  const contents = [
    { role: 'user', parts: [{ text: context }] },
    ...(history || []).slice(-10).map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.text }]
    })),
    { role: 'user', parts: [{ text: message }] }
  ];

  try {
    const postData = JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: 4096, temperature: 0.7 }
    });

    const { body } = await apiRequest({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, postData);

    const reply = body?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.';
    res.json({ reply });
  } catch (e) {
    res.json({ reply: `Error: ${e.message}` });
  }
});

// ===== SHIPMENT TRACKER =====

// Supplier → origin mapping
const SUPPLIER_ORIGINS = {
  'GUANGDONG EONJOY': { city: 'Guangzhou', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' },
  'EON Technology': { city: 'Foshan', country: 'China', lat: 23.02, lng: 113.12, port: 'Nansha' },
  'FOSHAN EON': { city: 'Foshan', country: 'China', lat: 23.02, lng: 113.12, port: 'Nansha' },
  'Aibang': { city: 'Dongguan', country: 'China', lat: 23.04, lng: 113.72, port: 'Yantian' },
  'Dongguan Aibang': { city: 'Dongguan', country: 'China', lat: 23.04, lng: 113.72, port: 'Yantian' },
  'NOVA FURNITURE': { city: 'Guangzhou', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' },
  'GUANGDONG NOVA': { city: 'Guangzhou', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' },
  'Nobel Home': { city: 'Shenzhen', country: 'China', lat: 22.54, lng: 114.06, port: 'Yantian' },
  'Nisco': { city: 'Jiangsu', country: 'China', lat: 32.06, lng: 118.77, port: 'Shanghai' },
  'Shenzhen Ouluo': { city: 'Shenzhen', country: 'China', lat: 22.54, lng: 114.06, port: 'Yantian' },
  'VISTATECH': { city: 'Huizhou', country: 'China', lat: 23.11, lng: 114.42, port: 'Yantian' },
  'VISTA CHEN': { city: 'Huizhou', country: 'China', lat: 23.11, lng: 114.42, port: 'Yantian' },
  'Caoxian': { city: 'Heze', country: 'China', lat: 35.24, lng: 115.44, port: 'Qingdao' },
  'Junqi': { city: 'Ganzhou', country: 'China', lat: 25.83, lng: 114.93, port: 'Nansha' },
  'SHIJIAZHUANG': { city: 'Shijiazhuang', country: 'China', lat: 38.04, lng: 114.51, port: 'Tianjin' },
  'Shaoxing': { city: 'Shaoxing', country: 'China', lat: 30.00, lng: 120.58, port: 'Ningbo' },
  'Foshan Jinruili': { city: 'Foshan', country: 'China', lat: 23.02, lng: 113.12, port: 'Nansha' },
  'Windo Living': { city: 'Bangkok', country: 'Thailand', lat: 13.76, lng: 100.50, port: 'Laem Chabang' },
  'CIMC': { city: 'Shenzhen', country: 'China', lat: 22.54, lng: 114.06, port: 'Yantian' },
  'makesense': { city: 'Shenzhen', country: 'China', lat: 22.54, lng: 114.06, port: 'Yantian' },
};

const DESTINATIONS = {
  'Australia': { city: 'Melbourne', lat: -37.81, lng: 144.96, port: 'Melbourne' },
  'USA':       { city: 'Los Angeles', lat: 33.74, lng: -118.26, port: 'Los Angeles' },
  'Canada':    { city: 'Vancouver', lat: 49.29, lng: -123.11, port: 'Vancouver' },
  'UK':        { city: 'Felixstowe', lat: 51.96, lng: 1.35, port: 'Felixstowe' },
  'NZ':        { city: 'Auckland', lat: -36.84, lng: 174.76, port: 'Auckland' },
  'Singapore': { city: 'Singapore', lat: 1.26, lng: 103.84, port: 'Singapore' },
  'default':   { city: 'Melbourne', lat: -37.81, lng: 144.96, port: 'Melbourne' }
};

// Determine destination from PO reference and SKU prefixes
function getDestination(po) {
  const ref = (po.reference || '').toUpperCase();
  const skus = Object.keys(po.items || {});

  // 1. PO reference prefix takes priority
  if (ref.startsWith('PO-CA'))  return DESTINATIONS['Canada'];
  if (ref.startsWith('PO-US'))  return DESTINATIONS['USA'];
  if (ref.startsWith('PO-UK'))  return DESTINATIONS['UK'];
  if (ref.startsWith('PO-NZ'))  return DESTINATIONS['NZ'];
  if (ref.startsWith('PO-SG'))  return DESTINATIONS['Singapore'];
  if (ref.startsWith('PO-AU'))  return DESTINATIONS['Australia'];

  // 2. Check SKU prefixes - if majority are NA, route to US
  const naCount = skus.filter(s => s.startsWith('LLNA')).length;
  const ukCount = skus.filter(s => s.includes('-UK')).length;
  const sgCount = skus.filter(s => s.startsWith('LLSG')).length;
  const total = skus.length || 1;

  if (naCount / total > 0.5) return DESTINATIONS['USA'];
  if (ukCount / total > 0.5) return DESTINATIONS['UK'];
  if (sgCount / total > 0.5) return DESTINATIONS['Singapore'];

  // 3. Fallback: Australia
  return DESTINATIONS['default'];
}

function getSupplierOrigin(company) {
  if (!company) return { city: 'Unknown', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' };
  for (const [key, origin] of Object.entries(SUPPLIER_ORIGINS)) {
    if (company.toLowerCase().includes(key.toLowerCase())) return origin;
  }
  return { city: 'Unknown', country: 'China', lat: 23.13, lng: 113.26, port: 'Nansha' };
}

// ===== AIS VESSEL TRACKING =====
const vesselPositions = {}; // { vesselName: { lat, lng, heading, speed, timestamp } }
let aisWs = null;
let aisReconnectTimer = null;
let aisSubscribedVessels = [];

function extractContainerNumber(trackingCode) {
  const match = String(trackingCode || '').toUpperCase().match(/\b[A-Z]{4}\d{6,7}\b/);
  return match ? match[0] : '';
}

function hasContainerNumber(po) {
  return !!extractContainerNumber(po?.trackingCode);
}

function extractVesselNames() {
  // Extract vessel names from PO tracking codes (format: "CONTAINER / VESSEL" or "CONTAINER/VESSEL")
  const vessels = new Set();
  for (const po of dataCache.cin7POs || []) {
    const tc = po.trackingCode || '';
    // Match "CONTAINER / VESSEL_NAME" or "CONTAINER/VESSEL_NAME"
    const match = tc.match(/[A-Z]{4}\d{6,7}\s*\/\s*(.+)/i);
    if (match) {
      let vesselName = match[1].trim();
      // Remove voyage number suffix (e.g. "/023E")
      vesselName = vesselName.replace(/\/\d+[A-Z]*$/, '').trim();
      if (vesselName.length > 2) vessels.add(vesselName.toUpperCase());
    }
  }
  return Array.from(vessels);
}

function connectAIS() {
  if (!AIS_API_KEY) { console.log('[AIS] No API key, skipping'); return; }

  const vessels = extractVesselNames();
  if (vessels.length === 0) { console.log('[AIS] No vessels to track'); return; }

  // Don't reconnect if same vessels
  if (aisWs && aisWs.readyState === WebSocket.OPEN &&
      JSON.stringify(aisSubscribedVessels) === JSON.stringify(vessels)) return;

  // Close existing
  if (aisWs) { try { aisWs.close(); } catch(e){} }

  console.log(`[AIS] Connecting to track ${vessels.length} vessels: ${vessels.join(', ')}`);
  aisSubscribedVessels = vessels;
  // Clear stale positions from previous connection
  Object.keys(vesselPositions).forEach(k => delete vesselPositions[k]);

  try {
    aisWs = new WebSocket('wss://stream.aisstream.io/v0/stream');

    aisWs.on('open', () => {
      console.log('[AIS] Connected');
      // Subscribe by vessel name
      // Use targeted bounding boxes to reduce stream volume:
      // Box 1: China seas + SE Asia + Indian Ocean (departures & AU route)
      // Box 2: Pacific Ocean (US/CA route)
      // Box 3: Indian Ocean + Suez + Med (UK route)
      aisWs.send(JSON.stringify({
        APIKey: AIS_API_KEY,
        BoundingBoxes: [
          [[-45, 90], [45, 180]],    // China → Australia corridor
          [[20, 120], [50, -120]],   // Trans-Pacific (note: API may not handle antimeridian)
          [[-10, 30], [45, 110]],    // Indian Ocean + Suez + Med
          [[-45, -180], [50, -100]]  // Eastern Pacific / Americas
        ],
        FilterMessageTypes: ['PositionReport']
      }));
    });

    // Build a Set of vessel names we're tracking for fast client-side filtering
    // (FilterShipNames API param doesn't actually filter on aisstream)
    const vesselSet = new Set(vessels);

    aisWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.MessageType === 'PositionReport' && msg.MetaData) {
          const name = (msg.MetaData.ShipName || '').trim().toUpperCase();
          const pos = msg.Message?.PositionReport;
          // Only cache positions for vessels we're actually tracking
          if (name && pos && vesselSet.has(name)) {
            vesselPositions[name] = {
              lat: pos.Latitude,
              lng: pos.Longitude,
              heading: pos.TrueHeading || 0,
              speed: pos.Sog || 0,
              timestamp: msg.MetaData.time_utc || new Date().toISOString(),
              mmsi: msg.MetaData.MMSI || null
            };
            console.log(`[AIS] ✅ ${name}: ${pos.Latitude.toFixed(3)}, ${pos.Longitude.toFixed(3)} @ ${pos.Sog || 0}kn`);
          }
        }
      } catch(e) { /* ignore parse errors */ }
    });

    aisWs.on('close', () => {
      console.log('[AIS] Disconnected, reconnecting in 30s');
      aisReconnectTimer = setTimeout(connectAIS, 30000);
    });

    aisWs.on('error', (err) => {
      console.log('[AIS] Error:', err.message);
    });

    // AIS stream stays open - aisstream sends updates as vessels report
    // Close after 5 min to save resources, reopen on next data refresh
    setTimeout(() => {
      if (aisWs && aisWs.readyState === WebSocket.OPEN) {
        console.log('[AIS] Closing after 5min cycle');
        aisWs.close();
      }
    }, 5 * 60 * 1000);

  } catch(e) {
    console.log('[AIS] Connection failed:', e.message);
  }
}

// Reconnect AIS after each CIN7 data refresh (new POs may have new vessels)
function refreshAIS() {
  if (AIS_API_KEY) connectAIS();
}

function buildShipmentData() {
  const shipments = [];
  const now = new Date();

  for (const po of dataCache.cin7POs) {
    // Include active POs (we already filter out Received in fetchCin7POs)
    const origin = getSupplierOrigin(po.company || '');
    const dest = getDestination(po);

    // CRD = cargo ready date. Stored in the legacy `etd` field from Cin7 estimatedDeliveryDate.
    let crd = null;
    if (po.crd || po.etd) {
      crd = new Date(po.crd || po.etd);
    }

    // Original ETA = customFields.orders_1000 (set when PO created)
    let originalEta = null;
    if (po.customFields?.orders_1000) {
      const cf = po.customFields.orders_1000;
      const parsed = new Date(cf.replace(/(\d+)-(\d+)-(\d+)/, (m, d, mo, y) => {
        return y + '-' + mo.padStart(2,'0') + '-' + d.padStart(2,'0');
      }));
      if (!isNaN(parsed.getTime())) originalEta = parsed;
      if (!originalEta || isNaN(originalEta.getTime())) {
        const direct = new Date(cf);
        if (!isNaN(direct.getTime())) originalEta = direct;
      }
    }

    // Revised ETA = estimatedArrivalDate (updated when shipping info comes in)
    let revisedEta = null;
    if (po.estimatedArrivalDate) {
      revisedEta = new Date(po.estimatedArrivalDate);
      if (isNaN(revisedEta.getTime())) revisedEta = null;
    }

    // ETA for display/calculations: use revised if available, else original
    let eta = revisedEta || originalEta;

    // Actual received date
    let receivedDate = null;
    if (po.fullyReceivedDate) {
      receivedDate = new Date(po.fullyReceivedDate);
    }

    const hasContainer = hasContainerNumber(po);

    // Calculate progress (0-1) and status - unified with PO tab logic
    let progress = 0;
    let status = 'production';

    // If it has a received date OR stage is "Received", it's arrived
    if (receivedDate || isReceivedPO(po)) {
      progress = 1;
      status = 'arrived';
    } else if (crd && crd <= now && hasContainer) {
      // CRD has passed and a container number is recorded - shipped. Determine if still in transit or overdue.
      if (eta && eta <= now) {
        // ETA passed but not received - overdue, still show as in_transit on tracker
        progress = 1;
        status = 'in_transit';
      } else if (crd && eta) {
        // Normal in transit: progress based on CRD-ETA window
        const totalDays = (eta - crd) / (24 * 60 * 60 * 1000);
        const elapsedDays = (now - crd) / (24 * 60 * 60 * 1000);
        progress = totalDays > 0 ? Math.min(1, elapsedDays / totalDays) : 0.5;
        status = 'in_transit';
      } else {
        // CRD passed with container number but no ETA - still in transit, unknown progress
        progress = 0.5;
        status = 'in_transit';
      }
    }
    // else: CRD not set/in future, or no container number yet - still in production (default)

    // Count items
    const totalUnits = Object.values(po.items || {}).reduce((a, b) => a + b, 0);
    const skuCount = Object.keys(po.items || {}).length;

    // Days until arrival
    const daysUntil = eta ? Math.ceil((eta - now) / (24 * 60 * 60 * 1000)) : null;

    shipments.push({
      reference: po.reference,
      supplier: po.company || 'Unknown',
      status: po.status,
      stage: po.stage || '',
      origin,
      destination: dest,
      etd: crd ? crd.toISOString() : null,
      crd: crd ? crd.toISOString() : null,
      eta: eta ? eta.toISOString() : null,
      originalEta: originalEta ? originalEta.toISOString() : null,
      revisedEta: revisedEta ? revisedEta.toISOString() : null,
      etaStatus: (originalEta && revisedEta) ? (revisedEta > originalEta ? 'delayed' : revisedEta < originalEta ? 'early' : 'on_time') : null,
      receivedDate: receivedDate ? receivedDate.toISOString() : null,
      daysUntil,
      progress,
      shipmentStatus: status,
      totalUnits,
      skuCount,
      total: po.total || 0,
      currency: po.currencyCode || 'USD',
      items: po.items || {},
      trackingCode: po.trackingCode || null,
      port: po.port || null,
      internalComments: po.internalComments || null,
      vesselPosition: null, // filled below
      vesselName: null
    });
  }

  // Attach AIS vessel positions
  for (const s of shipments) {
    if (!s.trackingCode) continue;
    const match = (s.trackingCode || '').match(/[A-Z]{4}\d{6,7}\s*\/\s*(.+)/i);
    if (match) {
      let vn = match[1].trim().replace(/\/\d+[A-Z]*$/, '').trim().toUpperCase();
      s.vesselName = vn;
      if (vesselPositions[vn]) {
        s.vesselPosition = vesselPositions[vn];
      }
    }
  }

  return shipments.sort((a, b) => {
    if (!a.eta) return 1;
    if (!b.eta) return -1;
    return new Date(a.eta) - new Date(b.eta);
  });
}

app.get('/api/shipments', requireAuth, (req, res) => {
  reloadSnapshotIfNewer();
  res.json({ shipments: buildShipmentData(), lastRefresh: dataCache.lastRefresh });
});

// Serve shipment tracker page
app.get('/tracker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tracker.html')));

// Health check endpoint (no auth needed - used by keep-alive and monitoring)
const HEALTH_EXPECTED_STORES = ['lifely', 'cushie', 'littlelifely'];
const HEALTH_REQUIRED_OPTION1 = [
  'Category Killer - Little Lifely',
  'Category Killer - 21cm Mattress',
  'Category Killer - Deepdream',
  'Category Killer - Deep Dream',
  'Category Killer - Cocoon Bed',
  'Category Killer - Radiant',
  'Category Killer - WFH Chair',
  'Category Killer - Cushie V3 Snuggle',
  'Category Killer - Cushie V2',
  'Category Killer - Lifely Sofa',
  'Case goods - Active',
  'Case goods - Discontinued'
];
const HEALTH_STALE_WARN_HOURS = 6;
const HEALTH_STALE_CRITICAL_HOURS = 12;
const HEALTH_MIN_CIN7_PRODUCTS = 1000;
const HEALTH_MIN_PURCHASE_ORDERS = 50;
const HEALTH_ROUTE_FIXTURES = [
  { sku: 'LIFELY-CPD', expected: 'Case Goods' },
  { sku: 'COCOON-DOUBLE-IVR', expected: 'Cocoon Bed' },
  { sku: 'RDNT-D-BASE', expected: 'Radiant' },
  { sku: 'LLAU-CB-S-MSM', expected: 'Little Lifely AU' },
  { sku: 'DD-21153CF', expected: 'Deep Dream' }
];

function hoursSinceIso(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return Math.round(((Date.now() - ts) / 36e5) * 10) / 10;
}

function hasStorePayload(source, store) {
  return !!source?.[store] && Object.keys(source[store] || {}).filter(k => !k.startsWith('__')).length > 0;
}

function buildHealthStatus() {
  const products = dataCache.cin7Products || {};
  const stockByBranch = dataCache.cin7StockByBranch || {};
  const pos = dataCache.cin7POs || [];
  const option1Counts = {};
  let productsWithOption1 = 0;
  for (const product of Object.values(products)) {
    const option1 = String(product?.option1 || '').trim();
    if (!option1) continue;
    productsWithOption1 += 1;
    option1Counts[option1] = (option1Counts[option1] || 0) + 1;
  }

  const fixtureRoutes = HEALTH_ROUTE_FIXTURES.map(({ sku, expected }) => ({ sku, expected, actual: ckCategoryForSku(sku) }));
  const ckPanelSkuCounts = {};
  for (const id of Object.keys(CK_DEFS).filter(id => id !== 'llau-cbcf')) {
    try {
      const ckData = buildCKData(id);
      ckPanelSkuCounts[id] = Object.keys(ckData?.cin7 || {}).length;
    } catch (err) {
      ckPanelSkuCounts[id] = 0;
    }
  }

  const checks = {
    cin7Products: Object.keys(products).length,
    cin7StockByBranchSkus: Object.keys(stockByBranch).length,
    purchaseOrders: pos.length,
    purchaseOrdersWithoutLineItems: pos.filter(po => Object.keys(po.items || {}).length === 0).length,
    productsWithOption1,
    productsMissingOption1: Object.keys(products).length - productsWithOption1,
    missingRequiredOption1: HEALTH_REQUIRED_OPTION1.filter(option1 => !option1Counts[option1]),
    fixtureRoutes,
    ckPanelSkuCounts,
    shopifyStores: Object.fromEntries(HEALTH_EXPECTED_STORES.map(store => [store, {
      inventory: hasStorePayload(dataCache.shopifyInventory, store),
      velocity: hasStorePayload(dataCache.shopifyVelocity, store),
      velocityByCountry: hasStorePayload(dataCache.shopifyVelocityByCountry, store),
      openDemand: hasStorePayload(dataCache.shopifyOpenDemand, store)
    }])),
    refreshAgeHours: {
      overall: hoursSinceIso(dataCache.lastRefresh),
      cin7: hoursSinceIso(dataCache.lastCin7Refresh),
      purchaseOrders: hoursSinceIso(dataCache.lastPoRefresh),
      shopify: hoursSinceIso(dataCache.lastShopifyRefresh)
    }
  };

  const warnings = [];
  const critical = [];
  if (checks.cin7Products < HEALTH_MIN_CIN7_PRODUCTS) critical.push(`Cin7 product count below floor: ${checks.cin7Products}`);
  if (checks.purchaseOrders < HEALTH_MIN_PURCHASE_ORDERS) critical.push(`Purchase order count below floor: ${checks.purchaseOrders}`);
  if (checks.cin7StockByBranchSkus === 0) critical.push('Cin7 branch stock payload missing');
  if (checks.productsMissingOption1 > 0) warnings.push(`${checks.productsMissingOption1} Cin7 products/options have blank Option1`);
  if (checks.missingRequiredOption1.length) warnings.push(`Required Option1 categories missing: ${checks.missingRequiredOption1.join(', ')}`);
  if (checks.purchaseOrdersWithoutLineItems > 0) warnings.push(`${checks.purchaseOrdersWithoutLineItems} purchase orders currently have no line items`);
  const badFixtures = fixtureRoutes.filter(row => row.actual !== row.expected);
  if (badFixtures.length) critical.push(`SKU route fixture mismatch: ${badFixtures.map(row => `${row.sku} expected ${row.expected}, got ${row.actual}`).join('; ')}`);
  const zeroPanels = Object.entries(ckPanelSkuCounts).filter(([, count]) => count === 0).map(([id]) => id);
  if (zeroPanels.length) critical.push(`CK panels returned zero Cin7 SKUs: ${zeroPanels.join(', ')}`);

  for (const [store, storeChecks] of Object.entries(checks.shopifyStores)) {
    for (const [name, ok] of Object.entries(storeChecks)) {
      if (!ok) critical.push(`Shopify ${store} ${name} payload missing/empty`);
    }
  }

  for (const [name, age] of Object.entries(checks.refreshAgeHours)) {
    if (age === null) {
      critical.push(`${name} refresh timestamp missing`);
    } else if (age > HEALTH_STALE_CRITICAL_HOURS) {
      critical.push(`${name} data stale: ${age}h old`);
    } else if (age > HEALTH_STALE_WARN_HOURS) {
      warnings.push(`${name} data getting stale: ${age}h old`);
    }
  }

  if (dataCache.error) warnings.push(`Last cache error: ${dataCache.error}`);
  return { status: critical.length ? 'critical' : warnings.length ? 'warning' : 'ok', ok: critical.length === 0, warnings, critical, checks };
}

app.get('/api/health', (req, res) => {
  reloadSnapshotIfNewer();
  const cin7Count = Object.keys(dataCache.cin7Products).length;
  const poCount = dataCache.cin7POs.length;
  const health = buildHealthStatus();
  res.json({ ok: health.ok, status: health.status, cin7: cin7Count, pos: poCount, cin7Source: CIN7_DATA_SOURCE, nextScheduledRefreshEveryHours: ENABLE_RENDER_CIN7_SCHEDULER ? 4 : null, externalCacheRefreshEveryHours: 4, cacheFallback: true, lastRefresh: dataCache.lastRefresh, lastCin7Refresh: dataCache.lastCin7Refresh, lastPoRefresh: dataCache.lastPoRefresh, lastShopifyRefresh: dataCache.lastShopifyRefresh, error: dataCache.error || null, uptime: Math.round(process.uptime()), warnings: health.warnings, critical: health.critical, checks: health.checks });
});

// Main app shell is public; all data APIs remain protected by requireAuth.
// This lets the browser reuse a 30-day localStorage token after direct visits, restarts, or deploys.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ===== START =====
app.listen(PORT, () => {
  console.log(`Demand Planner running on port ${PORT}`);
  console.log(`Startup cache: ${Object.keys(dataCache.cin7Products || {}).length} CIN7 SKUs, ${(dataCache.cin7POs || []).length} POs`);

  // Render restarts and deploys must not force live CIN7 pulls. The durable
  // OpenClaw cron refreshes the repo cache every 4 hours; this app reloads that
  // cache from disk and only hits CIN7 for explicit manual refreshes, unless the
  // Render scheduler is deliberately enabled via env.
  if (ENABLE_RENDER_CIN7_SCHEDULER) {
    scheduleFourHourlyCin7Refresh();
  } else {
    console.log('Render CIN7 scheduler disabled; using durable external cache refresh');
  }

  // Keep-alive: ping local health with the correct protocol. Using https against
  // an http:// URL throws ERR_INVALID_PROTOCOL and crashes the process.
  setInterval(() => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path: '/api/health' }, res => {
      res.resume();
    });
    req.on('error', () => {});
    req.setTimeout(5000, () => req.destroy());
  }, 10 * 60 * 1000);
});



// ===== INCOMING POs TAB =====
const DD_21CM_SKUS = new Set(['DD-21107CF','DD-21137CF','DD-21153CF','DD-21183CF','DD-21915CF']);

function classifySKU(code, destCountry) {
  const c = (code || '').toUpperCase();
  // NZ uses LLAU- SKUs - check destination first
  if (destCountry === 'NZ' && c.startsWith('LLAU-') && !c.includes('-CV')) return 'LL Beds - NZ';
  if (destCountry === 'NZ' && c.startsWith('LLAU-') && c.includes('-CV')) return 'LL Covers - NZ';

  if (c.startsWith('LLAU-CB-') && !c.includes('-CV') && !c.includes('-CS-') && !c.includes('-FS-') && !c.includes('CBCF')) return 'LL Beds - AU';
  if (c.startsWith('LLAU-CB-') && c.includes('-CV')) return 'LL Covers - AU';
  if (c.startsWith('LLAU-CB-CS-') || c.startsWith('LLAU-CB-FS-')) return null; // swatches
  if (c.startsWith('LLNA-CB-') && !c.includes('-CV') && !c.includes('CFDS') && !c.includes('CBCF')) return 'LL Beds - US/CA';
  if (c.startsWith('LLNA-CB-') && c.includes('-CV')) return 'LL Covers - US/CA';
  if (c.startsWith('LLNA-CFDS-') || c.startsWith('LLNA-CBCF-')) return null; // combo sku shouldn't be in POs
  if (c.startsWith('LLUK-CB-') && !c.includes('-CV')) return 'LL Beds - UK';
  if (c.startsWith('LLUK-CB-') && c.includes('-CV')) return 'LL Covers - UK';
  if (c.startsWith('LLSG-') && !c.includes('-CV')) return 'LL Beds - SG';
  if (c.startsWith('LLSG-') && c.includes('-CV')) return 'LL Covers - SG';
  if (DD_21CM_SKUS.has(code)) return 'Deep Dream 21CM';
  if (c.startsWith('DD-')) return 'Deep Dream Other';
  if (c.startsWith('V2-')) return 'Cushie V2 - ' + (destCountry || 'US');
  if (c.startsWith('V3-')) return 'Snuggle V3 - ' + (destCountry || 'AU');
  if ((c.startsWith('CUSB-') || c.startsWith('LFSB-')) && c.includes('-UK')) return 'Cushie V2 - UK';
  if (c.startsWith('CUSB-') || c.startsWith('LFSB-')) return 'Cushie V2 - ' + (destCountry || 'AU');
  if (c.startsWith('CMSS-')) return 'Modular Sleeper';
  if (c.startsWith('LIFELY-') || c.startsWith('LFSF-')) return 'Lifely Sofa';
  if (c.startsWith('RDNT-')) return 'Radiant';
  if (c.startsWith('COCOON-')) return 'Cocoon Bed';
  if (c.startsWith('WFHCR-')) return 'WFH Chair';
  return 'Case Goods';
}

function destToCountryCode(dest) {
  if (!dest) return 'AU';
  const d = dest.toLowerCase();
  if (d.includes('united states') || d.includes('usa')) return 'US';
  if (d.includes('canada')) return 'CA';
  if (d.includes('united kingdom')) return 'UK';
  if (d.includes('singapore')) return 'SG';
  if (d.includes('new zealand')) return 'NZ';
  if (d.includes('australia')) return 'AU';
  // Fallback from PO reference
  return 'AU';
}

function destFromRef(ref) {
  const r = (ref || '').toUpperCase();
  if (r.startsWith('PO-AU') || r.startsWith('PO-LF')) return 'Australia';
  if (r.startsWith('PO-US') || r.startsWith('PO-10')) return 'United States';
  if (r.startsWith('PO-CA')) return 'Canada';
  if (r.startsWith('PO-UK')) return 'United Kingdom';
  if (r.startsWith('PO-NZ')) return 'New Zealand';
  if (r.startsWith('PO-SG')) return 'Singapore';
  return null;
}

function resolvePoDestination(po) {
  let destination = inferDestination(po);
  if (!destination || destination === 'Australia') {
    const refDest = destFromRef(rawPoReference(po.reference));
    if (refDest) destination = refDest;
    else destination = 'Australia';
  }
  return destination;
}

app.get('/api/incoming-pos', requireAuth, (req, res) => {
  const allCKGroups = new Set();
  const allMonths = new Set();
  const allCountries = new Set();
  
  // Build global landed cost lookup from ALL CK panels
  const globalLanded = {};
  for (const ckId of Object.keys(CK_DEFS)) {
    try {
      const ckData = buildCKData(ckId);
      if (ckData && ckData.landedCosts) {
        for (const [sku, lc] of Object.entries(ckData.landedCosts)) {
          if (!globalLanded[sku] || lc.source === 'actual') globalLanded[sku] = lc;
        }
      }
    } catch(e) { /* skip if CK fails */ }
  }

  const pos = [];
  for (const po of (dataCache.cin7POs || [])) {
    // Use the same open-PO rule as the PO tab and CK incoming logic.
    if (!isOpenPO(po)) continue;

    // Determine destination
    let destination = resolvePoDestination(po);
    const countryCode = destToCountryCode(destination);
    allCountries.add(countryCode);

    // ETA
    const etaRaw = po.estimatedArrivalDate || po.arrival || null;
    let eta = null, etaMonth = 'TBD';
    if (etaRaw) {
      const dt = new Date(etaRaw);
      if (!isNaN(dt)) {
        if (dt < new Date('2026-04-01')) {
          eta = '2026-04-01';
          etaMonth = 'April 2026';
        } else {
          eta = dt.toISOString().split('T')[0];
          const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
          etaMonth = months[dt.getMonth()] + ' ' + dt.getFullYear();
        }
      }
    }
    allMonths.add(etaMonth);

    // Line items with CK classification + landed costs from CK panels
    const lineItems = [];
    const poGroups = new Set();
    let totalUnits = 0;
    let totalFOB = 0, totalFreight = 0, totalTariff = 0;

    for (const [sku, qty] of Object.entries(po.items || {})) {
      const ckGroup = classifySKU(sku, countryCode);
      if (!ckGroup) continue;

      poGroups.add(ckGroup);
      allCKGroups.add(ckGroup);
      totalUnits += qty;

      // Use landed costs from CK panels
      const lc = globalLanded[sku];
      const fobPerUnit = lc ? lc.fob : 0;
      const freightPerUnit = lc ? lc.freightPerUnit : 0;
      const tariffPerUnit = lc ? (lc.tariffPerUnit || 0) : 0;
      const landedPerUnit = lc ? lc.landedPerUnit : 0;

      totalFOB += fobPerUnit * qty;
      totalFreight += freightPerUnit * qty;
      totalTariff += tariffPerUnit * qty;

      lineItems.push({
        sku,
        name: sku,
        qty,
        fobPerUnit: Math.round(fobPerUnit * 100) / 100,
        freightPerUnit: Math.round(freightPerUnit * 100) / 100,
        landedPerUnit: Math.round(landedPerUnit * 100) / 100,
        ckGroup,
        source: lc ? lc.source : 'none'
      });
    }

    if (lineItems.length === 0) continue;

    const productTotal = Math.round(totalFOB);
    const freightEst = Math.round(totalFreight);
    const tariffEst = Math.round(totalTariff);
    const landedTotal = productTotal + freightEst + tariffEst;

    pos.push({
      reference: rawPoReference(po.reference),
      supplier: po.company || '',
      destination: countryCode,
      destinationFull: destination,
      eta,
      etaMonth,
      productTotal,
      freightEst,
      tariffEst,
      landedTotal,
      stage: po.stage || 'Open',
      totalUnits,
      ckGroups: [...poGroups].sort(),
      lineItems
    });
  }

  // Sort by ETA
  pos.sort((a, b) => {
    if (!a.eta && !b.eta) return 0;
    if (!a.eta) return 1;
    if (!b.eta) return -1;
    return a.eta.localeCompare(b.eta);
  });

  // Summary totals
  const summary = {
    totalProductAUD: pos.reduce((s, p) => s + p.productTotal, 0),
    totalFreightAUD: pos.reduce((s, p) => s + p.freightEst, 0),
    totalTariffAUD: pos.reduce((s, p) => s + p.tariffEst, 0),
    totalLandedAUD: pos.reduce((s, p) => s + p.landedTotal, 0),
    totalUnits: pos.reduce((s, p) => s + p.totalUnits, 0),
    poCount: pos.length
  };

  res.json({
    pos,
    summary,
    months: [...allMonths].sort(),
    countries: [...allCountries].sort(),
    ckGroups: [...allCKGroups].sort()
  });
});

// Serve incoming-pos page
app.get('/incoming-pos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'incoming-pos.html'));
});
