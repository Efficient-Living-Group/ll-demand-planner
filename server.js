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
const LL_US_BRANCH_IDS = [60701, 63764, 65158];

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
  'llau':      { name: 'Little Lifely AU',              prefix: 'LLAU-CB-', logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'Australia', salesCountry: 'AU', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Little Lifely', option1Bypass: sku => sku.startsWith('LLAU-CB-'), filter: sku => !isLittleLifelyBundleSku(sku), sizes: {'PACK':'Swatch Packs','-CS-':'Fabric Swatch','-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llnz':      { name: 'Little Lifely NZ',              prefix: 'LLAU-CB-', logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'New Zealand', salesCountry: 'NZ', stockBranches: LL_NZ_BRANCH_IDS, strictStockBranches: true, option1: 'Category Killer - Little Lifely', filter: sku => !isLittleLifelyBundleSku(sku), sizes: {'PACK':'Swatch Packs','-CS-':'Fabric Swatch','-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llau-cbcf': { name: 'LL AU Combos',            prefix: 'LLAU-CBCF-', logo: 'little-lifely.png', store: 'lifely', excludeCV: true, salesCountry: 'AU', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Little Lifely', sizes: {'-S-':'Single','-KS-':'King Single','-D-':'Double'} },
  'llna':     { name: 'Little Lifely NA',       prefix: 'LLNA',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'United States', salesCountry: 'US', stockBranches: LL_US_BRANCH_IDS, option1: 'Category Killer - Little Lifely', filter: sku => !isLittleLifelyBundleSku(sku), sizes: {'-TWX-':'Twin XL','-TW-':'Twin','-F-':'Full'} },
  'llca':     { name: 'Little Lifely CA',       prefix: 'LLNA',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, poDestination: 'Canada', salesCountry: 'CA', stockBranches: [61831], option1: 'Category Killer - Little Lifely', filter: sku => !isLittleLifelyBundleSku(sku), sizes: {'-TWX-':'Twin XL','-TW-':'Twin','-F-':'Full'} },
  'lluk':     { name: 'Little Lifely UK',       prefix: 'LLUK-CB-',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, salesCountry: 'GB', stockBranches: [62444], option1: 'Category Killer - Little Lifely', filter: isLittleLifelyUkComponentSku, sizes: {'-S-':'Single','-SD-':'Small Double','-D-':'Double'} },
  'llsg':     { name: 'Little Lifely SG',       prefix: 'LLSG',   logo: 'little-lifely.png', store: 'lifely', excludeCV: false, salesCountry: 'SG', stockBranches: [57843], strictStockBranches: true, option1: 'Category Killer - Little Lifely', filter: sku => !isLittleLifelyBundleSku(sku), sizes: {'-SS-':'Super Single','-S-':'Single','-Q-':'Queen'} },
  'll-mattresses': { name: 'LL Mattresses',     prefix: 'MULTI',  logo: 'little-lifely.png', store: 'lifely', option1: ['Category Killer - 21cm Mattress', 'Category Killer - Deep Dream'], option1Bypass: sku => sku.startsWith('DDUK'), filter: sku => ['DD-21915CF','DD-21107CF','DD-21137CF'].includes(sku) || sku.startsWith('DDUK'), sizes: {'21915':'Single','21107':'King Single','21137':'Double','2190':'Single UK','21120':'Small Double UK','21135':'Double UK'} },
  'dd':       { name: 'Deep Dream',             prefix: 'MULTI',  logo: 'deep-dream.png',    store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Deepdream', sizes: {'915':'Single','107':'King Single','137':'Double','153':'Queen','183':'King'} },
  'cocoon':   { name: 'Cocoon Bed',             prefix: 'COCOON', logo: 'cocoon-bed.png',    store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Cocoon Bed', sizes: {'-DOUBLE-':'Double','-QUEEN-':'Queen','-KING-':'King'} },
  'rdnt':     { name: 'Radiant',                prefix: 'RDNT',   logo: 'radiant.png',       store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Radiant', sizes: {'-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'wfhcr':    { name: 'WFH Chair',              prefix: 'WFHCR',  logo: 'wfh-chair.png',     store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - WFH Chair', filter: isWfhChairSellableSku, sizes: {} },
  'airflow-pad': { name: 'Airflow Pad',           prefix: 'PAD-',   logo: null,               mark: 'AIR',  store: 'lifely', option1: 'Airflow Pad', sizes: {} },
  'caterpillar': { name: 'Caterpillar Dining',    prefix: 'MULTI',  logo: null,               mark: 'CAT',  store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Caterpillar', sizes: {'EDT':'Dining Table','EDB':'Dining Chair'} },
  'cusb-au':  { name: 'Cushie AU',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', poDestination: 'Australia', salesCountry: 'AU', stockBranches: LL_AU_BRANCH_IDS, option1: ['Category Killer - Cushie V3 Snuggle', 'Category Killer - Cushie V2', 'Category Killer - Cushie V2 - Discontinued', 'Category Killer - Lifely Sofa'], filter: sku => !isCushieSetBomSku(sku) && ((sku.startsWith('CUSB') && !sku.includes('-UK') && !sku.includes('SGE')) || (sku.startsWith('LFSB') && !sku.includes('-UK'))), excludeCV: true, sizes: {'ARST':'Armrest','-TW-':'Twin','-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King','-CHS-':'Chaise','-SOTM-':'Ottoman','-AMST-':'Armrest'} },
  'cusb-us':  { name: 'Cushie US',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', poDestination: 'United States', salesCountry: 'US', stockBranches: [60701], option1: ['Category Killer - Cushie V2', 'Category Killer - Cushie V2 - Discontinued', 'Category Killer - Cushie V3 Snuggle'], filter: sku => !isCushieSetBomSku(sku) && (sku.startsWith('V2-') || sku.startsWith('V3-')), excludeCV: true, sizes: {'-TB-':'Twin','-DB-':'Full','-QB-':'Queen','-KB-':'King','-CH-':'Chaise','-OS-':'Ottoman','-OB-':'Ottoman Bed','-RMST':'Armrest','-RMST-':'Armrest','-ARM-':'Armrest'} },
  'cusb-ca':  { name: 'Cushie CA',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', poDestination: 'Canada', salesCountry: 'CA', stockBranches: [61831], option1: ['Category Killer - Cushie V2', 'Category Killer - Cushie V2 - Discontinued', 'Category Killer - Cushie V3 Snuggle'], filter: sku => !isCushieSetBomSku(sku) && (sku.startsWith('V2-') || sku.startsWith('V3-')) && !isCushieCanadaExcludedSku(sku), excludeCV: true, sizes: {'-TB-':'Twin','-DB-':'Full','-QB-':'Queen','-KB-':'King','-CH-':'Chaise','-OS-':'Ottoman','-OB-':'Ottoman Bed','-RMST':'Armrest','-RMST-':'Armrest','-ARM-':'Armrest'} },
  'cusb-uk':  { name: 'Cushie UK',              prefix: 'MULTI',  logo: 'cushie.png',        store: 'lifely', poDestination: 'United Kingdom', salesCountry: 'GB', stockBranches: [62444], option1: ['Category Killer - Cushie V2', 'Category Killer - Cushie V2 - Discontinued', 'Category Killer - Cushie V3 Snuggle'], filter: sku => !isCushieSetBomSku(sku) && (sku.startsWith('CUSB') || sku.startsWith('LFSB')) && sku.includes('-UK'), excludeCV: true, sizes: {'-TW-':'Twin','-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King','-CHS-':'Chaise','-SOTM-':'Ottoman','-AMST-':'Armrest'} },

  'cmss':     { name: 'Cushie Modular Sleeper', prefix: 'CMSS',   logo: 'cushie.png',        store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: 'Category Killer - Cushie V2', sizes: {'-S-':'Single','-D-':'Double','-Q-':'Queen','-K-':'King'} },
  'lifely-sofa': { name: 'Lifely Sofa',         prefix: 'MULTI',  logo: 'lifely-sofa.png',   store: 'lifely', stockBranches: LL_AU_BRANCH_IDS, option1: ['Category Killer - Lifely Sofa', 'Category Killer - Lifely Sofa - Discontinued'], filter: isLifelySofaComponentSku, sizes: {} },
  'case-goods': { name: 'Case Goods',           prefix: 'MULTI',  logo: null,                mark: 'CASE', store: 'lifely', option1: 'Case goods - Active', filter: isCaseGoodsSku, sizes: {} }
};

// ===== COMBO BOM (Bill of Materials) =====
const COMBO_BOM = {
  // LLAU-CBCF-{size}-{colour} = 1× LLAU-CB-{size}-{colour} + 1× DD mattress
  mattress: { 'S': 'DD-21915CF', 'KS': 'DD-21107CF', 'D': 'DD-21137CF' }
};

const SWATCH_COLOURS = ['DSBL', 'DGY', 'PST', 'BABL', 'CTCN', 'MSM'];
const COCOON_SIZE_WORD = { 'D': 'DOUBLE', 'Q': 'QUEEN', 'K': 'KING' };

const LITTLE_LIFELY_COUNTRY_SET_RE = /^(LLAU|LLNA|LLSG|LLUK)-CB-[A-Z0-9]+-[A-Z0-9]+-SET$/;
const LITTLE_LIFELY_BUNDLE_RE = /^(LLAU|LLNA|LLSG|LLUK)-(CTP|CBCF|CFDS)-/;
function isLittleLifelySetBomSku(sku) {
  return LITTLE_LIFELY_COUNTRY_SET_RE.test(String(sku || '').toUpperCase().trim());
}
function isLittleLifelyBundleSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  return isLittleLifelySetBomSku(s) || LITTLE_LIFELY_BUNDLE_RE.test(s);
}

function isCushiePhysicalArmrestSetSku(sku) {
  return /^CUSB-ARST-SET-[A-Z0-9]+(?:-UK)?$/.test(String(sku || '').toUpperCase().trim());
}
function isCushieSetBomSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  return /-SET(?:-|$)/.test(s) && !isCushiePhysicalArmrestSetSku(s);
}
function isWfhChairSellableSku(sku) {
  return /^WFHCR-[A-Z0-9]+$/.test(String(sku || '').toUpperCase().trim());
}
function isCushieCanadaExcludedSku(sku) {
  return /^V2-.*-DKGY$/.test(String(sku || '').toUpperCase().trim());
}

function loadCushieUsSkuMapping() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'cushie-us-sku-mapping.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.mapping || {};
  } catch (err) {
    console.warn('Cushie US SKU mapping unavailable:', err.message);
    return {};
  }
}

const CUSHIE_US_SKU_MAPPING = loadCushieUsSkuMapping();

function parseLittleLifelyUkSetSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  const m = s.match(/^LLUK-CB-(S|SD|D)-([A-Z0-9]+)(?:-SET)?$/);
  if (!m || m[2] === 'FRM') return null;
  return { size: m[1], colour: m[2] };
}

function isLittleLifelyUkFrameSku(sku) {
  return /^LLUK-CB-(S|SD|D)-FRM$/.test(String(sku || '').toUpperCase().trim());
}

function isLittleLifelyUkCoverSku(sku) {
  return /^LLUK-CB-(S|SD|D)-[A-Z0-9]+-CV$/.test(String(sku || '').toUpperCase().trim());
}

function isLittleLifelyUkComponentSku(sku) {
  return isLittleLifelyUkFrameSku(sku) || isLittleLifelyUkCoverSku(sku);
}

function mapLittleLifelyUkSetToComponents(size, colour, includeMattress = false) {
  const mattressMap = { S: 'DDUK-2190CF', SD: 'DDUK-21120CF', D: 'DDUK-21135CF' };
  const components = [`LLUK-CB-${size}-FRM`, `LLUK-CB-${size}-${colour}-CV`];
  if (includeMattress && mattressMap[size]) components.push(mattressMap[size]);
  return components;
}

function mapCushieUsVerifiedSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  if (!s) return s;
  return CUSHIE_US_SKU_MAPPING[s] || CUSHIE_US_SKU_MAPPING[s.replace(/-MULTI$/, '')] || s;
}

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

function explodeCocoonDeepDreamCombo(comboSku) {
  const match = String(comboSku || '').toUpperCase().trim().match(/^COCOON-(D|Q|K)MF-(CRML|IVR|MSGRN)$/);
  if (!match) return null;
  const [, size, colour] = match;
  const mattressMap = { D: 'DD-137DMF', Q: 'DD-153QMF', K: 'DD-183KMF' };
  return {
    size,
    colour,
    bed: 'COCOON-' + COCOON_SIZE_WORD[size] + '-' + colour,
    mattress: mattressMap[size],
    bedQty: 1,
    mattressQty: 1
  };
}

const LIFELY_SOFA_SWATCH_COLOURS = ['BLST', 'CHC', 'CRMPIP', 'DKGN', 'LB', 'OG', 'RST', 'WHT'];

function isLifelySofaComponentSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  if (!s) return false;
  // Physical Lifely Sofa planning rows are component/frame/cover/carton rows.
  // The current Cin7 catalogue still labels many of these as discontinued, but
  // they carry live SOH/open-sales/incoming quantities used by the sofa panel.
  if (/^LIFELY-FS-(BLST|CHC|CRMPIP|DKGN|LB|OG|RST|WHT)$/.test(s)) return true;
  if (/^LFSF-(AMLS|AMCR|CRNR|OTM)-(FC|CV-[A-Z0-9]+)$/.test(s)) return true;
  if (/^LIFELY-OTM-[A-Z0-9]+-\d+$/.test(s)) return true;
  if (/^LIFELY-SOFA-(AMLS|AMCR|CRNR)-[A-Z0-9]+-\d+$/.test(s)) return true;
  return false;
}

function lifelySofaColourFromSku(sku) {
  const parts = String(sku || '').toUpperCase().trim().split('-').filter(Boolean);
  if (!parts.length) return '';
  if (parts[parts.length - 1] === 'CVR') return parts[parts.length - 2] || '';
  return parts[parts.length - 1] || '';
}

function pushLifelySofaModules(out, module, colour, qty, includeFrame, includeCover) {
  const q = Math.max(0, Number(qty || 0));
  if (!q) return;
  if (includeFrame) out.push({ sku: `LFSF-${module}-FC`, qty: q });
  if (includeCover && colour) out.push({ sku: `LFSF-${module}-CV-${colour}`, qty: q });
}

function explodeLifelySofaSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  if (!s || isLifelySofaComponentSku(s)) return null;
  // Swatch packs are fulfilment freebies/marketing stock, not sofa component
  // preorder commitments. Do not fan one pack order into every swatch colour,
  // otherwise the sofa preorder view is dominated by fabric-swatch backlog.
  if (s === 'LIFELY-FS-PACK') return null;

  const colour = lifelySofaColourFromSku(s);
  if (!colour) return null;
  const coverOnly = s.endsWith('-CVR');
  const includeFrame = !coverOnly;
  const includeCover = true;
  const out = [];

  let m = s.match(/^LIFELY-OTM-[A-Z0-9]+(?:-CVR)?$/);
  if (m) {
    pushLifelySofaModules(out, 'OTM', colour, 1, includeFrame, includeCover);
    return out;
  }

  m = s.match(/^LIFELY-SOFA-(AMLS|AMCR|CRNR)-[A-Z0-9]+(?:-CVR)?$/);
  if (m) {
    const direct = s.replace(/-CVR$/, '');
    return [{ sku: direct + '-1', qty: 1 }, { sku: direct + '-2', qty: 1 }];
  }

  m = s.match(/^LIFELY-SOFA-(\d+)S(?:-(LEFT|RIGHT|OTM))?-[A-Z0-9]+(?:-CVR)?$/);
  if (m) {
    const seats = Number(m[1] || 0);
    const layout = m[2] || '';
    pushLifelySofaModules(out, 'AMLS', colour, seats, includeFrame, includeCover);
    if (layout === 'LEFT' || layout === 'RIGHT' || layout === 'OTM') pushLifelySofaModules(out, 'OTM', colour, 1, includeFrame, includeCover);
    return out;
  }

  m = s.match(/^LFSF-(\d+)S(?:-([A-Z0-9]+))?-[A-Z0-9]+(?:-CVR)?$/);
  if (m) {
    const seats = Number(m[1] || 0);
    const layout = m[2] || '';
    const ottomanMatch = layout.match(/(\d*)OTM/);
    const ottomans = ottomanMatch ? Number(ottomanMatch[1] || 1) : 0;
    const corners = /(^|-)U/.test(layout) ? 2 : /(^|-)L/.test(layout) ? 1 : 0;
    pushLifelySofaModules(out, 'AMLS', colour, seats, includeFrame, includeCover);
    pushLifelySofaModules(out, 'CRNR', colour, corners, includeFrame, includeCover);
    pushLifelySofaModules(out, 'OTM', colour, ottomans, includeFrame, includeCover);
    return out;
  }

  return null;
}

function lfsbSizeFromCmss(size) {
  if (size === 'K') return 'TW';
  if (['S', 'D', 'Q', 'TW'].includes(size)) return size;
  return null;
}

function normalizeCushieBomComponentSku(sku) {
  return String(sku || '').toUpperCase().trim().replace(/-(?:[12]|C[12])$/, '');
}

function expandComponentQtyMap(components) {
  const out = [];
  for (const [componentSku, rawQty] of Object.entries(components || {})) {
    const qty = Math.max(0, Math.round(Number(rawQty || 0)));
    for (let i = 0; i < qty; i += 1) out.push(componentSku);
  }
  return out;
}

function normalizeCin7BomComponents(components = []) {
  const groups = {};
  for (const component of components || []) {
    const rawSku = String(component?.code || component?.sku || '').toUpperCase().trim();
    if (!rawSku) continue;
    const baseSku = normalizeCushieBomComponentSku(rawSku);
    const qty = Math.max(0, Number(component?.qty ?? component?.quantity ?? 1));
    if (!qty) continue;
    if (!groups[baseSku]) groups[baseSku] = { directQty: 0, cartonQty: 0 };
    // LFSB parent rows in the planner represent a buildable module. Cin7 BOMs
    // list carton rows such as -1/-2 separately, so use the max carton qty for
    // that parent instead of summing both boxes and doubling demand.
    if (rawSku !== baseSku) groups[baseSku].cartonQty = Math.max(groups[baseSku].cartonQty, qty);
    else groups[baseSku].directQty += qty;
  }
  return Object.fromEntries(
    Object.entries(groups)
      .map(([sku, group]) => [sku, group.directQty + group.cartonQty])
      .filter(([, qty]) => qty > 0)
  );
}

function getCachedCin7BomComponentList(sku) {
  const s = String(sku || '').toUpperCase().trim();
  const cached = dataCache?.cin7BOMs?.[s];
  if (!cached) return null;
  const components = cached.components || cached;
  if (Array.isArray(components)) return components.map(normalizeCushieBomComponentSku).filter(Boolean);
  const expanded = expandComponentQtyMap(components);
  return expanded.length ? expanded : null;
}

function explodeCushieModularSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  const cached = s.startsWith('CMSS-') ? getCachedCin7BomComponentList(s) : null;
  if (cached) return cached;
  const colour = s.split('-').pop();
  if (!['CHC', 'LTGN', 'WHT', 'DNM'].includes(colour || '')) return null;
  const out = [];
  const add = (componentSku, qty = 1) => {
    if (!componentSku) return;
    for (let i = 0; i < qty; i += 1) out.push(componentSku);
  };

  let m = s.match(/^CMSS-SB-S-([A-Z0-9]+)$/);
  if (m) {
    add(`LFSB-AMST-${m[1]}`);
    add(`LFSB-TW-${m[1]}`);
    return out;
  }

  m = s.match(/^CMSS-2S-SB-(D|Q|K)-([A-Z0-9]+)$/);
  if (m) {
    const size = lfsbSizeFromCmss(m[1]);
    add(`LFSB-AMST-${m[2]}`);
    add(size ? `LFSB-${size}-${m[2]}` : null, m[1] === 'K' ? 2 : 1);
    return out;
  }

  m = s.match(/^CMSS-(?:2S-SSB|[34]S-SSB-CHS)-(Q|K)-([A-Z0-9]+)$/);
  if (m) {
    const size = lfsbSizeFromCmss(m[1]);
    add(`LFSB-AMST-${m[2]}`);
    if (s.includes('2S-SSB')) add(`LFSB-SOTM-${m[2]}`);
    add(size ? `LFSB-${size}-${m[2]}` : null, m[1] === 'K' ? 2 : 1);
    if (!s.includes('2S-SSB')) add(`LFSB-CHS-${m[2]}`);
    return out;
  }

  m = s.match(/^CMSS-(?:4S-USB-DCHS|5S-USB-CHS)-(Q|K)-([A-Z0-9]+)$/);
  if (m) {
    const size = lfsbSizeFromCmss(m[1]);
    add(`LFSB-AMST-${m[2]}`);
    add(size ? `LFSB-${size}-${m[2]}` : null, m[1] === 'K' ? 2 : 1);
    add(`LFSB-CHS-${m[2]}`, 2);
    return out;
  }

  m = s.match(/^CMSS-SOTM-([A-Z0-9]+)$/);
  if (m) {
    add(`LFSB-SOTM-${m[1]}`);
    return out;
  }

  m = s.match(/^CMSS-OTSB-([A-Z0-9]+)$/);
  if (m) {
    add(`LFSB-S-${m[1]}`);
    return out;
  }

  return null;
}

function pushComponent(out, sku, qty = 1) {
  const q = Math.max(0, Number(qty || 0));
  if (!sku || !q) return;
  for (let i = 0; i < q; i += 1) out.push(sku);
}

function explodeLittleLifelyBundleSku(sku, ckId) {
  const s = String(sku || '').toUpperCase().trim();
  // LLAU fabric swatch packs are sold/planned as packs. Keep demand and
  // velocity on LLAU-CB-CS-PACK, while stock is displayed from Cin7 virtual.
  if ((ckId === 'llau' || ckId === 'llnz') && s === 'LLAU-CB-CS-PACK') return null;

  // AU sells colour/size bed SET parent SKUs, while stock is held as one
  // size-level frame plus one colour/size cover. Funnel SET and combo sales
  // into the physical component SKUs so frame/cover velocity and deadstock are
  // not understated.
  if (ckId === 'llau' || ckId === 'llnz') {
    let auSet = s.match(/^LLAU-CB-(S|KS|D)-([A-Z0-9]+)-SET$/);
    if (auSet && auSet[2] !== 'FRM' && auSet[2] !== 'PACK' && !auSet[2].startsWith('CS')) {
      return [`LLAU-CB-${auSet[1]}-FRM`, `LLAU-CB-${auSet[1]}-${auSet[2]}-CV`];
    }
    auSet = s.match(/^LLAU-CBCF-(S|KS|D)-([A-Z0-9]+)(?:-SET)?$/);
    if (auSet) {
      const mattressMap = { S: 'DD-21915CF', KS: 'DD-21107CF', D: 'DD-21137CF' };
      return [`LLAU-CB-${auSet[1]}-FRM`, `LLAU-CB-${auSet[1]}-${auSet[2]}-CV`, mattressMap[auSet[1]]].filter(Boolean);
    }
  }

  // UK does not stock/display colour-specific bed SET rows in the planner.
  // Funnel SET and combo demand into the real component SKUs: one size-level
  // frame plus one colour/size cover. Mattress demand remains on LL Mattresses.
  if (ckId === 'lluk') {
    const set = parseLittleLifelyUkSetSku(s);
    if (set) return mapLittleLifelyUkSetToComponents(set.size, set.colour);
    const combo = s.match(/^LLUK-CBCF-(S|SD|D)-([A-Z0-9]+)$/);
    if (combo) return mapLittleLifelyUkSetToComponents(combo[1], combo[2], true);
  }

  const countrySetConfigs = {
    llna: { bedPrefix: 'LLNA-CB-', pattern: /^LLNA-CB-(TWX|TW|F)-([A-Z0-9]+)-SET$/ },
    llca: { bedPrefix: 'LLNA-CB-', pattern: /^LLNA-CB-(TWX|TW|F)-([A-Z0-9]+)-SET$/ },
    llsg: { bedPrefix: 'LLSG-CB-', pattern: /^LLSG-CB-(SS|S|Q)-([A-Z0-9]+)-SET$/ }
  };
  const setCfg = countrySetConfigs[ckId];
  if (setCfg) {
    const m = s.match(setCfg.pattern);
    if (m) return [`${setCfg.bedPrefix}${m[1]}-${m[2]}`, `${setCfg.bedPrefix}${m[1]}-${m[2]}-CV`];
  }

  const configs = {
    llau: { comboPrefix: 'LLAU-CBCF-', bedPrefix: 'LLAU-CB-', mattressMap: { S: 'DD-21915CF', KS: 'DD-21107CF', D: 'DD-21137CF' } },
    llnz: { comboPrefix: 'LLAU-CBCF-', bedPrefix: 'LLAU-CB-', mattressMap: { S: 'DD-21915CF', KS: 'DD-21107CF', D: 'DD-21137CF' } },
    'llau-cbcf': { comboPrefix: 'LLAU-CBCF-', bedPrefix: 'LLAU-CB-', mattressMap: { S: 'DD-21915CF', KS: 'DD-21107CF', D: 'DD-21137CF' } },
    llna: { comboPrefix: 'LLNA-CFDS-', bedPrefix: 'LLNA-CB-', mattressMap: {} },
    llca: { comboPrefix: 'LLNA-CFDS-', bedPrefix: 'LLNA-CB-', mattressMap: {} },
    llsg: { comboPrefix: 'LLSG-CFDS-', bedPrefix: 'LLSG-CB-', mattressMap: {} }
  };
  const cfg = configs[ckId];
  if (!cfg || !s.startsWith(cfg.comboPrefix)) return null;
  const rest = s.slice(cfg.comboPrefix.length);
  const parts = rest.split('-');
  const size = parts.shift();
  const colour = parts.join('-');
  if (!size || !colour) return null;
  const out = [`${cfg.bedPrefix}${size}-${colour}`];
  if (cfg.mattressMap[size]) out.push(cfg.mattressMap[size]);
  return out;
}

function explodeCushieSnuggleSetSku(sku, ckId) {
  const s = String(sku || '').toUpperCase().trim();
  if ((ckId === 'cusb-au' || ckId === 'cusb-au-snuggle') && s.startsWith('CUSB-') && s.endsWith('-SET')) {
    const cached = getCachedCin7BomComponentList(s);
    if (cached) return cached;
  }

  let m = s.match(/^(CUSB-(TW|D|Q|K)-([A-Z0-9]+))-SET$/);
  if (m && (ckId === 'cusb-au' || ckId === 'cusb-au-snuggle')) return [m[1], `${m[1]}-CV`];

  m = s.match(/^(CUSB-(TW|D|Q|K)-([A-Z0-9]+))-SET-UK$/);
  if (m && ckId === 'cusb-uk') return [`${m[1]}-UK`, `${m[1]}-UK-CV`];

  m = s.match(/^(V3-(TB|DB|QB|KB)-([A-Z0-9]+))-SET$/);
  if (m && ckId === 'cusb-us') return [m[1], `${m[1]}-CV`];
  return null;
}

function cushieUsComponentCode(version, rawCode) {
  const code = String(rawCode || '').toUpperCase().trim();
  if (!code) return null;
  if (code === 'ARMREST' || code === 'RMST') return version === 'V3' ? 'ARM' : 'RMST';
  return code;
}

function parseCushieUsBundleParts(body) {
  const parts = [];
  for (const rawPart of String(body || '').toUpperCase().split(/[+-]/).filter(Boolean)) {
    const partMatch = rawPart.match(/^(?:(\d+)X?|X)?([A-Z]+)$/);
    if (!partMatch) return null;
    parts.push({ qty: Number(partMatch[1] || 1), code: partMatch[2] });
  }
  return parts.length ? parts : null;
}

function inferCushieUsBundleVersion(parts, colour) {
  const codes = new Set((parts || []).map(part => part.code));
  // Unprefixed Cushie US Shopify SKUs are legacy V2 in current order data,
  // except when they use V3-only module codes such as KB. Explicit V3-* SKUs
  // are handled before this inference.
  if (codes.has('KB')) return 'V3';
  return 'V2';
}

function explodeCushieUsBundleSku(sku, ckId) {
  if (ckId !== 'cusb-us' && ckId !== 'cusb-ca') return null;
  const s = String(sku || '').toUpperCase().trim().replace(/-MULTI$/, '');
  let version, body, colour;

  // Canonical Cin7/Shopify bundle form, e.g. V2-BDL-2TB-CH-RMST-LGN.
  let m = s.match(/^(V[23])-BDL-(.+)-([A-Z0-9]+)$/);
  if (m) {
    [, version, body, colour] = m;
  } else {
    // Current Cushie US Shopify bundle form, e.g. V3-1XQB+ARMREST-LGN.
    // Some historical exports omit the V2/V3 prefix, e.g. 1XTB-ARMREST-CREAM
    // or direct module quantities such as 1XOS-CREAM.
    m = s.match(/^(?:(V[23])-)?(.+)-([A-Z0-9]+)$/);
    if (!m) return null;
    [, version, body, colour] = m;
    if (!/(?:\d+X|ARMREST|RMST)/.test(body)) return null;
    // Do not treat real component SKUs such as V2-RMST-CREAM as bundles.
    if (version && !/\d+X/.test(body) && !body.includes('+') && !body.includes('ARMREST')) return null;
  }

  const parts = parseCushieUsBundleParts(body);
  if (!parts) return null;
  version = version || inferCushieUsBundleVersion(parts, colour);

  const out = [];
  for (const part of parts) {
    const code = cushieUsComponentCode(version, part.code);
    if (!code) return null;
    pushComponent(out, `${version}-${code}-${colour}`, part.qty);
  }
  return out.length ? out : null;
}

function explodeCaseGoodsBundleSku(sku, ckId) {
  if (ckId !== 'case-goods') return null;
  const s = String(sku || '').toUpperCase().trim();
  if (s === 'RKU-SOFA-SET') return ['RKU-SOFA-2S-IVORY', 'RKU-OTM-IVORY'];
  const m = s.match(/^RAI-AMBR-(BLK|GRN|WHT)-4S(?:-SET)?$/);
  if (m) return ['RAI-DT100-OAK', ...Array.from({ length: 4 }, () => `AMBR-DC-${m[1]}`)];
  return null;
}

function explodeKnownBundleSkuForCk(sku, ckId) {
  const s = String(sku || '').toUpperCase().trim();
  if (!s) return null;
  const ll = explodeLittleLifelyBundleSku(s, ckId);
  if (ll) return ll;
  if (ckId === 'll-mattresses') {
    const au = s.match(/^LLAU-CBCF-(S|KS|D)-/);
    if (au) return [{ S: 'DD-21915CF', KS: 'DD-21107CF', D: 'DD-21137CF' }[au[1]]];
    const uk = s.match(/^LLUK-CBCF-(S|SD|D)-/);
    if (uk) return [{ S: 'DDUK-2190CF', SD: 'DDUK-21120CF', D: 'DDUK-21135CF' }[uk[1]]];
  }
  if (ckId === 'rdnt') {
    const radiantSet = explodeRadiantSetSku(s);
    if (radiantSet) return radiantSet.components;
    const cocoonRadiant = explodeCocoonRadiantCombo(s);
    if (cocoonRadiant) return cocoonRadiant.mattressComponents;
  }
  if (ckId === 'cocoon') {
    const cocoonDream = explodeCocoonDeepDreamCombo(s);
    if (cocoonDream) return [cocoonDream.bed];
    const cocoonRadiant = explodeCocoonRadiantCombo(s);
    if (cocoonRadiant) return [cocoonRadiant.bed];
  }
  if (ckId === 'dd') {
    const cocoonDream = explodeCocoonDeepDreamCombo(s);
    if (cocoonDream) return [cocoonDream.mattress];
  }
  if (ckId === 'cusb-au' || ckId === 'cusb-au-lifely') {
    const cushieModular = explodeCushieModularSku(s);
    if (cushieModular) return cushieModular;
  }
  if (ckId === 'cusb-au' || ckId === 'cusb-au-snuggle' || ckId === 'cusb-uk' || ckId === 'cusb-us' || ckId === 'cusb-ca') {
    const cushieSet = explodeCushieSnuggleSetSku(s, ckId);
    if (cushieSet) return cushieSet;
    const cushieUsBundle = explodeCushieUsBundleSku(s, ckId);
    if (cushieUsBundle) return cushieUsBundle;
    const cachedBom = getCachedCin7BomComponentList(s);
    if (cachedBom && cachedBom.some(componentSku => String(componentSku || '').toUpperCase().trim() !== s)) return cachedBom;
  }
  if (ckId === 'lifely-sofa') {
    const lifelySofa = explodeLifelySofaSku(s);
    if (lifelySofa) return lifelySofa.flatMap(row => Array.from({ length: Math.max(0, Number(row.qty || 0)) }, () => row.sku));
  }
  const caseGoods = explodeCaseGoodsBundleSku(s, ckId);
  if (caseGoods) return caseGoods;
  return null;
}

function explodeDemandSkuForCk(sku, ckId) {
  return explodeKnownBundleSkuForCk(sku, ckId);
}

function isCocoonComboSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  return /^COCOON-(KMF|QMF|DMF)-/.test(s) || s.startsWith('COCOON-RDNT-');
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
  cin7BOMs: {},        // make sku -> { components: { visibleSku -> qty } }
  cin7POs: [],        // [{reference, status, stage, arrival, items: {sku: qty}}]
  shopifyVelocity: {}, // store -> {sku -> weekly_velocity}
  shopifyInventory: {}, // store -> {sku -> inventory_level}
  shopifyOpenDemand: {}, // store -> { country -> { sku -> open qty } }
  shopifyVelocityByCountry: {}, // store -> { country -> { velocity/trend maps } }
  error: null
};
const CACHE_SNAPSHOT_PATH = path.join(__dirname, 'data', 'cache-snapshot.json');
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
function canonicalDemandSku(sku, country = '') {
  let s = String(sku || '').toUpperCase().trim();
  const c = String(country || '').toUpperCase().trim();
  if (c === 'US' || c === 'CA') s = mapCushieUsVerifiedSku(s);
  if (s.startsWith('LLUK-CBDS-')) return s.replace('LLUK-CBDS-', 'LLUK-CBCF-');
  const llauCombo = s.match(/^LLAU-CBCF-(S|KS|D)-(.+)$/);
  if (llauCombo && c && c !== 'AU' && c !== 'NZ') {
    const [, size, colour] = llauCombo;
    if (c === 'US' || c === 'CA') {
      const sizeMap = { S: 'TW', KS: 'TWX', D: 'F' };
      return `LLNA-CFDS-${sizeMap[size]}-${colour}`;
    }
    if (c === 'GB' || c === 'UK') {
      const sizeMap = { S: 'S', KS: 'SD', D: 'D' };
      return `LLUK-CBCF-${sizeMap[size]}-${colour}`;
    }
    if (c === 'SG') {
      const sizeMap = { S: 'S', KS: 'SS', D: 'Q' };
      return `LLSG-CFDS-${sizeMap[size]}-${colour}`;
    }
  }
  return s;
}


function skuOption1(sku, override = '') {
  return dataCache.cin7Products?.[sku]?.option1 || override || '';
}

function skuMatchesOption1(sku, def, override = '') {
  if (def.option1Bypass && def.option1Bypass(String(sku || '').toUpperCase())) return true;
  if (!def.option1) return true;
  const actual = normalizeOption1(skuOption1(sku, override));
  if (!actual) return false;
  const allowed = Array.isArray(def.option1) ? def.option1 : [def.option1];
  return allowed.some(value => normalizeOption1(value) === actual);
}

function isPlannerExcludedSku(sku) {
  return /CSTM$/i.test(String(sku || '').trim());
}

function visiblePlannerSkuMap(map = {}) {
  return Object.fromEntries(Object.entries(map || {}).filter(([sku]) => !isPlannerExcludedSku(sku)));
}

function visiblePlannerPo(po) {
  return {
    ...po,
    items: visiblePlannerSkuMap(po?.items),
    analyticsItems: visiblePlannerSkuMap(po?.analyticsItems),
    itemNames: visiblePlannerSkuMap(po?.itemNames),
    itemOption1: visiblePlannerSkuMap(po?.itemOption1)
  };
}

function sanitizePlannerSkuData(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizePlannerSkuData).filter(item => item !== undefined);
  }
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const identitySku = value.sku || value.productSku || value.productCode;
  if (isPlannerExcludedSku(identitySku)) return undefined;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (isPlannerExcludedSku(key)) continue;
    const sanitized = sanitizePlannerSkuData(child);
    if (sanitized !== undefined) clean[key] = sanitized;
  }
  return clean;
}

function skuMatchesDef(sku, def, option1Override = '') {
  if (isPlannerExcludedSku(sku)) return false;
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

function getCin7StockMetricBySku(branchIds = null, country = '', metric = 'openSales') {
  const branchSet = Array.isArray(branchIds) ? new Set(branchIds.map(id => String(id))) : null;
  const result = {};
  for (const [rawSku, branches] of Object.entries(dataCache.cin7StockByBranch || {})) {
    let qty = 0;
    for (const [branchId, row] of Object.entries(branches || {})) {
      if (branchSet && !branchSet.has(String(branchId))) continue;
      if (metric === 'preorder') qty += Math.max(-Number(row.available || 0), 0);
      else if (metric === 'available') qty += Number(row.available || 0);
      else if (metric === 'incoming') qty += Number(row.incoming || 0);
      else qty += Number(row.openSales || 0);
    }
    if (metric !== 'available' && qty <= 0) continue;
    const sku = canonicalDemandSku(rawSku, country);
    if (!sku) continue;
    result[sku] = (result[sku] || 0) + qty;
  }
  return result;
}

function getCin7OpenSalesBySku(branchIds = null, country = '') {
  return getCin7StockMetricBySku(branchIds, country, 'openSales');
}

function getCin7PreordersBySku(branchIds = null, country = '') {
  return getCin7StockMetricBySku(branchIds, country, 'preorder');
}

function parsePoDateValue(raw) {
  const key = parsePoDateKey(raw);
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(String(key))) return null;
  const d = new Date(`${key}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function poTabCrdDate(po) {
  return parsePoDateValue(po?.crd || po?.etd);
}

function poTabEtaDate(po) {
  return parsePoDateValue(po?.arrival || po?.estimatedArrivalDate);
}

function poTabOriginalEtaDate(po) {
  return parsePoDateValue(po?.customFields?.orders_1000);
}

function isPoInTransitForPoTab(po, now = new Date()) {
  if (!isOpenPO(po)) return false;
  const crd = poTabCrdDate(po);
  return !!(crd && crd <= now && hasContainerNumber(po));
}

function isPoOverdueForPoTab(po, now = new Date()) {
  if (!isOpenPO(po)) return false;
  const eta = poTabEtaDate(po);
  const originalEta = poTabOriginalEtaDate(po);
  if (eta) return eta <= now;
  if (originalEta) return originalEta <= now;
  return false;
}

function poTabStageLabel(po, now = new Date()) {
  if (isReceivedPO(po)) return 'RECEIVED';
  if (isPoOverdueForPoTab(po, now)) return 'OVERDUE';
  if (isPoInTransitForPoTab(po, now)) return 'IN TRANSIT';
  return 'OPEN';
}

function ckCategoryForSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  if (!s) return 'Uncategorised';
  for (const [id, def] of Object.entries(CK_DEFS)) {
    if (skuMatchesDef(s, def)) return def.name;
  }
  return 'Uncategorised';
}

function cin7Option1CategoriesForPoItems(items) {
  return Object.fromEntries(Object.keys(items || {}).map(sku => [sku, dataCache.cin7Products?.[sku]?.option1 || '']));
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
  if (s.startsWith('PAD-')) return false;
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

function maybePushCacheSnapshotToGit(reason = 'cin7-refresh', options = {}) {
  const force = !!options.force;
  const now = Date.now();
  const state = loadSnapshotPushState();
  // Scheduled refreshes avoid duplicate commits when runs happen close together.
  // Manual dashboard refreshes force this push so the refresh button persists the
  // new cache to GitHub immediately instead of only updating Render's ephemeral disk.
  if (cacheSnapshotPushInFlight) return Promise.resolve({ ok: false, pushed: false, skipped: 'push-in-flight' });
  if (!force && state.cacheLastSuccessAtMs && now - state.cacheLastSuccessAtMs < 30 * 60 * 1000) {
    return Promise.resolve({ ok: true, pushed: false, skipped: 'recent-cache-push' });
  }
  cacheSnapshotPushInFlight = true;
  const command = [
    'git add data/cache-snapshot.json data/po-eta-history.json data/po-eta-history.last-good.json',
    'if git diff --cached --quiet; then echo "No cache snapshot changes to commit"; exit 0; fi',
    `git commit -m "Update cache snapshot (${reason})"`,
    'git push'
  ].join(' && ');
  return new Promise(resolve => {
    exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
      cacheSnapshotPushInFlight = false;
      if (stdout) console.log(stdout.trim());
      if (stderr) console.log(stderr.trim());
      if (error) {
        if (error.code !== 0) console.error('Cache snapshot git push failed:', error.message);
        resolve({ ok: false, pushed: false, error: error.message });
        return;
      }
      saveSnapshotPushState({ ...state, cacheLastSuccessAtMs: Date.now(), cacheLastReason: reason, cachePushedAt: new Date().toISOString() });
      const pushed = !(stdout || '').includes('No cache snapshot changes to commit');
      console.log(pushed ? 'Cache snapshot pushed to GitHub' : 'Cache snapshot unchanged; no GitHub push needed');
      resolve({ ok: true, pushed, skipped: pushed ? null : 'no-cache-diff' });
    });
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

async function saveCacheSnapshot(pushToGit = false, pushReason = 'cin7-refresh', options = {}) {
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
      return { ok: false, wrote: false, pushed: false, error: 'empty-cin7-snapshot' };
    }

    updatePoEtaHistory(snapshot.cin7POs || [], snapshotTs);
    fs.mkdirSync(path.dirname(CACHE_SNAPSHOT_PATH), { recursive: true });
    const payload = JSON.stringify(snapshot);
    fs.writeFileSync(CACHE_SNAPSHOT_PATH, payload);
    console.log('Saved cache snapshot');
    const pushResult = pushToGit ? await maybePushCacheSnapshotToGit(pushReason, { force: !!options.forceGitPush }) : { ok: true, pushed: false, skipped: 'push-disabled' };
    return { ok: pushResult.ok !== false, wrote: true, pushed: !!pushResult.pushed, skipped: pushResult.skipped || null, error: pushResult.error || null };
  } catch (e) {
    console.error('Cache snapshot save failed:', e.message);
    return { ok: false, wrote: false, pushed: false, error: e.message };
  }
}

loadCacheSnapshot();

// Load landed costs from the single active cache.
// Current format: { landed_costs: { SKU: { cost, ... } } } from live Cin7 SalesOrders.
// Legacy Demand Planner format is still accepted only as a compatibility fallback.
let excelLandedCosts = {};
try {
  const landedPayload = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'landed-costs.json'), 'utf8'));
  const landedRows = landedPayload.landed_costs || landedPayload;
  for (const [sku, row] of Object.entries(landedRows || {})) {
    const landedPerUnit = Number(row.landedPerUnit ?? row.cost ?? row.latest_landed_cost_aud ?? 0);
    if (landedPerUnit > 0) {
      excelLandedCosts[sku] = {
        ...row,
        landedPerUnit,
        sohQty: Number(row.sohQty ?? row.lineCount60d ?? row.qtySold60d ?? 0),
        sohValue: Number(row.sohValue ?? 0),
        source: row.source || landedPayload.source || 'landed-costs.json'
      };
    }
  }
  console.log(`Loaded ${Object.keys(excelLandedCosts).length} landed costs from single cache`);
} catch (e) { console.log('No landed costs file found - will use estimated only'); }

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
          virtual: Number(row.virtual ?? row.stockOnHand ?? 0),
          available: Number(row.available || 0),
          openSales: Number(row.openSales || 0),
          incoming: Number(row.incoming || 0),
          branchName: row.branchName || ''
        };
      }
    } catch (e) { console.error(`CIN7 Stock page ${page} error:`, e.message); continue; }
  }

  for (const [sku, branches] of Object.entries(stockByBranch)) {
    const totalSoh = Object.values(branches).reduce((sum, b) => sum + (Number(b.soh) || 0), 0);
    const totalVirtual = Object.values(branches).reduce((sum, b) => sum + (Number(b.virtual ?? b.soh) || 0), 0);
    const totalAvailable = Object.values(branches).reduce((sum, b) => sum + (Number(b.available) || 0), 0);
    if (products[sku]) {
      products[sku].soh = totalSoh;
      products[sku].virtual = totalVirtual;
      products[sku].available = totalAvailable;
    } else {
      products[sku] = { soh: totalSoh, virtual: totalVirtual, available: totalAvailable, costAUD: 0, cbm: 0 };
    }
  }

  return { products, stockByBranch };
}

// ===== CIN7: FETCH BOM MASTERS =====
async function fetchCin7BOMMasters() {
  if (!CIN7_USER || !CIN7_KEY) return {};
  const auth = Buffer.from(`${CIN7_USER}:${CIN7_KEY}`).toString('base64');
  const boms = {};

  for (let page = 1; page <= 30; page++) {
    try {
      console.log('CIN7 BOMMasters: fetching page ' + page);
      let body, status, headers;
      try {
        await throttleCin7Request();
        const resp = await apiRequest({
          hostname: 'api.cin7.com',
          path: `/api/v1/BOMMasters?page=${page}&rows=250`,
          headers: { 'Authorization': `Basic ${auth}` }
        });
        body = resp.body;
        status = resp.status;
        headers = resp.headers || {};
      } catch (fetchErr) {
        console.error(`CIN7 BOMMasters page ${page} failed:`, fetchErr.message);
        break;
      }
      console.log('CIN7 BOMMasters page ' + page + ': status=' + status + ' isArray=' + Array.isArray(body) + ' length=' + (Array.isArray(body) ? body.length : 'N/A'));
      if (status === 429) {
        markCin7Backoff(`BOMMasters page ${page}`, parseInt(headers['retry-after'] || '0', 10));
        break;
      }
      if (!Array.isArray(body) || body.length === 0) break;
      for (const bom of body) {
        const product = bom.product || {};
        const productSku = String(product.code || '').toUpperCase().trim();
        if (!productSku) continue;
        const components = normalizeCin7BomComponents(product.components || []);
        if (!Object.keys(components).length) continue;
        boms[productSku] = { components, reference: bom.reference || '', modifiedDate: bom.modifiedDate || null };
      }
    } catch (e) { console.error(`CIN7 BOMMasters page ${page} error:`, e.message); break; }
  }

  return boms;
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
          freightDescription: po.freightDescription || '',
          surcharge: po.surcharge || 0,
          surchargeDescription: po.surchargeDescription || '',
          modifiedCOGSDate: po.modifiedCOGSDate || null,
          accountingAttributes: po.accountingAttributes || {},
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
          const sku = canonicalDemandSku(li.sku, country);
          if (sku) {
            const qty = li.quantity || 0;
            skuUnits[sku] = (skuUnits[sku] || 0) + qty;
            if (dt >= now7d) sku7d[sku] = (sku7d[sku] || 0) + qty;
            if (dt >= now30d) sku30d[sku] = (sku30d[sku] || 0) + qty;
            if (!skuFirstSeen[sku] || dt < skuFirstSeen[sku]) skuFirstSeen[sku] = dt;
            if (!skuWeekly[sku]) skuWeekly[sku] = {};
            skuWeekly[sku][weekKey] = (skuWeekly[sku][weekKey] || 0) + qty;

            if (countryBucket) {
              countryBucket.skuUnits[sku] = (countryBucket.skuUnits[sku] || 0) + qty;
              if (dt >= now7d) countryBucket.sku7d[sku] = (countryBucket.sku7d[sku] || 0) + qty;
              if (dt >= now30d) countryBucket.sku30d[sku] = (countryBucket.sku30d[sku] || 0) + qty;
              if (!countryBucket.skuFirstSeen[sku] || dt < countryBucket.skuFirstSeen[sku]) countryBucket.skuFirstSeen[sku] = dt;
              if (!countryBucket.skuWeekly[sku]) countryBucket.skuWeekly[sku] = {};
              countryBucket.skuWeekly[sku][weekKey] = (countryBucket.skuWeekly[sku][weekKey] || 0) + qty;
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
          const sku = canonicalDemandSku(li.sku, country);
          if (!sku) continue;
          const qty = Number(li.fulfillable_quantity ?? li.current_quantity ?? li.quantity ?? 0);
          if (qty <= 0) continue;
          openDemand[country][sku] = (openDemand[country][sku] || 0) + qty;
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
async function refreshAllData(forceCin7 = false, pushReason = null) {
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
      let cin7BOMs = {};
      let cin7POs = [];
      let fetchedCin7Count = 0;
      let fetchedBomCount = 0;
      let fetchedPoCount = 0;
      const cin7SkipReason = getCin7SkipReason(forceCin7);

      if (cin7SkipReason) {
        console.log(`Skipping CIN7 refresh, ${cin7SkipReason}. Reusing cached CIN7 data.`);
      } else {
        const cin7Data = await fetchCin7AllProducts();
        cin7Products = cin7Data.products || {};
        cin7StockByBranch = cin7Data.stockByBranch || {};
        cin7BOMs = await fetchCin7BOMMasters();
        cin7POs = await fetchCin7POs();
        fetchedCin7Count = Object.keys(cin7Products).length;
        fetchedBomCount = Object.keys(cin7BOMs).length;
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
        if (fetchedBomCount > 0) nextCache.cin7BOMs = cin7BOMs;
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

      let cacheSaveResult = { ok: true, wrote: false, pushed: false, skipped: 'no-source-updates' };
      if (cin7Updated || shopifyUpdated) {
        nextCache.error = Object.keys(nextCache.cin7Products || {}).length > 0 ? null : 'CIN7 data unavailable (likely rate limited)';
        dataCache = nextCache;
        const effectivePushReason = pushReason || (cin7Updated ? 'daily-cin7-refresh' : 'shopify-refresh');
        cacheSaveResult = await saveCacheSnapshot(true, effectivePushReason, { forceGitPush: effectivePushReason === 'manual-live-cin7-refresh' });
        loadCacheSnapshot(true);
        if (cin7Updated) refreshAIS();
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const liveCin7Count = Object.keys(dataCache.cin7Products).length;
      const livePoCount = dataCache.cin7POs.length;
      const liveBomCount = Object.keys(dataCache.cin7BOMs || {}).length;
      console.log(`Data refresh complete in ${elapsed}s. Fetched CIN7: ${fetchedCin7Count} SKUs, ${fetchedBomCount} BOMs, ${fetchedPoCount} POs. Live cache: ${liveCin7Count} SKUs, ${liveBomCount} BOMs, ${livePoCount} POs. Cache wrote=${cacheSaveResult.wrote} pushed=${cacheSaveResult.pushed} skipped=${cacheSaveResult.skipped || 'none'}.`);
      return { ok: true, cin7Updated, shopifyUpdated, cacheSaveResult, fetchedCin7Count, fetchedPoCount, lastRefresh: dataCache.lastRefresh };
    } catch (e) {
      console.error('Data refresh failed:', e.message);
      dataCache.error = e.message;
      return { ok: false, error: e.message, cacheSaveResult: { ok: false, wrote: false, pushed: false, error: e.message } };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ===== SKU NORMALIZATION =====
// CIN7 tracks multi-box products as SKU-1, SKU-2 etc.
// Shopify and sales use the base SKU. We need to merge box variants.
function normalizePoItemQuantities(items) {
  const result = {};
  const boxGroups = {};
  for (const [sku, qty] of Object.entries(items || {})) {
    const q = Number(qty || 0);
    const match = String(sku || '').match(/^(.+)-(\d)$/);
    if (match) {
      const base = match[1];
      if (!boxGroups[base]) boxGroups[base] = [];
      boxGroups[base].push(q);
    } else {
      result[sku] = (result[sku] || 0) + q;
    }
  }
  for (const [base, quantities] of Object.entries(boxGroups)) {
    // A boxed parent is only buildable up to the limiting carton quantity.
    result[base] = Math.max(result[base] || 0, Math.min(...quantities));
  }
  return result;
}

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
function normalizeSwatchPack(cin7) {
  const result = { ...cin7 };
  const pack = cin7['LLAU-CB-CS-PACK'];
  const packVirtual = typeof pack === 'object' ? Number(pack.virtual ?? pack.soh ?? 0) : Number(pack || 0);
  const swatchKeys = SWATCH_COLOURS.map(c => 'LLAU-CB-CS-' + c);
  const fallbackValues = swatchKeys.map(k => {
    const d = cin7[k];
    return typeof d === 'object' ? Number(d.virtual ?? d.soh ?? 0) : Number(d || 0);
  });
  const costs = swatchKeys.map(k => {
    const d = cin7[k];
    return typeof d === 'object' ? (d.costAUD || 0) : 0;
  });
  const packSoh = packVirtual || Math.min(...fallbackValues);
  const packCost = costs.reduce((a, b) => a + b, 0);
  result['LLAU-CB-CS-PACK'] = { ...(typeof pack === 'object' ? pack : {}), soh: packSoh, virtual: packSoh, available: packSoh, costAUD: packCost };
  return result;
}

// Shopify sells RDNT set/bundle SKUs, but CK rows should show the
// underlying physical components only. Demand from SET SKUs is funneled into
// RDNT-{size}-BASE and RDNT-{size}-{comfort} by explodeKnownBundleSkuForCk().
function normalizeRadiant(cin7, shopifySkus) {
  const result = {};
  for (const [sku, data] of Object.entries(cin7)) {
    if (sku.startsWith('RDNT-') && !sku.endsWith('-SET')) result[sku] = data;
  }
  return result;
}

// Cushie: keep parent/base rows visible, but collapse physical carton rows
// (-1/-2 and UK -C1/-C2) into the buildable parent by limiting carton stock.
// Example: CUSB-D-DNM-UK-C1=11 and -C2=11 => CUSB-D-DNM-UK=11, not 22.
function normalizeCushie(cin7Normalized) {
  const result = {};
  const cartonGroups = {};
  for (const [sku, data] of Object.entries(cin7Normalized || {})) {
    const parent = cushieCartonParentSku(sku);
    if (parent) {
      if (!cartonGroups[parent]) cartonGroups[parent] = [];
      cartonGroups[parent].push(data);
    } else {
      result[sku] = data;
    }
  }
  for (const [parent, cartons] of Object.entries(cartonGroups)) {
    const existing = result[parent];
    const cartonObjects = cartons.map(row => (typeof row === 'object' ? row : { soh: Number(row || 0), available: Number(row || 0), virtual: Number(row || 0) }));
    const soh = Math.min(...cartonObjects.map(row => Number(row.soh || 0)));
    const available = Math.min(...cartonObjects.map(row => Number(row.available ?? row.soh ?? 0)));
    const virtual = Math.min(...cartonObjects.map(row => Number(row.virtual ?? row.soh ?? 0)));
    const costAUD = cartonObjects.reduce((sum, row) => sum + Number(row.costAUD || 0), 0) || (typeof existing === 'object' ? Number(existing.costAUD || 0) : 0);
    const cbm = cartonObjects.reduce((sum, row) => sum + Number(row.cbm || 0), 0) || (typeof existing === 'object' ? Number(existing.cbm || 0) : 0);
    const option1 = cartonObjects.map(row => row.option1 || '').find(Boolean) || (typeof existing === 'object' ? existing.option1 || '' : '');
    result[parent] = { ...(typeof existing === 'object' ? existing : {}), soh, available, virtual, costAUD, cbm, option1 };
  }
  return result;
}

function cushieCartonParentSku(sku) {
  const s = String(sku || '').toUpperCase().trim();
  const m = s.match(/^(.+)-(?:[12]|C[12])$/);
  if (!m) return null;
  const suffix = s.slice(m[1].length + 1);
  return suffix === '1' || suffix === '2' || suffix === 'C1' || suffix === 'C2' ? m[1] : null;
}
function cushieCartonComponentsForParent(parentSku) {
  const parent = String(parentSku || '').toUpperCase().trim();
  if (!parent) return [];
  const components = Object.keys(dataCache.cin7Products || {})
    .map(sku => String(sku || '').toUpperCase().trim())
    .filter(sku => cushieCartonParentSku(sku) === parent)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return components;
}
function normalizeCushiePoItems(items) {
  const result = {};
  const cartonGroups = {};
  for (const [rawSku, rawQty] of Object.entries(items || {})) {
    const sku = String(rawSku || '').toUpperCase().trim();
    const qty = Number(rawQty || 0);
    if (!sku || !qty) continue;
    const parent = cushieCartonParentSku(sku);
    if (parent && (dataCache.cin7BOMs?.[parent] || dataCache.cin7Products?.[parent] || cushieCartonComponentsForParent(parent).length)) {
      if (!cartonGroups[parent]) cartonGroups[parent] = {};
      cartonGroups[parent][sku] = (cartonGroups[parent][sku] || 0) + qty;
    } else {
      result[sku] = (result[sku] || 0) + qty;
    }
  }
  for (const [parent, qtyByCarton] of Object.entries(cartonGroups)) {
    const requiredCartons = cushieCartonComponentsForParent(parent);
    const cartonsToUse = requiredCartons.length ? requiredCartons : Object.keys(qtyByCarton);
    const completeUnits = cartonsToUse.length
      ? Math.min(...cartonsToUse.map(sku => Number(qtyByCarton[sku] || 0)))
      : 0;
    if (completeUnits > 0) result[parent] = Math.max(Number(result[parent] || 0), completeUnits);
  }
  return result;
}

function cushieProductTypeForSku(sku, option1 = '') {
  const s = String(sku || '').toUpperCase().trim();
  const o = String(option1 || '').toLowerCase();
  if (s.endsWith('-SC') || s.includes('-CV') || /slip\s*cover|slipcover/.test(o)) return 'Slipcover';
  if (s.startsWith('V3-') || o.includes('v3') || o.includes('snuggle')) return 'V3';
  if (s.startsWith('V2-') || s.startsWith('CUSB') || s.startsWith('LFSB') || o.includes('v2') || o.includes('lifely sofa')) return 'V2';
  return 'Other';
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
    if (ckId === 'cocoon' && isCocoonComboSku(sku)) continue;
    if (skuMatchesDef(sku, def)) {
      if (stockBranches && Array.isArray(stockBranches)) {
        const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
        const branchData = stockBranches.reduce((acc, branchId) => {
          const row = branchRows[branchId];
          if (!row) return acc;
          acc.soh += Number(row.soh || 0);
          acc.virtual += Number(row.virtual ?? row.soh ?? 0);
          acc.available += Number(row.available || 0);
          acc.openSales += Number(row.openSales || 0);
          acc.matched += 1;
          return acc;
        }, { soh: 0, virtual: 0, available: 0, openSales: 0, matched: 0 });
        const displaySoh = ckId === 'case-goods' && dataCache.cin7BOMs?.[sku] ? branchData.virtual : branchData.soh;
        cin7Raw[sku] = branchData.matched > 0
          ? { ...data, soh: displaySoh, virtual: branchData.virtual, available: branchData.available }
          : { ...data, soh: 0, virtual: 0, available: 0 };
      } else {
        cin7Raw[sku] = ckId === 'case-goods' && dataCache.cin7BOMs?.[sku]
          ? { ...data, soh: Number(data.virtual ?? data.soh ?? 0) }
          : data;
      }
    }
  }

  // Normalize: merge box-splits, map components to sets
  let cin7Normalized = normalizeCIN7(cin7Raw);
  if (ckId === 'case-goods') {
    for (const sku of Object.keys(cin7Normalized)) {
      if (!dataCache.cin7BOMs?.[sku]) continue;
      const source = dataCache.cin7Products?.[sku] || cin7Normalized[sku] || {};
      const virtual = Number(source.virtual ?? source.soh ?? 0);
      cin7Normalized[sku] = { ...(typeof cin7Normalized[sku] === 'object' ? cin7Normalized[sku] : {}), ...source, soh: virtual, virtual };
    }
  }
  // Lifely Sofa should show true physical component/carton SKUs. Do not merge
  // component boxes back into sellable combo parents such as LIFELY-OTM-WHT.
  if (ckId === 'lifely-sofa') cin7Normalized = { ...cin7Raw };

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

  // Shopify inventory. Bundle/config SKUs are not displayed as rows; their
  // inventory signal is pushed down to component SKUs when a BOM is known.
  const shopify = {};
  const openOrders = {};
  const panelHasSku = (sku) => cin7[sku] !== undefined || shopify[sku] !== undefined || skuMatchesDef(sku, def);
  const addToPanelMap = (map, sku, qty) => {
    if (!sku || !panelHasSku(sku)) return false;
    map[sku] = (map[sku] || 0) + Number(qty || 0);
    return true;
  };
  const addExplodedToPanelMap = (map, sku, qty) => {
    const components = explodeDemandSkuForCk(sku, ckId);
    if (!components) return false;
    let added = false;
    for (const componentSku of components) added = addToPanelMap(map, componentSku, qty) || added;
    return added;
  };
  for (const sourceStore of relatedStores) {
    const storeInv = dataCache.shopifyInventory[sourceStore] || {};
    for (const [rawSku, qty] of Object.entries(storeInv)) {
      const sku = (ckId === 'cusb-us' || ckId === 'cusb-ca') ? mapCushieUsVerifiedSku(rawSku) : String(rawSku || '').toUpperCase().trim();
      if (ckId === 'cocoon' && isCocoonComboSku(sku)) { addExplodedToPanelMap(shopify, sku, qty); continue; }
      if (addExplodedToPanelMap(shopify, sku, qty)) continue;
      if (!skuMatchesDef(sku, def)) continue;
      shopify[sku] = (shopify[sku] || 0) + qty;
    }
  }

  const marketDemandSku = (sku) => {
    const s = String(sku || '').toUpperCase().trim();
    if (ckId !== 'cusb-uk') return s;
    let m = s.match(/^V3-(TB|DB|QB|KB)-([A-Z0-9]+)$/);
    if (m) return `CUSB-${{ TB: 'TW', DB: 'D', QB: 'Q', KB: 'K' }[m[1]]}-${m[2]}-UK`;
    m = s.match(/^V3-ARM-([A-Z0-9]+)$/);
    if (m) return `CUSB-ARST-SET-${m[1]}-UK`;
    m = s.match(/^V2-(TB|DB|QB|RMST|OS)-([A-Z0-9]+)$/);
    if (m) {
      const code = { TB: 'TW', DB: 'D', QB: 'Q', RMST: 'AMST', OS: 'SOTM' }[m[1]];
      return `LFSB-${code}-${m[2]}-UK`;
    }
    return s;
  };
  const visibleDemandSku = (sku) => {
    let s = String(sku || '').toUpperCase().trim();
    if (!s) return { sku: '', boxSplit: false };
    s = marketDemandSku(s);
    if (cin7[s] !== undefined || shopify[s] !== undefined) return { sku: s, boxSplit: false };
    const cartonParent = cushieCartonParentSku(s);
    if (cartonParent && cin7[cartonParent] !== undefined) return { sku: cartonParent, boxSplit: true };
    const box = s.match(/^(.+)-\d$/);
    if (box && cin7[box[1]] !== undefined) return { sku: box[1], boxSplit: true };
    return { sku: s, boxSplit: false };
  };
  const addVisibleDemandQty = (target, sku, qty, boxSplit = false) => {
    if (!sku || !(cin7[sku] !== undefined || shopify[sku] !== undefined)) return;
    const q = Number(qty || 0);
    if (boxSplit) target[sku] = Math.max(Number(target[sku] || 0), q);
    else target[sku] = (target[sku] || 0) + q;
  };
  const addCin7DemandToVisibleMap = (source, target, country = '') => {
    for (const [rawDemandSku, qty] of Object.entries(source || {})) {
      const demandSku = canonicalDemandSku(rawDemandSku, country);
      const q = Number(qty || 0);
      if (!q) continue;
      const exploded = explodeDemandSkuForCk(demandSku, ckId);
      if (exploded) {
        for (const componentSku of exploded) {
          const visible = visibleDemandSku(componentSku);
          addVisibleDemandQty(target, visible.sku, q, visible.boxSplit);
        }
        continue;
      }
      const visible = visibleDemandSku(demandSku);
      addVisibleDemandQty(target, visible.sku, q, visible.boxSplit);
    }
  };

  const usesMarketOpenOrders = ckId === 'llau' || ckId === 'llau-cbcf' || ckId === 'llnz' || ckId === 'llna' || ckId === 'llca' || ckId === 'lluk' || ckId === 'llsg' || ckId === 'cusb-au' || ckId.startsWith('cusb-au-') || ckId === 'cusb-us' || ckId === 'cusb-ca' || ckId === 'cusb-uk';

  // Country panels use Cin7 open sales/open orders as the preorder source of truth.
  // CIN7 SOH stays branch-filtered from /Stock above, and oversold/open orders now come from the same Cin7 branch stock rows.
  if (usesMarketOpenOrders) {
    const demandCountry = ckId === 'llau' || ckId === 'llau-cbcf' || ckId === 'cusb-au' || ckId.startsWith('cusb-au-')
      ? 'AU'
      : ckId === 'llca'
        ? 'CA'
        : ckId === 'cusb-ca'
          ? 'CA'
        : ckId === 'llnz'
          ? 'NZ'
          : ckId === 'lluk'
            ? 'GB'
            : ckId === 'llsg'
              ? 'SG'
              : 'US';
    const openDemandByVisibleSku = {};
    addCin7DemandToVisibleMap(getCin7PreordersBySku(stockBranches, demandCountry), openDemandByVisibleSku, demandCountry);
    addCin7DemandToVisibleMap(getCin7OpenSalesBySku(stockBranches, demandCountry), openOrders, demandCountry);
    for (const sku of Object.keys(cin7)) {
      shopify[sku] = -Number(openDemandByVisibleSku[sku] || 0);
      openOrders[sku] = Number(openOrders[sku] || 0);
    }
  }

  if (!usesMarketOpenOrders) {
    const openDemandByVisibleSku = {};
    addCin7DemandToVisibleMap(getCin7PreordersBySku(stockBranches, salesCountry || ''), openDemandByVisibleSku, salesCountry || '');
    addCin7DemandToVisibleMap(getCin7OpenSalesBySku(stockBranches, salesCountry || ''), openOrders, salesCountry || '');
    for (const sku of Object.keys(cin7)) {
      shopify[sku] = -Number(openDemandByVisibleSku[sku] || 0);
      openOrders[sku] = Number(openOrders[sku] || 0);
    }
  }

  // Velocity
  const velocity = {};
  const mergeVelocitySource = (source, country = '') => {
    for (const [rawSku, vel] of Object.entries(source || {})) {
      if (String(rawSku || '').startsWith('_')) continue;
      const sku = canonicalDemandSku(rawSku, country);
      const exploded = explodeDemandSkuForCk(sku, ckId);
      if (exploded) {
        for (const componentSku of exploded) {
          const visible = visibleDemandSku(componentSku);
          if (cin7[visible.sku] !== undefined || shopify[visible.sku] !== undefined || velocity[visible.sku] !== undefined) {
            velocity[visible.sku] = (velocity[visible.sku] || 0) + Number(vel || 0);
          }
        }
        continue;
      }
      if (ckId === 'cocoon' && isCocoonComboSku(sku)) continue;
      if (!skuMatchesDef(sku, def)) continue;
      velocity[sku] = (velocity[sku] || 0) + Number(vel || 0);
    }
  };

  if (salesCountry) {
    for (const sourceStore of relatedStores) {
      mergeVelocitySource(dataCache.shopifyVelocityByCountry?.[sourceStore]?.[salesCountry] || {}, salesCountry);
    }
  } else {
    for (const sourceStore of relatedStores) {
      mergeVelocitySource(dataCache.shopifyVelocity?.[sourceStore] || {}, '');
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
      if (ckId === 'cocoon' && isCocoonComboSku(sku)) continue;
      if (skuMatchesDef(sku, def, po.itemOption1?.[sku]) || (ckId === 'llau' && ['DD-21915CF','DD-21107CF','DD-21137CF'].includes(sku))) {
        relevantItems[sku] = qty;
      }
    }
    if (Object.keys(relevantItems).length > 0) {
      const normalizedPoItems = ckId.startsWith('cusb')
        ? normalizeCushiePoItems(relevantItems)
        : (ckId === 'lifely-sofa' ? relevantItems : normalizePoItemQuantities(relevantItems));
      allPos.push({ ...po, items: relevantItems, analyticsItems: normalizedPoItems });
      if (isOpenPO(po)) {
        pos.push({ ...po, items: relevantItems, analyticsItems: normalizedPoItems });
      }
    }
  }

  const incoming = {};
  for (const po of pos || []) {
    for (const [sku, qty] of Object.entries(po.analyticsItems || po.items || {})) {
      incoming[sku] = (incoming[sku] || 0) + Number(qty || 0);
    }
  }

  // Build human-readable names from SKU + best-known supplier by SKU from CIN7 POs
  const names = {};
  const suppliers = {};
  const allSkus = new Set([...Object.keys(cin7), ...Object.keys(velocity), ...Object.keys(shopify)]);
  const productTypes = {};
  for (const sku of allSkus) {
    names[sku] = sku; // Default to SKU code; frontend can prettify
    if (ckId.startsWith('cusb')) {
      productTypes[sku] = cushieProductTypeForSku(sku, dataCache.cin7Products?.[sku]?.option1 || cin7Normalized?.[sku]?.option1 || '');
    }
  }
  for (const po of dataCache.cin7POs || []) {
    const company = po.company || '';
    if (!company) continue;
    for (const sku of Object.keys(po.items || {})) {
      if (ckId === 'cocoon' && isCocoonComboSku(sku)) continue;
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
    lluk: { demandCountry: 'GB', bedPrefix: 'LLUK-CB-', comboPrefix: 'LLUK-CBCF-', componentMode: 'frame-cover', mattressMap: { S: 'DDUK-2190CF', SD: 'DDUK-21120CF', D: 'DDUK-21135CF' }, mattressSkus: ['DDUK-2190CF', 'DDUK-21120CF', 'DDUK-21135CF'] },
    llsg: { demandCountry: 'SG', bedPrefix: 'LLSG-CB-', comboPrefix: 'LLSG-CFDS-', mattressMap: {}, mattressSkus: [] }
  };
  const coverageConfig = littleLifelyCoverageConfigs[ckId];
  if (coverageConfig) {
    const openDemandBySku = {};
    for (const [rawSku, qty] of Object.entries(getCin7PreordersBySku(stockBranches, coverageConfig.demandCountry))) {
      const sku = canonicalDemandSku(rawSku, coverageConfig.demandCountry);
      const q = Number(qty || 0);
      // Keep raw bundle/combo demand here. The frontend uses those raw combo
      // keys to calculate component coverage without double-counting them as
      // both combo demand and component demand. Visible rows still get their
      // component-level open-order values from DATA.shopify above.
      openDemandBySku[sku] = (openDemandBySku[sku] || 0) + q;
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

  // Generic preorder / coverage support for Lifely category panels.
  // Little Lifely has special bed+mattress bundle logic above. Lifely CKs use
  // direct SKU open-demand and PO rows so the dashboard can show the same
  // Preorders / Next PO / Coverage columns without mixing category membership.
  const lifelyCoverageIds = new Set(['dd', 'cocoon', 'rdnt', 'wfhcr', 'airflow-pad', 'lifely-sofa', 'caterpillar']);
  if (!coverageAux && lifelyCoverageIds.has(ckId)) {
    const openDemandBySku = {};
    const rawOpenDemandBySku = {};
    let rawOpenDemandTotal = 0;
    const panelSkuSet = new Set([...Object.keys(cin7), ...Object.keys(velocity), ...Object.keys(shopify)]);
    const addOpenDemand = (sku, qty) => {
      if (!sku || !panelSkuSet.has(sku)) return false;
      openDemandBySku[sku] = (openDemandBySku[sku] || 0) + Number(qty || 0);
      return true;
    };
    const addRawOpenDemand = (sku, qty) => {
      rawOpenDemandBySku[sku] = (rawOpenDemandBySku[sku] || 0) + Number(qty || 0);
      rawOpenDemandTotal += Number(qty || 0);
    };
    for (const [sku, qty] of Object.entries(getCin7PreordersBySku(stockBranches, salesCountry || ''))) {
      const q = Number(qty || 0);
      if (!q) continue;
      const exploded = explodeDemandSkuForCk(sku, ckId);
      if (exploded) {
        let added = false;
        for (const componentSku of exploded) added = addOpenDemand(componentSku, q) || added;
        if (added) addRawOpenDemand(sku, q);
        continue;
      }
      if (addOpenDemand(sku, q)) addRawOpenDemand(sku, q);
    }
    const stockBySku = Object.fromEntries(Object.keys(cin7).map(sku => [sku, { soh: Number(cin7[sku] || 0), available: Number(cin7Available[sku] || cin7[sku] || 0) }]));
    const poRows = {};
    for (const po of pos || []) {
      const etaRaw = po.arrival || po.estimatedArrivalDate || null;
      for (const [sku, qty] of Object.entries(po.analyticsItems || po.items || {})) {
        if (cin7[sku] === undefined && velocity[sku] === undefined && shopify[sku] === undefined) continue;
        if (!poRows[sku]) poRows[sku] = [];
        poRows[sku].push({ reference: po.reference, qty: Number(qty || 0), eta: etaRaw });
      }
    }
    coverageAux = { mode: 'generic', label: def.name, place: 'Lifely', openDemandBySku, rawOpenDemandBySku, rawOpenDemandTotal, stockBySku, poRows };
  }
  let warehouseOptions = null;
  let warehouseViews = null;
  if (ckId === 'airflow-pad') {
    const airflowCountryConfigs = [
      { id: 'AU', name: 'Australia', branchIds: LL_AU_BRANCH_IDS, salesCountry: 'AU', destination: 'Australia' },
      { id: 'US', name: 'United States', branchIds: LL_US_BRANCH_IDS, salesCountry: 'US', destination: 'United States' },
      { id: 'CA', name: 'Canada', branchIds: [61831], salesCountry: 'CA', destination: 'Canada' },
      { id: 'UK', name: 'United Kingdom', branchIds: [62444], salesCountry: 'GB', destination: 'United Kingdom' }
    ];
    const airflowStores = ['lifely', 'cushie', 'littlelifely'];
    warehouseOptions = [{ id: 'All', name: 'All countries' }, ...airflowCountryConfigs.map(cfg => ({ id: cfg.id, name: cfg.name }))];
    warehouseViews = {};
    const buildAirflowCountryView = cfg => {
      const viewCin7 = {};
      const viewAvailable = {};
      const viewOpenOrders = {};
      const viewShopify = {};
      const viewIncoming = {};
      const viewVelocity = {};
      const viewPos = [];
      const panelSkus = new Set(Object.keys(cin7 || {}).filter(sku => sku.startsWith('PAD-')));
      const branchSet = new Set(cfg.branchIds.map(String));
      for (const sku of panelSkus) {
        const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
        const branchData = cfg.branchIds.reduce((acc, branchId) => {
          const row = branchRows[branchId];
          if (!row) return acc;
          acc.soh += Number(row.soh || 0);
          acc.available += Number(row.available || 0);
          acc.matched += 1;
          return acc;
        }, { soh: 0, available: 0, matched: 0 });
        if (branchData.matched > 0 && (branchData.soh !== 0 || branchData.available !== 0)) {
          viewCin7[sku] = branchData.soh;
          viewAvailable[sku] = branchData.available;
        }
      }
      for (const [sku, qty] of Object.entries(getCin7OpenSalesBySku(cfg.branchIds, cfg.salesCountry))) {
        if (!panelSkus.has(sku)) continue;
        viewOpenOrders[sku] = (viewOpenOrders[sku] || 0) + Number(qty || 0);
      }
      for (const [sku, qty] of Object.entries(getCin7PreordersBySku(cfg.branchIds, cfg.salesCountry))) {
        if (!panelSkus.has(sku)) continue;
        viewShopify[sku] = (viewShopify[sku] || 0) - Number(qty || 0);
      }
      for (const po of dataCache.cin7POs || []) {
        if (!isOpenPO(po)) continue;
        if (resolvePoDestination(po) !== cfg.destination) continue;
        const relevantItems = {};
        const normalizedItems = po.analyticsItems || po.items || {};
        for (const [sku, qty] of Object.entries(normalizedItems)) {
          if (!panelSkus.has(sku)) continue;
          const q = Number(qty || 0);
          if (!q) continue;
          viewIncoming[sku] = (viewIncoming[sku] || 0) + q;
          relevantItems[sku] = q;
        }
        if (Object.keys(relevantItems).length) viewPos.push({ ...po, analyticsItems: relevantItems });
      }
      for (const sourceStore of airflowStores) {
        const source = dataCache.shopifyVelocityByCountry?.[sourceStore]?.[cfg.salesCountry] || {};
        for (const [sku, vel] of Object.entries(source)) {
          if (!panelSkus.has(sku) || String(sku).startsWith('_')) continue;
          viewVelocity[sku] = (viewVelocity[sku] || 0) + Number(vel || 0);
        }
      }
      for (const sku of panelSkus) {
        if (viewCin7[sku] !== undefined || viewAvailable[sku] !== undefined || viewOpenOrders[sku] || viewShopify[sku] || viewIncoming[sku] || viewVelocity[sku]) continue;
        delete viewCin7[sku];
      }
      const includedSkus = new Set([...Object.keys(viewCin7), ...Object.keys(viewAvailable), ...Object.keys(viewOpenOrders), ...Object.keys(viewShopify), ...Object.keys(viewIncoming), ...Object.keys(viewVelocity)]);
      for (const sku of includedSkus) {
        if (viewCin7[sku] === undefined) viewCin7[sku] = 0;
        if (viewAvailable[sku] === undefined) viewAvailable[sku] = viewCin7[sku] || 0;
        if (viewOpenOrders[sku] === undefined) viewOpenOrders[sku] = 0;
        if (viewShopify[sku] === undefined) viewShopify[sku] = 0;
        if (viewIncoming[sku] === undefined) viewIncoming[sku] = 0;
        if (viewVelocity[sku] === undefined) viewVelocity[sku] = 0;
      }
      return { cin7: viewCin7, available: viewAvailable, openOrders: viewOpenOrders, shopify: viewShopify, incoming: viewIncoming, velocity: viewVelocity, pos: viewPos, allPos: viewPos };
    };
    for (const cfg of airflowCountryConfigs) warehouseViews[cfg.id] = buildAirflowCountryView(cfg);
  }
  const warehouseBranchConfigs = {
    llau: LL_AU_BRANCH_IDS,
    llna: LL_US_BRANCH_IDS
  };
  if (warehouseBranchConfigs[ckId]) {
    const branchIds = warehouseBranchConfigs[ckId];
    const branchName = branchId => {
      for (const rows of Object.values(dataCache.cin7StockByBranch || {})) {
        const row = rows?.[branchId];
        if (row?.branchName) return row.branchName;
      }
      return `Warehouse ${branchId}`;
    };
    warehouseOptions = [
      { id: 'All', name: 'All warehouses' },
      ...branchIds.map(id => ({ id: String(id), name: branchName(String(id)) }))
    ];
    warehouseViews = {};
    const buildCin7ForBranchIds = ids => {
      const branchRaw = {};
      for (const [sku, data] of Object.entries(dataCache.cin7Products || {})) {
        if (!skuMatchesDef(sku, def)) continue;
        const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
        const branchData = ids.reduce((acc, branchId) => {
          const row = branchRows[branchId];
          if (!row) return acc;
          acc.soh += Number(row.soh || 0);
          acc.available += Number(row.available || 0);
          acc.openSales += Number(row.openSales || 0);
          acc.matched += 1;
          return acc;
        }, { soh: 0, available: 0, openSales: 0, matched: 0 });
        branchRaw[sku] = branchData.matched > 0 ? { ...data, soh: branchData.soh, available: branchData.available } : { ...data, soh: 0, available: 0 };
      }
      let normalized = normalizeCIN7(branchRaw);
      if (ckId === 'llau') normalized = normalizeSwatchPack(normalized);
      return normalized;
    };
    const buildBranchView = ids => {
      const viewCin7 = {};
      const viewAvailable = {};
      const viewOpenOrders = {};
      const viewShopify = {};
      const viewIncoming = {};
      const viewCoverageOpenDemandBySku = {};
      const viewCoverageStockBySku = {};
      const branchNormalized = buildCin7ForBranchIds(ids);
      for (const [sku, data] of Object.entries(branchNormalized)) {
        viewCin7[sku] = typeof data === 'object' ? Number(data.soh || 0) : Number(data || 0);
        viewAvailable[sku] = typeof data === 'object' ? Number(data.available || 0) : viewCin7[sku];
        viewOpenOrders[sku] = 0;
        viewShopify[sku] = 0;
        viewIncoming[sku] = 0;
        viewCoverageStockBySku[sku] = { soh: viewCin7[sku], available: viewAvailable[sku] };
      }
      if (ckId === 'llau') {
        for (const sku of ['DD-21915CF', 'DD-21107CF', 'DD-21137CF']) {
          const branchRows = dataCache.cin7StockByBranch?.[sku] || {};
          const branchData = ids.reduce((acc, branchId) => {
            const row = branchRows[branchId];
            if (!row) return acc;
            acc.soh += Number(row.soh || 0);
            acc.available += Number(row.available || 0);
            return acc;
          }, { soh: 0, available: 0 });
          viewCoverageStockBySku[sku] = { soh: branchData.soh, available: branchData.available };
        }
      }
      const branchOpenDemand = getCin7PreordersBySku(ids, salesCountry || '');
      const branchOpenSales = getCin7OpenSalesBySku(ids, salesCountry || '');
      const branchIncoming = getCin7StockMetricBySku(ids, salesCountry || '', 'incoming');
      for (const [rawSku, qty] of Object.entries(branchOpenDemand)) {
        const sku = canonicalDemandSku(rawSku, salesCountry || '');
        viewCoverageOpenDemandBySku[sku] = (viewCoverageOpenDemandBySku[sku] || 0) + Number(qty || 0);
      }
      addCin7DemandToVisibleMap(branchOpenDemand, viewShopify, salesCountry || '');
      addCin7DemandToVisibleMap(branchOpenSales, viewOpenOrders, salesCountry || '');
      addCin7DemandToVisibleMap(branchIncoming, viewIncoming, salesCountry || '');
      for (const sku of Object.keys(viewCin7)) {
        viewShopify[sku] = -Number(viewShopify[sku] || 0);
        viewOpenOrders[sku] = Number(viewOpenOrders[sku] || 0);
        viewIncoming[sku] = Number(viewIncoming[sku] || 0);
      }
      return { cin7: viewCin7, available: viewAvailable, openOrders: viewOpenOrders, shopify: viewShopify, incoming: viewIncoming, coverageOpenDemandBySku: viewCoverageOpenDemandBySku, coverageStockBySku: viewCoverageStockBySku };
    };
    for (const branchId of branchIds) warehouseViews[String(branchId)] = buildBranchView([branchId]);
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
      // Open orders are sourced from Cin7 open sales below, not Shopify.
    }

    for (const [sku, qty] of Object.entries(getCin7PreordersBySku(stockBranches || LL_AU_BRANCH_IDS, 'AU'))) {
      aggregatedOpenDemand[sku] = (aggregatedOpenDemand[sku] || 0) + Number(qty || 0);
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

  // Cocoon combos (COCOON-KMF/QMF/DMF-* and COCOON-RDNT-*) are intentionally
  // excluded from the Cocoon tab. The team only wants the Cocoon view to show
  // non-combo Cocoon SKUs, not DD/Radiant combo dependency panels.

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
  const keepInactiveForPanel = ckId === 'll-mattresses' || ckId === 'dd' || ckId === 'lifely-sofa' || ckId === 'airflow-pad' || ckId === 'llau' || ckId === 'llna' || ckId === 'llca';
  for (const sku of Object.keys(cin7)) {
    if (!keepInactiveForPanel && inactiveSet.has(sku)) { delete cin7[sku]; delete velocity[sku]; delete shopify[sku]; }
  }
  for (const sku of Object.keys(velocity)) {
    if (!keepInactiveForPanel && inactiveSet.has(sku)) { delete velocity[sku]; }
  }

  // Cushie V2 Dark Grey is intentionally excluded from the Canada panel.
  // Remove it after demand explosion too, otherwise Canadian bundle velocity can
  // reintroduce DKGY component rows after the initial Cin7 product filter.
  if (ckId === 'cusb-ca') {
    for (const sku of new Set([...Object.keys(cin7), ...Object.keys(shopify), ...Object.keys(velocity)])) {
      if (!isCushieCanadaExcludedSku(sku)) continue;
      delete cin7[sku];
      delete cin7Available[sku];
      delete shopify[sku];
      delete openOrders[sku];
      delete incoming[sku];
      delete velocity[sku];
      delete costs[sku];
      delete cbmMap[sku];
    }
  }

  // Final row guard: known bundle/config SKUs must not appear as CK rows.
  // Their demand/velocity was already funneled into component SKUs above.
  for (const sku of new Set([...Object.keys(cin7), ...Object.keys(shopify), ...Object.keys(velocity)])) {
    if (!explodeDemandSkuForCk(sku, ckId)) continue;
    delete cin7[sku];
    delete cin7Available[sku];
    delete shopify[sku];
    delete velocity[sku];
    delete costs[sku];
    delete cbmMap[sku];
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

  // WFH Chair has CBM, but the landed-cost cache can contain an actual
  // landed row with Freight/u = 0. When freight is missing/zero, use the latest
  // open WFH PO's freight + customs/charges evenly per unit so Freight/u is not blank.
  if (ckId === 'wfhcr') {
    const latestWfhPo = (allPos || [])
      .filter(po => isOpenPO(po) && Object.keys(po.items || {}).some(sku => String(sku || '').toUpperCase().startsWith('WFHCR')))
      .sort((a, b) => {
        const da = new Date(a.arrival || a.estimatedArrivalDate || a.etd || 0).getTime() || 0;
        const db = new Date(b.arrival || b.estimatedArrivalDate || b.etd || 0).getTime() || 0;
        if (db !== da) return db - da;
        return String(rawPoReference(b.reference)).localeCompare(String(rawPoReference(a.reference)), undefined, { numeric: true });
      })[0];
    if (latestWfhPo) {
      const destination = inferDestination(latestWfhPo);
      const landed = estimateLandedCost(latestWfhPo, destination);
      const surchargeAud = moneyToAud(latestWfhPo.surcharge || 0, latestWfhPo.currencyCode || 'AUD');
      const wfhItems = Object.entries(latestWfhPo.items || {}).filter(([sku]) => String(sku || '').toUpperCase().startsWith('WFHCR'));
      const totalUnits = wfhItems.reduce((sum, [, qty]) => sum + Number(qty || 0), 0);
      const totalFreightCharges = Number(landed.freight || 0) + Number(landed.tariffAmount || 0) + surchargeAud;
      if (totalUnits > 0 && totalFreightCharges > 0) {
        const freightPerUnit = totalFreightCharges / totalUnits;
        for (const [sku] of wfhItems) {
          if (SKIP_LANDED(sku)) continue;
          const existing = landedCosts[sku];
          if (existing && Number(existing.freightPerUnit || 0) > 0) continue;
          const fob = (existing?.fob || (costs ? costs[sku] : 0)) || 0;
          landedCosts[sku] = { fob, freightPerUnit, tariffPerUnit: 0, landedPerUnit: fob + freightPerUnit, cbm: cbmMap[sku] || existing?.cbm || 0, source: 'estimated', poCount: 1, poRef: rawPoReference(latestWfhPo.reference), method: 'latest-po-freight-unit' };
        }
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
        comboMap: { 'LLUK-CBCF-S-': 'DDUK-2190CF', 'LLUK-CBCF-SD-': 'DDUK-21120CF', 'LLUK-CBCF-D-': 'DDUK-21135CF' }
      }
    };
    mattressRegions = Object.fromEntries(Object.entries(mattressRegionConfigs).map(([region, cfg]) => {
      const regionCin7 = {};
      const regionShopify = {};
      const regionOpenOrders = {};
      const regionAvailable = {};
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
          acc.openSales += Number(row.openSales || 0);
          acc.matched += 1;
          return acc;
        }, { soh: 0, available: 0, openSales: 0, matched: 0 });
        regionCin7[sku] = branchData.matched > 0 ? branchData.soh : 0;
        regionAvailable[sku] = branchData.matched > 0 ? branchData.available : 0;
        regionOpenOrders[sku] = branchData.matched > 0 ? branchData.openSales : 0;
        regionShopify[sku] = 0;
      }

      // Little Lifely mattresses are not sold as standalone Shopify SKUs.
      // Each Little Lifely bed + mattress combo consumes one matching mattress.
      // Open demand now comes from Cin7 open sales; velocity still comes from Shopify sales history.
      const demandSource = getCin7PreordersBySku(cfg.branchIds, cfg.salesCountry);
      for (const [rawComboSku, qty] of Object.entries(demandSource)) {
        const comboSku = canonicalDemandSku(rawComboSku, cfg.salesCountry);
        const mattressSku = Object.entries(cfg.comboMap).find(([prefix]) => comboSku.startsWith(prefix))?.[1];
        if (!mattressSku) continue;
        regionShopify[mattressSku] = (regionShopify[mattressSku] || 0) - Number(qty || 0);
      }

      for (const sourceStore of relatedStores) {
        const velSource = dataCache.shopifyVelocityByCountry?.[sourceStore]?.[cfg.salesCountry] || {};

        for (const [rawComboSku, vel] of Object.entries(velSource)) {
          if (rawComboSku.startsWith('_')) continue;
          const comboSku = canonicalDemandSku(rawComboSku, cfg.salesCountry);
          const mattressSku = Object.entries(cfg.comboMap).find(([prefix]) => comboSku.startsWith(prefix))?.[1];
          if (!mattressSku) continue;
          regionVelocity[mattressSku] = (regionVelocity[mattressSku] || 0) + Number(vel || 0);
          regionVelocity._7d[mattressSku] = (regionVelocity._7d[mattressSku] || 0) + Number(velSource._7d?.[rawComboSku] || velSource._7d?.[comboSku] || 0);
          regionVelocity._30d[mattressSku] = (regionVelocity._30d[mattressSku] || 0) + Number(velSource._30d?.[rawComboSku] || velSource._30d?.[comboSku] || 0);
          const firstSeen = velSource._firstSeen?.[rawComboSku] || velSource._firstSeen?.[comboSku] || null;
          if (firstSeen && (!regionVelocity._firstSeen[mattressSku] || String(firstSeen) < String(regionVelocity._firstSeen[mattressSku]))) {
            regionVelocity._firstSeen[mattressSku] = firstSeen;
          }
          for (const [week, qty] of Object.entries(velSource._weeklyBreakdown?.[rawComboSku] || velSource._weeklyBreakdown?.[comboSku] || {})) {
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
      return [region, { cin7: regionCin7, shopify: regionShopify, openOrders: regionOpenOrders, available: regionAvailable, velocity: regionVelocity, trendData: regionTrendData, weeklyData: regionWeeklyData, pos: regionPos, allPos: regionAllPos }];
    }));

    // The default "All" mattress view should use Cin7 open sales by SKU
    // across all mattress branches once. Do not add regional aggregates on top
    // or the All view double-counts. Keep branch/source anomalies visible here
    // until the source data is corrected; e.g. DD-21107CF currently includes
    // 3 UK open sales even though they should be fixed at source.
    for (const sku of Object.keys(shopify)) shopify[sku] = 0;
    const mattressAllBranchIds = [...new Set(Object.values(mattressRegionConfigs).flatMap(cfg => cfg.branchIds || []))];
    const allOpenOrders = getCin7OpenSalesBySku(mattressAllBranchIds, '');
    const allAvailable = getCin7StockMetricBySku(mattressAllBranchIds, '', 'available');
    for (const sku of Object.keys(openOrders)) openOrders[sku] = 0;
    for (const sku of Object.keys(cin7Available)) cin7Available[sku] = 0;
    for (const sku of Object.keys(cin7)) {
      openOrders[sku] = Number(allOpenOrders[sku] || 0);
      cin7Available[sku] = Number(allAvailable[sku] || 0);
    }
  }

  return sanitizePlannerSkuData({
    ck: def,
    cin7,
    shopify,
    openOrders,
    available: cin7Available,
    incoming,
    velocity,
    pos,
    allPos,
    names,
    sizes,
    costs,
    cbmMap,
    suppliers,
    landedCosts,
    productTypes,
    coverageAux,
    warehouseOptions,
    warehouseViews,
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
        const absorbTrend = (velSource, country = '') => {
          const addTrendForKey = (sourceSku, multiplier = 1) => {
            d7Qty += Number(velSource._7d?.[sourceSku] || 0) * multiplier;
            d30Qty += Number(velSource._30d?.[sourceSku] || 0) * multiplier;
            const fs = velSource._firstSeen?.[sourceSku] || null;
            if (fs && (!firstSeenValue || String(fs) < String(firstSeenValue))) firstSeenValue = fs;
            for (const [week, qty] of Object.entries(velSource._weeklyBreakdown?.[sourceSku] || {})) {
              wk[week] = (wk[week] || 0) + Number(qty || 0) * multiplier;
            }
          };
          addTrendForKey(sku, 1);
          for (const rawSku of Object.keys(velSource || {})) {
            if (String(rawSku || '').startsWith('_')) continue;
            const demandSku = canonicalDemandSku(rawSku, country);
            const exploded = explodeDemandSkuForCk(demandSku, ckId);
            if (!exploded) continue;
            const multiplier = exploded.filter(componentSku => componentSku === sku).length;
            if (multiplier) addTrendForKey(rawSku, multiplier);
          }
        };
        for (const sourceStore of relatedStores) {
          const velSource = salesCountry
            ? dataCache.shopifyVelocityByCountry?.[sourceStore]?.[salesCountry] || {}
            : dataCache.shopifyVelocity?.[sourceStore] || {};
          absorbTrend(velSource, salesCountry || '');
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
      const addWeekly = (weekly = {}, country = '') => {
        const add = (targetSku, week, qty) => {
          if (!allSkus.includes(targetSku)) return;
          if (!result[targetSku]) result[targetSku] = {};
          result[targetSku][week] = (result[targetSku][week] || 0) + Number(qty || 0);
        };
        for (const [sourceSku, weeks] of Object.entries(weekly || {})) {
          const demandSku = canonicalDemandSku(sourceSku, country);
          const exploded = explodeDemandSkuForCk(demandSku, ckId);
          for (const [week, qty] of Object.entries(weeks || {})) {
            if (exploded) {
              for (const componentSku of exploded) add(componentSku, week, qty);
            } else {
              add(demandSku, week, qty);
            }
          }
        }
      };
      for (const sourceStore of relatedStores) {
        const weekly = salesCountry
          ? dataCache.shopifyVelocityByCountry?.[sourceStore]?.[salesCountry]?._weeklyBreakdown
          : dataCache.shopifyVelocity?.[sourceStore]?._weeklyBreakdown;
        addWeekly(weekly || {}, salesCountry || '');
      }
      return Object.keys(result).length > 0 ? result : null;
    })(),
    lastRefresh: dataCache.lastRefresh,
    lastCin7Refresh: dataCache.lastCin7Refresh,
    lastPoRefresh: dataCache.lastPoRefresh,
    lastShopifyRefresh: dataCache.lastShopifyRefresh
  });
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

function setNoStoreHtmlHeaders(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function sendNoStoreHtml(res, filename) {
  setNoStoreHtmlHeaders(res);
  return res.sendFile(path.join(__dirname, 'public', filename));
}

// Public assets
app.use('/logos', express.static(path.join(__dirname, 'public', 'logos')));

// CK list
function getBrandGroup(id, def) {
  if (id.startsWith('cusb') || id === 'cmss') return { id: 'cushie', name: 'Cushie', logo: 'cushie.png' };
  if (id.startsWith('ll')) return { id: 'little-lifely', name: 'Little Lifely', logo: 'little-lifely.png' };
  if (id === 'case-goods') return { id: 'case-goods', name: 'Case Goods', logo: def.logo };
  if (id === 'lifely-sofa' || id === 'dd' || id === 'cocoon' || id === 'rdnt' || id === 'wfhcr' || id === 'airflow-pad' || id === 'caterpillar') return { id: 'lifely-home', name: 'Lifely', logo: def.logo };
  return { id: 'other', name: 'Other', logo: def.logo };
}

function getBrandSubgroup(id, def) {
  if (id === 'cusb-au' || id === 'cmss') return { id: 'cushie-au', name: 'Cushie AU' };
  if (id === 'cusb-us') return { id: 'cushie-us', name: 'Cushie US' };
  if (id === 'cusb-ca') return { id: 'cushie-ca', name: 'Cushie CA' };
  if (id === 'cusb-uk') return { id: 'cushie-uk', name: 'Cushie UK' };
  return null;
}

const HIDDEN_CK_TABS = new Set(['llau-cbcf', 'cmss']);

let executiveSummaryCache = { key: null, value: null };

function executiveVelocity(data, sku) {
  const direct = Number(data?.velocity?.[sku] || 0);
  if (direct > 0) return direct;
  return Number(data?.trendData?.[sku]?.lastInStockVel || 0);
}

function executivePanelSummary(id) {
  const def = CK_DEFS[id];
  const data = buildCKData(id);
  if (!def || !data) return null;

  const mattressSkus = new Set(data.coverageAux?.mattressSkus || []);
  const skus = [...new Set([
    ...Object.keys(data.cin7 || {}),
    ...Object.keys(data.velocity || {}).filter(sku => !String(sku).startsWith('_'))
  ])].filter(sku => {
    if (!sku || String(sku).startsWith('_')) return false;
    // These country views intentionally hide mattress components; the dedicated
    // mattress view owns that portfolio position.
    if (['llau', 'llnz', 'lluk'].includes(id) && mattressSkus.has(sku)) return false;
    return true;
  });

  const rows = skus.map(sku => {
    const soh = Number(data.cin7?.[sku] || 0);
    const openDemand = Object.prototype.hasOwnProperty.call(data.openOrders || {}, sku)
      ? Number(data.openOrders[sku] || 0)
      : Math.max(-Number(data.shopify?.[sku] || 0), 0);
    const available = Object.prototype.hasOwnProperty.call(data.available || {}, sku)
      ? Number(data.available[sku] || 0)
      : soh - openDemand;
    const incoming = Number(data.incoming?.[sku] || 0);
    const velocity = executiveVelocity(data, sku);
    const trend = data.trendData?.[sku] || {};
    const v7 = Number(trend.v7 || 0);
    const v30 = Number(trend.v30 || 0);
    // v30 includes the latest week, so back it out to compare the last 7 days
    // against the preceding 23-day weekly pace rather than against itself.
    const prior23Weekly = Math.max(0, ((v30 * 30 / 7) - v7) / 23 * 7);
    const weeklyLift = v7 - prior23Weekly;
    const increasePct = prior23Weekly >= 0.5 ? Math.round((weeklyLift / prior23Weekly) * 100) : null;
    const weeks = velocity > 0 ? Math.max(available, 0) / velocity : null;
    const weeksAtCurrentPace = v7 > 0 ? Math.max(available, 0) / v7 : null;
    const daysToStockout = weeksAtCurrentPace === null ? null : available <= 0 ? 0 : Math.ceil(weeksAtCurrentPace * 7);
    const hasDemandSignal = velocity > 0 || openDemand > 0;
    const stockout = available <= 0 && hasDemandSignal;
    const demandBackedStockout = stockout && openDemand > 0;
    const critical = !stockout && weeks !== null && weeks <= 2;
    const low = !stockout && !critical && weeks !== null && weeks <= 4;
    const newSku = trend.firstSeen
      ? (Date.now() - Date.parse(trend.firstSeen)) / 864e5 < 30
      : false;
    const reactivated = prior23Weekly < 0.5 && v7 >= 3;
    const velocitySurge = !newSku && v7 >= 3 && weeklyLift >= 2 && (reactivated || increasePct >= 35);
    const cost = Number(data.costs?.[sku] || 0);
    const excessUnits = velocity > 0 ? Math.max(0, soh - velocity * 25) : 0;
    const deadUnits = !newSku && velocity <= 0 && openDemand <= 0 ? Math.max(soh, 0) : 0;
    const severity = demandBackedStockout ? 4 : critical ? 3 : (stockout || low) ? 2 : (deadUnits > 0 || excessUnits > 0) ? 1 : 0;
    return {
      sku,
      soh,
      available,
      openDemand,
      incoming,
      velocity,
      v7: Math.round(v7 * 10) / 10,
      prior23Weekly: Math.round(prior23Weekly * 10) / 10,
      weeklyLift: Math.round(weeklyLift * 10) / 10,
      increasePct,
      reactivated,
      velocitySurge,
      daysToStockout,
      weeksAtCurrentPace: weeksAtCurrentPace === null ? null : Math.round(weeksAtCurrentPace * 10) / 10,
      weeks: weeks === null ? null : Math.round(weeks * 10) / 10,
      stockout,
      demandBackedStockout,
      critical,
      low,
      severity,
      uncoveredDemand: Math.max(openDemand - Math.max(soh, 0) - incoming, 0),
      excessValue: excessUnits * cost,
      deadValue: deadUnits * cost
    };
  });

  const stockouts = rows.filter(row => row.demandBackedStockout);
  const zeroCover = rows.filter(row => row.stockout);
  const critical = rows.filter(row => row.critical);
  const low = rows.filter(row => row.low);
  const totalVelocity = rows.reduce((sum, row) => sum + row.velocity, 0);
  const totalAvailable = rows.reduce((sum, row) => sum + row.available, 0);
  const openDemand = rows.reduce((sum, row) => sum + row.openDemand, 0);
  const incoming = rows.reduce((sum, row) => sum + row.incoming, 0);
  const uncoveredDemand = rows.reduce((sum, row) => sum + row.uncoveredDemand, 0);
  const overstockValue = rows.reduce((sum, row) => sum + row.excessValue, 0);
  const deadstockValue = rows.reduce((sum, row) => sum + row.deadValue, 0);
  const status = stockouts.length || uncoveredDemand > 0
    ? 'critical'
    : zeroCover.length || critical.length || low.length || overstockValue > 0 || deadstockValue > 0
      ? 'watch'
      : 'healthy';
  const brand = getBrandGroup(id, def);

  return {
    id,
    name: def.name,
    brand: brand.name,
    status,
    skuPositions: rows.length,
    stockouts: stockouts.length,
    zeroCover: zeroCover.length,
    critical: critical.length,
    low: low.length,
    actionPositions: stockouts.length + critical.length,
    openDemand: Math.round(openDemand),
    incoming: Math.round(incoming),
    uncoveredDemand: Math.round(uncoveredDemand),
    weightedWeeks: totalVelocity > 0 ? Math.round((Math.max(totalAvailable, 0) / totalVelocity) * 10) / 10 : null,
    overstockValue: Math.round(overstockValue),
    deadstockValue: Math.round(deadstockValue),
    velocitySurges: rows.filter(row => row.velocitySurge).sort((a, b) => {
      const aRisk = a.daysToStockout !== null && a.daysToStockout <= 28 ? 1 : 0;
      const bRisk = b.daysToStockout !== null && b.daysToStockout <= 28 ? 1 : 0;
      return bRisk - aRisk
        || (a.daysToStockout ?? 9999) - (b.daysToStockout ?? 9999)
        || b.weeklyLift - a.weeklyLift
        || a.sku.localeCompare(b.sku);
    }).map(row => ({
      sku: row.sku,
      currentWeekly: row.v7,
      priorWeekly: row.prior23Weekly,
      weeklyLift: row.weeklyLift,
      increasePct: row.increasePct,
      reactivated: row.reactivated,
      available: Math.round(row.available),
      incoming: Math.round(row.incoming),
      weeksAtCurrentPace: row.weeksAtCurrentPace,
      daysToStockout: row.daysToStockout,
      stockoutRisk: row.daysToStockout !== null && row.daysToStockout <= 28,
      riskLevel: row.daysToStockout === 0 ? 'out' : row.daysToStockout !== null && row.daysToStockout <= 14 ? 'urgent' : row.daysToStockout !== null && row.daysToStockout <= 28 ? 'watch' : 'stable'
    })),
    topRisks: rows.filter(row => row.severity > 0).sort((a, b) =>
      b.severity - a.severity
      || b.uncoveredDemand - a.uncoveredDemand
      || b.openDemand - a.openDemand
      || a.sku.localeCompare(b.sku)
    ).slice(0, 4).map(row => ({
      sku: row.sku,
      status: row.demandBackedStockout ? 'Stockout' : row.critical ? 'Critical' : row.stockout ? 'Zero cover' : row.low ? 'Low cover' : row.deadValue > 0 ? 'Dead stock' : 'Overstock',
      available: Math.round(row.available),
      openDemand: Math.round(row.openDemand),
      incoming: Math.round(row.incoming),
      weeks: row.weeks,
      severity: row.severity
    }))
  };
}

function buildExecutiveSummary() {
  const cacheKey = [dataCache.lastRefresh, dataCache.lastCin7Refresh, dataCache.lastPoRefresh, dataCache.lastShopifyRefresh, fxRate.USDAUD].join('|');
  if (executiveSummaryCache.key === cacheKey && executiveSummaryCache.value) return executiveSummaryCache.value;

  const panels = Object.keys(CK_DEFS)
    .filter(id => !HIDDEN_CK_TABS.has(id))
    .map(executivePanelSummary)
    .filter(Boolean)
    .sort((a, b) => {
      const rank = { critical: 0, watch: 1, healthy: 2 };
      return rank[a.status] - rank[b.status]
        || b.uncoveredDemand - a.uncoveredDemand
        || b.stockouts - a.stockouts
        || b.actionPositions - a.actionPositions
        || a.name.localeCompare(b.name);
    });

  const allVelocitySurges = panels.flatMap(panel => (panel.velocitySurges || []).map(row => ({
    ...row,
    ckId: panel.id,
    ckName: panel.name,
    brand: panel.brand
  }))).sort((a, b) => {
    const riskRank = { out: 0, urgent: 1, watch: 2, stable: 3 };
    return riskRank[a.riskLevel] - riskRank[b.riskLevel]
      || (a.daysToStockout ?? 9999) - (b.daysToStockout ?? 9999)
      || b.weeklyLift - a.weeklyLift
      || a.sku.localeCompare(b.sku);
  });

  const uniquePos = [...new Map((dataCache.cin7POs || []).map(rawPo => {
    const po = visiblePlannerPo(rawPo);
    return [String(po.id || po.orderId || po.purchaseOrderId || po.reference || crypto.randomUUID()), po];
  })).values()].filter(po => Object.keys(po.items || {}).length > 0);
  const openPos = uniquePos.filter(isOpenPO);
  const now = new Date();
  const poRows = openPos.map(po => {
    const destination = inferDestination(po);
    const landed = estimateLandedCost(po, destination);
    const eta = poTabEtaDate(po) || poTabOriginalEtaDate(po);
    const overdue = isPoOverdueForPoTab(po, now);
    const inTransit = isPoInTransitForPoTab(po, now) && !overdue;
    const daysOverdue = overdue && eta ? Math.max(0, Math.floor((now - eta) / 864e5)) : 0;
    return {
      reference: po.reference || 'Unreferenced PO',
      supplier: po.company || 'Supplier not recorded',
      destination,
      eta: eta ? eta.toISOString() : null,
      units: Math.round(Object.values(po.items || {}).reduce((sum, qty) => sum + Number(qty || 0), 0)),
      landedValueAud: Math.round(Number(landed.landedTotal || 0)),
      overdue,
      inTransit,
      daysOverdue
    };
  });
  const overduePos = poRows.filter(po => po.overdue);
  const transitPos = poRows.filter(po => po.inTransit);
  const productionPos = poRows.filter(po => !po.overdue && !po.inTransit);
  const poValue = rows => rows.reduce((sum, po) => sum + po.landedValueAud, 0);
  const futureCutoff = new Date(now.getTime() + 30 * 864e5);
  const upcomingAll = poRows.filter(po => !po.overdue && po.eta && new Date(po.eta) <= futureCutoff)
    .sort((a, b) => new Date(a.eta) - new Date(b.eta));
  const upcoming = upcomingAll.slice(0, 6);

  const actions = overduePos
    .sort((a, b) => b.daysOverdue - a.daysOverdue || b.landedValueAud - a.landedValueAud)
    .slice(0, 3)
    .map(po => ({
      type: 'po',
      severity: 'critical',
      title: `${po.reference} is ${po.daysOverdue} day${po.daysOverdue === 1 ? '' : 's'} overdue`,
      detail: `${po.supplier} · ${po.destination} · A$${Math.round(po.landedValueAud).toLocaleString('en-AU')}`,
      filter: 'overdue'
    }));

  for (const panel of panels) {
    if (actions.length >= 7) break;
    if (panel.status === 'healthy') continue;
    const parts = [];
    if (panel.stockouts) parts.push(`${panel.stockouts} stockout${panel.stockouts === 1 ? '' : 's'}`);
    if (panel.critical) parts.push(`${panel.critical} under 2 weeks`);
    if (panel.uncoveredDemand) parts.push(`${panel.uncoveredDemand.toLocaleString('en-AU')} ${panel.uncoveredDemand === 1 ? 'unit' : 'units'} not covered by stock + incoming`);
    if (!parts.length && panel.low) parts.push(`${panel.low} positions under 4 weeks`);
    if (!parts.length && panel.deadstockValue) parts.push(`A$${panel.deadstockValue.toLocaleString('en-AU')} dead stock at FOB`);
    if (!parts.length && panel.overstockValue) parts.push(`A$${panel.overstockValue.toLocaleString('en-AU')} above 25 weeks at FOB`);
    actions.push({
      type: 'ck',
      severity: panel.status,
      title: `${panel.name} needs review`,
      detail: parts.join(' · '),
      ckId: panel.id
    });
  }

  const topRisks = panels.flatMap(panel => panel.topRisks.map(row => ({ ...row, ckId: panel.id, ckName: panel.name })))
    .sort((a, b) => b.severity - a.severity || b.openDemand - a.openDemand || a.sku.localeCompare(b.sku))
    .slice(0, 8);

  const summary = {
    headline: {
      totalPanels: panels.length,
      actionPanels: panels.filter(panel => panel.status === 'critical').length,
      watchPanels: panels.filter(panel => panel.status === 'watch').length,
      healthyPanels: panels.filter(panel => panel.status === 'healthy').length,
      stockoutPositions: panels.reduce((sum, panel) => sum + panel.stockouts, 0),
      actionPositions: panels.reduce((sum, panel) => sum + panel.actionPositions, 0),
      atRiskOpenDemand: panels.reduce((sum, panel) => sum + panel.uncoveredDemand, 0)
    },
    po: {
      active: poRows.length,
      production: productionPos.length,
      inTransit: transitPos.length,
      overdue: overduePos.length,
      noEta: poRows.filter(po => !po.eta).length,
      incomingUnits: poRows.reduce((sum, po) => sum + po.units, 0),
      pipelineValueAud: Math.round(poValue(poRows)),
      productionValueAud: Math.round(poValue(productionPos)),
      transitValueAud: Math.round(poValue(transitPos)),
      overdueValueAud: Math.round(poValue(overduePos)),
      arrivingWithin30Days: upcomingAll.length
    },
    actions,
    panels,
    velocity: {
      surgeCount: allVelocitySurges.length,
      stockoutRiskCount: allVelocitySurges.filter(row => row.stockoutRisk).length,
      outNowCount: allVelocitySurges.filter(row => row.riskLevel === 'out').length,
      urgentCount: allVelocitySurges.filter(row => row.riskLevel === 'urgent').length
    },
    velocitySurges: allVelocitySurges.slice(0, 40),
    topRisks,
    upcoming,
    lastRefresh: dataCache.lastRefresh,
    lastCin7Refresh: dataCache.lastCin7Refresh,
    lastPoRefresh: dataCache.lastPoRefresh,
    lastShopifyRefresh: dataCache.lastShopifyRefresh
  };
  executiveSummaryCache = { key: cacheKey, value: summary };
  return summary;
}

app.get('/api/executive-summary', requireAuth, (req, res) => {
  reloadSnapshotIfNewer();
  res.json(buildExecutiveSummary());
});

app.get('/api/ck-list', requireAuth, (req, res) => {
  reloadSnapshotIfNewer();
  const littleLifelyListOrder = { llau: 0, llna: 1, llca: 2, lluk: 3, llnz: 4, llsg: 5, 'll-mattresses': 6 };
  const list = Object.entries(CK_DEFS).filter(([id]) => !HIDDEN_CK_TABS.has(id)).map(([id, def]) => {
    const data = buildCKData(id);
    const skuCount = data ? new Set([...Object.keys(data.cin7 || {}), ...Object.keys(data.velocity || {}).filter(k => !String(k).startsWith('_'))]).size : 0;
    const brand = getBrandGroup(id, def);
    const subgroup = getBrandSubgroup(id, def);
    return { id, name: def.name, logo: def.logo, mark: def.mark || null, skuCount, brand, subgroup };
  }).sort((a, b) => {
    if (a.brand?.id === 'little-lifely' || b.brand?.id === 'little-lifely') return (littleLifelyListOrder[a.id] ?? 999) - (littleLifelyListOrder[b.id] ?? 999);
    return 0;
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

// Estimated freight + tariff/charges by destination (from yk's shipping data)
const FREIGHT_TARIFF = {
  'United States':  { freight: 8404, freightCurrency: 'AUD', defaultTariff: 0.19, tariffNote: '19% US tariff' },
  'Canada':         { freight: 8404, freightCurrency: 'AUD', defaultTariff: 0.08, tariffNote: '~8% MFN (⚠️ 188% if upholstered seating)' },
  'United Kingdom': { freight: 7245, freightCurrency: 'AUD', defaultTariff: 0,    tariffNote: '' },
  'Australia':      { freight: 7000, freightCurrency: 'AUD', defaultTariff: 0,    tariffNote: '' },
  'Singapore':      { freight: 2898, freightCurrency: 'AUD', defaultTariff: 0,    tariffNote: '0% (free trade)' },
  'New Zealand':    { freight: 2898, freightCurrency: 'AUD', defaultTariff: 0,    tariffNote: '' },
};
const DESTINATION_BRAND_TARIFF_RULES = {
  'United States': {
    cushie: { label: 'Cushie', tariff: 0, additional: 0.10, note: '0% tariff + 10% additional charges' },
    littleLifely: { label: 'Little Lifely', tariff: 0, additional: 0.10, note: '0% tariff + 10% additional charges' }
  },
  'Canada': {
    cushie: { label: 'Cushie', tariff: 0.095, additional: 0, note: '9.5% tariff' },
    littleLifely: { label: 'Little Lifely', tariff: 0, additional: 0, note: '0% tariff' }
  },
  'United Kingdom': {
    cushie: { label: 'Cushie', tariff: 0.02, additional: 0, note: '2% tariff' },
    littleLifely: { label: 'Little Lifely', tariff: 0.02, additional: 0, note: '2% tariff' }
  }
};

function poTariffBrandForSku(sku, option1 = '') {
  const s = String(sku || '').toUpperCase().trim();
  const o = String(option1 || '').toLowerCase();
  if (o.includes('cushie') || s.startsWith('V2-') || s.startsWith('V3-') || s.startsWith('CUSB') || s.startsWith('LFSB') || s.startsWith('CMSS')) return 'cushie';
  if (o.includes('little lifely') || s.startsWith('LLAU') || s.startsWith('LLNA') || s.startsWith('LLUK') || s.startsWith('LLSG') || s.startsWith('LLNZ') || s.startsWith('LLCA')) return 'littleLifely';
  return 'other';
}
function formatPercent(rate) {
  const pct = Math.round(Number(rate || 0) * 1000) / 10;
  return `${Math.abs(pct - Math.round(pct)) < 0.05 ? Math.round(pct).toFixed(0) : pct.toFixed(1)}%`;
}
function resolvePoTariff(po, destination) {
  const destRules = DESTINATION_BRAND_TARIFF_RULES[destination] || {};
  const items = Object.entries(po.items || {});
  let totalQty = 0;
  let weightedRate = 0;
  const groups = {};
  for (const [sku, rawQty] of items) {
    const qty = Math.max(0, Number(rawQty || 0)) || 1;
    const brand = poTariffBrandForSku(sku, po.itemOption1?.[sku] || dataCache.cin7Products?.[sku]?.option1 || '');
    const rule = destRules[brand];
    const rate = rule ? Number(rule.tariff || 0) + Number(rule.additional || 0) : Number(FREIGHT_TARIFF[destination]?.defaultTariff || 0);
    totalQty += qty;
    weightedRate += qty * rate;
    if (!groups[brand]) groups[brand] = { qty: 0, rate, rule };
    groups[brand].qty += qty;
  }
  const fallback = FREIGHT_TARIFF[destination] || {};
  const tariffRate = totalQty > 0 ? weightedRate / totalQty : Number(fallback.defaultTariff || 0);
  const groupNotes = Object.entries(groups).map(([brand, g]) => {
    if (g.rule) return `${g.rule.label}: ${g.rule.note} (${Number(g.qty).toLocaleString()} units)`;
    return `Other/unconfigured: ${fallback.tariffNote || formatPercent(g.rate)} (${Number(g.qty).toLocaleString()} units)`;
  });
  const configuredNotes = Object.values(destRules).map(r => `${r.label}: ${r.note}`);
  const tariffNote = groupNotes.length
    ? `Displayed as one aggregated rate: ${formatPercent(tariffRate)}. Aggregation is quantity-weighted by PO line units and includes additional charges where configured. PO mix: ${groupNotes.join('; ')}.`
    : (configuredNotes.length ? `Configured ${destination} rates: ${configuredNotes.join('; ')}.` : (fallback.tariffNote || `${formatPercent(tariffRate)} tariff/charges`));
  return { tariffRate, tariffNote };
}

function moneyToAud(value, currency) {
  const n = Number(value || 0);
  const c = String(currency || 'AUD').toUpperCase();
  if (!n) return 0;
  if (c === 'AUD') return n;
  if (c === 'USD') return n * (fxRate.USDAUD || 1.45);
  return n;
}

function estimateLandedCost(po, destination) {
  const freightActual = po.freightTotal > 0 ? po.freightTotal : 0;
  const productValue = po.total || 0;
  const productCurrency = po.currencyCode || 'USD';
  const productValueAUD = moneyToAud(productValue, productCurrency);
  const dest = FREIGHT_TARIFF[destination];
  const isEstimated = freightActual === 0;
  const freight = freightActual > 0 ? moneyToAud(freightActual, productCurrency) : (dest ? dest.freight : 0);
  const freightCurrency = 'AUD';
  const { tariffRate, tariffNote } = resolvePoTariff(po, destination);
  const tariffAmount = productValueAUD * tariffRate;
  return { productValueAUD, freight, freightCurrency, tariffRate, tariffAmount, tariffNote, isEstimated, landedTotal: productValueAUD + freight + tariffAmount };
}

function poHasApiVisibleLandedCostSignal(po) {
  // Cin7 Omni has two real landed-cost entry paths:
  // 1) additional costs entered in the PO's Landed Costs section, and
  // 2) linked import-cost POs for freight/customs.
  // The public PurchaseOrders API does not expose either section/link directly.
  // The only similar header fields exposed by the API are supplier-paid Freight/Surcharge
  // and ModifiedCOGSDate, so keep these as diagnostic signals only — not a PO score gate.
  return Number(po.freightTotal || 0) > 0
    || Number(po.surcharge || 0) > 0
    || !!po.modifiedCOGSDate;
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

  // Do not score Landed Costs here. Cin7's real Landed Costs / linked import-cost
  // entries are not exposed by the public PurchaseOrders API, and freightTotal is
  // only the supplier-paid Freight header. Using it capped received POs at 90%.

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
  const pos = sourcePos.map(rawPo => {
    const po = visiblePlannerPo(rawPo);
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
      freightDescription: po.freightDescription || '',
      surcharge: po.surcharge || 0,
      surchargeDescription: po.surchargeDescription || '',
      modifiedCOGSDate: po.modifiedCOGSDate || null,
      landedCostApiSignal: poHasApiVisibleLandedCostSignal(po),
      accountingAttributes: po.accountingAttributes || {},
      quality,
      etaHistory: getPoEtaHistoryRecord(po),
      itemNames: po.itemNames || {},
      itemCategories: cin7Option1CategoriesForPoItems(po.items || {}),
      items: po.items || {}
    };
  }).filter(po => Object.keys(po.items || {}).length > 0);
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
  // Manual dashboard refresh is intentionally a force-live refresh: fetch Cin7
  // Products/Stock/PurchaseOrders plus Shopify, then write the cache snapshot.
  // Keep the cooldown above so the button cannot spam Cin7's daily quota.
  const refreshResult = await refreshAllData(true, 'manual-live-cin7-refresh');
  res.json({
    ok: refreshResult?.ok !== false && refreshResult?.cacheSaveResult?.ok !== false,
    forcedCin7: true,
    cacheSaved: !!refreshResult?.cacheSaveResult?.wrote,
    cachePushed: !!refreshResult?.cacheSaveResult?.pushed,
    cachePushSkipped: refreshResult?.cacheSaveResult?.skipped || null,
    cacheError: refreshResult?.cacheSaveResult?.error || null,
    lastRefresh: dataCache.lastRefresh,
    lastCin7Refresh: dataCache.lastCin7Refresh,
    lastPoRefresh: dataCache.lastPoRefresh,
    lastShopifyRefresh: dataCache.lastShopifyRefresh
  });
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

  for (const rawPo of dataCache.cin7POs) {
    // Include active POs (we already filter out Received in fetchCin7POs)
    const po = visiblePlannerPo(rawPo);
    if (Object.keys(po.items || {}).length === 0) continue;
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
  'Category Killer - Cocoon Bed',
  'Category Killer - Radiant',
  'Category Killer - WFH Chair',
  'Category Killer - Caterpillar',
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
  { sku: 'DD-21153CF', expected: 'Deep Dream' },
  { sku: 'DD-34183K-SFM', expected: 'Deep Dream' },
  { sku: 'DDUK-2190CF', expected: 'LL Mattresses' },
  { sku: 'CAT-EDT-NAL', expected: 'Caterpillar Dining' }
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
    option1Counts[normalizeOption1(option1)] = (option1Counts[normalizeOption1(option1)] || 0) + 1;
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

  const staleDemandSkuAliases = [];
  for (const [store, countries] of Object.entries(dataCache.shopifyOpenDemand || {})) {
    for (const [country, rows] of Object.entries(countries || {})) {
      for (const [sku, qty] of Object.entries(rows || {})) {
        const canonicalSku = canonicalDemandSku(sku, country);
        if (canonicalSku !== String(sku || '').toUpperCase().trim() && Number(qty || 0) > 0) {
          staleDemandSkuAliases.push({ store, country, sku, canonicalSku, qty: Number(qty || 0) });
        }
      }
    }
  }

  const checks = {
    cin7Products: Object.keys(products).length,
    cin7StockByBranchSkus: Object.keys(stockByBranch).length,
    purchaseOrders: pos.length,
    purchaseOrdersWithoutLineItems: pos.filter(po => Object.keys(po.items || {}).length === 0).length,
    productsWithOption1,
    productsMissingOption1: Object.keys(products).length - productsWithOption1,
    missingRequiredOption1: HEALTH_REQUIRED_OPTION1.filter(option1 => !option1Counts[normalizeOption1(option1)]),
    fixtureRoutes,
    ckPanelSkuCounts,
    staleDemandSkuAliases,
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
app.get('/', (req, res) => sendNoStoreHtml(res, 'index.html'));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (String(filePath).endsWith('.html')) setNoStoreHtmlHeaders(res);
  }
}));

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
  if (isPlannerExcludedSku(c)) return null;
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
      stage: poTabStageLabel(po),
      rawStage: po.stage || '',
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
  sendNoStoreHtml(res, 'incoming-pos.html');
});
