#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(ROOT, 'data', 'cache-snapshot.json');
const SERVER_PATH = path.join(ROOT, 'server.js');
const FRONTEND_PATH = path.join(ROOT, 'public', 'index.html');
const TRACKER_FRONTEND_PATH = path.join(ROOT, 'public', 'tracker.html');
const CONTAINER_TRACKING_PATH = path.join(ROOT, 'lib', 'container-tracking.js');
const BOM_MASTER_DEMAND_PATH = path.join(ROOT, 'lib', 'bom-master-demand.js');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const REFRESH_SCRIPT_PATH = path.join(ROOT, 'scripts', 'refresh_live_cin7_cache.py');
const WARN_STALE_HOURS = 6;
const TRACKING_SCHEMA_VERSION = '2026-07-24-fail-closed-v2';
const MIN_PRODUCTS = 1000;
const MIN_POS = 50;
const EXPECTED_STORES = ['lifely', 'cushie', 'littlelifely'];
const PERSONALISED_COVER_BRANCH_ID = 74276;
const REQUIRED_OPTION1 = [
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
const {
  normalizeContainerNumber,
  resolveTrackingDestination,
  warehouseSourceForDestination,
  selectLecangsRecords,
  normalizeFindTeu,
  validateFindTeuDestination,
  normalizeWarehousePayload
} = require('../lib/container-tracking');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { throw new Error(`${path.relative(ROOT, file)} is not valid JSON: ${err.message}`); }
}
function norm(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function ageHours(value) {
  const ts = Date.parse(value || '');
  if (!Number.isFinite(ts)) return null;
  return Math.round(((Date.now() - ts) / 36e5) * 10) / 10;
}
function hasPayload(obj, store) {
  return !!obj?.[store] && Object.keys(obj[store] || {}).filter(k => !k.startsWith('__')).length > 0;
}
function isCaseGoodsSku(sku) {
  const s = String(sku || '').toUpperCase();
  const compact = s.replace(/[^A-Z0-9]/g, '');
  if (['LIFELYCARE', 'CAREINSURANCE', 'INSURANCE', 'GIFTCARD'].some(x => compact.includes(x))) return false;
  return true;
}
const CK_DEFS = {
  llau: { name:'Little Lifely AU', prefix:'LLAU-CB-', option1:'Category Killer - Little Lifely', filter:s=>!s.includes('CBCF') },
  llnz: { name:'Little Lifely NZ', prefix:'LLAU-CB-', option1:'Category Killer - Little Lifely', filter:s=>!s.includes('CBCF') },
  'll-personalised-cover': { name:'Personalised Cover', prefix:'MULTI', stockBranches:[PERSONALISED_COVER_BRANCH_ID], requireBranchMatch:true, filterPosByStockBranches:true, option1:'Category Killer - Little Lifely', filter:s=>/^(LLAU|LLNA|LLSG|LLUK)-CB-[A-Z0-9]+-[A-Z0-9]+-CV$/i.test(s) },
  'll-mattresses': { name:'LL Mattresses', prefix:'MULTI', option1:['Category Killer - 21cm Mattress','Category Killer - Deep Dream'], option1Bypass:s=>s.startsWith('DDUK'), filter:s=>['DD-21915CF','DD-21107CF','DD-21137CF'].includes(s)||s.startsWith('DDUK') },
  dd: { name:'Deep Dream', prefix:'MULTI', option1:'Category Killer - Deepdream' },
  cocoon: { name:'Cocoon Bed', prefix:'COCOON', option1:'Category Killer - Cocoon Bed' },
  rdnt: { name:'Radiant', prefix:'RDNT', option1:'Category Killer - Radiant' },
  wfhcr: { name:'WFH Chair', prefix:'WFHCR', option1:'Category Killer - WFH Chair' },
  caterpillar: { name:'Caterpillar Dining', prefix:'MULTI', option1:'Category Killer - Caterpillar' },
  'cusb-au-snuggle': { name:'Cushie Snuggle Bed', prefix:'MULTI', option1:'Category Killer - Cushie V3 Snuggle', filter:s=>s.startsWith('CUSB')&&!s.includes('-UK')&&!s.includes('SGE'), excludeCV:true },
  'cusb-au-lifely': { name:'Lifely Sofabed', prefix:'MULTI', option1:['Category Killer - Cushie V2','Category Killer - Lifely Sofa'], filter:s=>s.startsWith('LFSB')&&!s.includes('-UK'), excludeCV:true },
  'cusb-us': { name:'Cushie US', prefix:'MULTI', option1:['Category Killer - Cushie V2','Category Killer - Cushie V3 Snuggle'], filter:s=>s.startsWith('V2-')||s.startsWith('V3-'), excludeCV:true },
  'cusb-uk': { name:'Cushie UK', prefix:'MULTI', option1:['Category Killer - Cushie V2','Category Killer - Cushie V3 Snuggle'], filter:s=>(s.startsWith('CUSB')||s.startsWith('LFSB'))&&s.includes('-UK'), excludeCV:true },
  cmss: { name:'Cushie Modular Sleeper', prefix:'CMSS', option1:'Category Killer - Cushie V2' },
  'lifely-sofa': { name:'Modular Sofa', prefix:'LIFELY', option1:'Category Killer - Lifely Sofa' },
  'case-goods': { name:'Case Goods', prefix:'MULTI', option1:['Case goods - Active','Case goods - Discontinued'], filter:isCaseGoodsSku }
};
function optionAllowed(actual, allowed) {
  if (!allowed) return true;
  const list = Array.isArray(allowed) ? allowed : [allowed];
  return list.some(v => norm(v) === norm(actual));
}
function matchesDef(sku, option1, def) {
  const s = String(sku || '').toUpperCase();
  if (/CSTM$/i.test(s.trim())) return false;
  const filter = def.filter || (() => true);
  if (def.prefix === 'MULTI') { if (!filter(s)) return false; }
  else if (!(s.startsWith(def.prefix) && filter(s))) return false;
  if (def.excludeCV && s.includes('-CV')) return false;
  if (def.option1Bypass && def.option1Bypass(s)) return true;
  return optionAllowed(option1, def.option1);
}
function routeSku(sku, products) {
  const option1 = products[sku]?.option1 || products[String(sku).toUpperCase()]?.option1 || '';
  for (const def of Object.values(CK_DEFS)) if (matchesDef(sku, option1, def)) return def.name;
  return 'Uncategorised';
}

const blockers = [];
const warnings = [];
let cache;
try { cache = readJson(CACHE_PATH); } catch (err) { blockers.push(err.message); cache = {}; }
const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
const frontendSource = fs.readFileSync(FRONTEND_PATH, 'utf8');
const trackerFrontendSource = fs.readFileSync(TRACKER_FRONTEND_PATH, 'utf8');
const bomMasterDemandSource = fs.existsSync(BOM_MASTER_DEMAND_PATH)
  ? fs.readFileSync(BOM_MASTER_DEMAND_PATH, 'utf8')
  : '';
const packageSource = fs.readFileSync(PACKAGE_PATH, 'utf8');
if (frontendSource.includes('> No sales</span>')) {
  blockers.push('Dashboard must not show the misleading No sales trend label');
}
if (!bomMasterDemandSource.includes('function resolveBomMasterLeaves')
  || !bomMasterDemandSource.includes('function bomMasterComponentsForPanel')) {
  blockers.push('Universal BOM Master demand resolver is missing');
}
if (!serverSource.includes('bomMasterComponentsForPanel(ckId, s, dataCache.cin7BOMs)')) {
  blockers.push('Demand attribution must route known parent SKUs through BOM Master');
}
if (serverSource.includes('function pushLifelySofaModules')) {
  blockers.push('Lifely Sofa demand must not infer module composition from parent SKU tokens');
}
if (!packageSource.includes('scripts/test_all_tab_bom_reconciliation.js')) {
  blockers.push('Universal 20-tab BOM reconciliation must run before release');
}
if (!packageSource.includes('scripts/test_sellable_parent_deadstock.js')) {
  blockers.push('Sellable-parent dead-stock regression must run before release');
}
if (!packageSource.includes('scripts/test_warehouse_aggregation.js')) {
  blockers.push('Warehouse PO/incoming aggregation regression must run before release');
}
if (!serverSource.includes("Exact branch-specific fulfilled-sales velocity is unavailable.")) {
  blockers.push('Warehouse demand-dependent metrics must fail closed when exact branch velocity is unavailable');
}
if (!serverSource.includes("const viewPos = (pos || []).filter(po => branchIdSet.has(Number(po.branchId || 0)))")) {
  blockers.push('Warehouse views must use branch-filtered open PO rows');
}
if (serverSource.includes('addCin7DemandToVisibleMap(branchIncoming, viewIncoming')) {
  blockers.push('Incoming PO quantities must never pass through the sales-demand BOM mapping path');
}
if (!serverSource.includes('coveragePoRows: viewCoveragePoRows')) {
  blockers.push('Warehouse coverage rows must use branch-filtered PO evidence');
}
if (!frontendSource.includes('function hasReconciledWarehouseDemand()')
  || !frontendSource.includes('Branch demand unavailable')
  || !frontendSource.includes('DEMAND N/A')) {
  blockers.push('Warehouse demand-dependent cards and rows must display an explicit unavailable state');
}
if (!frontendSource.includes('useAdditiveWarehouseValues')
  || !frontendSource.includes('Sum of reconciled warehouses')) {
  blockers.push('All-warehouse overstock must sum reconciled warehouse calculations');
}
if (!frontendSource.includes('Net Component Deficit')
  || !frontendSource.includes('getNetComponentDeficit')) {
  blockers.push('Little Lifely warehouse deficit must use the BOM-expanded Net Component Deficit measure');
}
if (frontendSource.includes('else DATA.pos=DATA._base.pos||[]')) {
  blockers.push('Warehouse PO counts must never fall back to the All-warehouse PO list');
}
if (!serverSource.includes('const US_WEST_STATE_CODES = new Set')
  || !serverSource.includes('const US_NJ_STATE_CODES = new Set')
  || !serverSource.includes('shopifyVelocityByWarehouse')) {
  blockers.push('US branch demand must use aggregate Shopify delivery-state mapping');
}
const containerTrackingSource = fs.existsSync(CONTAINER_TRACKING_PATH)
  ? fs.readFileSync(CONTAINER_TRACKING_PATH, 'utf8')
  : '';
const refreshScriptSource = fs.readFileSync(REFRESH_SCRIPT_PATH, 'utf8');
if (!refreshScriptSource.includes('"shopifyVelocityByWarehouse"')) {
  blockers.push('Durable cache refresh must preserve aggregate Shopify warehouse velocity');
}
if (!serverSource.includes('git -c user.name="Lifely Demand Planner" -c user.email="lifely.abundance@gmail.com" commit')) {
  blockers.push('Render cache refresh commits must set a local Git author identity');
}
if (!serverSource.includes('CACHE_PUSH_SKIPPED_NO_REMOTE')
  || !serverSource.includes("skipped: 'git-remote-unavailable'")) {
  blockers.push('Render manual refresh must remain usable when the ephemeral checkout has no Git remote');
}
if (!refreshScriptSource.includes('us_units_30d')
  || !refreshScriptSource.includes('assigned_us_units_30d')
  || !refreshScriptSource.includes('unmapped_us_units_30d')) {
  blockers.push('Warehouse velocity reconciliation must conserve exact 30-day units before rounding');
}
const personalisedCoverDefLine = serverSource.split('\n').find(line => line.includes("'ll-personalised-cover':")) || '';
const littleLifelyNzDefLine = serverSource.split('\n').find(line => line.includes("'llnz':")) || '';
const cushieUsDefLine = serverSource.split('\n').find(line => line.includes("'cusb-us':")) || '';
const caseGoodsDefLine = serverSource.split('\n').find(line => line.includes("'case-goods':")) || '';
if (!serverSource.includes('const LL_NZ_BRANCH_IDS = [48391, 68865];')) {
  blockers.push('New Zealand scope must include Malcove NZ 48391 and Pacificomm NZ 68865');
}
if (!serverSource.includes('const LL_US_BRANCH_IDS = [60701, 63764];')) {
  blockers.push('United States scope must include CA 60701 and NJ 63764 only; stopped PA 65158 must remain excluded');
}
if (!littleLifelyNzDefLine.includes('stockBranches: LL_NZ_BRANCH_IDS')) {
  blockers.push('Little Lifely NZ must use the shared two-warehouse New Zealand scope');
}
if (!cushieUsDefLine.includes('stockBranches: LL_US_BRANCH_IDS')) {
  blockers.push('Cushie US must use the shared active CA + NJ warehouse scope');
}
if (!caseGoodsDefLine.includes("poDestination: 'Australia'") || !caseGoodsDefLine.includes("salesCountry: 'AU'") || !caseGoodsDefLine.includes('stockBranches: LL_AU_BRANCH_IDS')) {
  blockers.push('Case Goods must use the AU Malcove + Capital warehouse scope rather than global Cin7 stock');
}
if (!/const warehouseBranchConfigs = \{[\s\S]*?llnz: LL_NZ_BRANCH_IDS,/.test(serverSource)) {
  blockers.push('Little Lifely NZ warehouse selector must expose both configured New Zealand warehouses');
}
if (!serverSource.includes('const LL_PERSONALISED_COVER_BRANCH_IDS = [74276];')) {
  blockers.push('Personalised Cover warehouse branch must be Cin7 branch 74276');
}
if (!serverSource.includes('if (stockBranches && Number(po.branchId || 0) && !(stockBranches || []).includes(Number(po.branchId || 0))) continue;')) {
  blockers.push('Scoped panels must exclude purchase orders assigned to warehouses outside their configured market');
}
if (!personalisedCoverDefLine.includes('stockBranches: LL_PERSONALISED_COVER_BRANCH_IDS') || !personalisedCoverDefLine.includes('requireBranchMatch: true') || !personalisedCoverDefLine.includes('filterPosByStockBranches: true')) {
  blockers.push('Personalised Cover must require branch-matched stock and branch-matched POs');
}
if (!personalisedCoverDefLine.includes('allowEmptyBranchPanel: true')) blockers.push('New branch 74276 must warn rather than fail health until its first stock rows arrive');
if (personalisedCoverDefLine.includes('supplier:')) blockers.push('Personalised Cover must not filter by supplier');
if (!refreshScriptSource.includes('"branchId": int(po.get("branchId") or 0) or None')) {
  blockers.push('Durable Cin7 cache must preserve PO branchId for warehouse-isolated incoming stock');
}
const syntheticBranchRows = {
  74276: { soh: 11, available: 8, openSales: 3 },
  60976: { soh: 999, available: 999, openSales: 0 }
};
const selectedBranch = syntheticBranchRows[PERSONALISED_COVER_BRANCH_ID];
if (!selectedBranch || selectedBranch.soh !== 11 || selectedBranch.available !== 8 || selectedBranch.openSales !== 3) {
  blockers.push('Personalised Cover branch isolation fixture failed');
}
const cushieCoverageMeta = {
  'cusb-au': { label: 'AU', place: 'Australia' },
  'cusb-us': { label: 'US', place: 'United States' },
  'cusb-ca': { label: 'CA', place: 'Canada' },
  'cusb-uk': { label: 'UK', place: 'United Kingdom' }
};
for (const [id, meta] of Object.entries(cushieCoverageMeta)) {
  const marker = `'${id}':{label:'${meta.label}', place:'${meta.place}'}`;
  if (!frontendSource.includes(marker)) blockers.push(`Cushie coverage columns are not enabled for ${id}`);
}
if (!frontendSource.includes("nextPO:next?.reference||null,nextETA:next?.etaRaw||null,nextQty:next?.qty||0")) {
  blockers.push('Next PO/ETA must remain visible when incoming stock exists without preorder demand');
}
if (!frontendSource.includes("if(!dated.length) return {preorderUnits,nextPO:next?.reference||null,nextETA:null,nextQty:next?.qty||0")) {
  blockers.push('Undated incoming POs must expose their reference without fabricating an ETA');
}
if (!frontendSource.includes('function buildIncomingDateBreakdown()')) {
  blockers.push('Incoming stock must support an ETA-date column breakdown');
}
if (!frontendSource.includes('po?.arrival||po?.estimatedArrivalDate||po?.customFields?.orders_1000||null')) {
  blockers.push('Incoming date columns must use the full PO ETA fallback chain');
}
if (!frontendSource.includes('aria-expanded="${expanded}"') || !frontendSource.includes('aria-controls="stockTable"')) {
  blockers.push('Incoming date-column toggle must expose its expanded state accessibly');
}
if (!frontendSource.includes('onclick="return toggleIncomingDateColumns(event)"') || !frontendSource.includes("if(event){event.preventDefault();event.stopPropagation();}")) {
  blockers.push('Incoming date-column toggle must not bubble into table sorting');
}
if (!frontendSource.includes('data-sortable="false"') || !frontendSource.includes("if (th.dataset.sortable === 'false'")) {
  blockers.push('Incoming total and ETA headers must be excluded from global table sorting');
}
if (!frontendSource.includes('window.scrollTo(viewState.windowX,viewState.windowY)') || !frontendSource.includes('nextWrap.scrollLeft=viewState.tableLeft')) {
  blockers.push('Incoming date-column expansion must preserve the page and table scroll positions');
}
if (!frontendSource.includes("fullLabel:displayDate?displayDate.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'}):'ETA missing'")) {
  blockers.push('Incoming quantities without a valid PO ETA must remain visible as ETA missing');
}
if (!frontendSource.includes('incomingDateCellsHtml(s,incomingDateBuckets)') || !frontendSource.includes('incomingDateCellsHtml(sku,incomingDateBuckets)')) {
  blockers.push('Incoming ETA cells must render in both standard and component stock tables');
}
if (!serverSource.includes("app.get('/api/container-tracking', requireAuth")) {
  blockers.push('Authenticated container-tracking API route is missing');
}
if (!frontendSource.includes('function openContainerTracking(index, event)') || !frontendSource.includes('class="po-track-btn"')) {
  blockers.push('PO rows must retain the container Track action');
}
if (!frontendSource.includes('id="containerTrackingModal"') || !frontendSource.includes('aria-modal="true"')) {
  blockers.push('Container journey popup must retain its accessible modal semantics');
}
if (!containerTrackingSource.includes('function buildContainerJourney') || !containerTrackingSource.includes("101205: 'Unloaded'")) {
  blockers.push('Container journey normalization must preserve the Lecangs unloaded milestone');
}
if (!serverSource.includes(`const CONTAINER_TRACKING_SCHEMA_VERSION = '${TRACKING_SCHEMA_VERSION}'`)
    || !frontendSource.includes(`const CONTAINER_TRACKING_SCHEMA_VERSION = '${TRACKING_SCHEMA_VERSION}'`)) {
  blockers.push('Frontend and API must share the fail-closed container-tracking schema version');
}
if (frontendSource.includes("data.warehouseSource || {name:'Lecangs US'")
    || frontendSource.includes('journey.warehouse || journey.lecangs')
    || frontendSource.includes('sources.warehouse || sources.lecangs')) {
  blockers.push('Frontend must not fall back to Lecangs or legacy warehouse aliases');
}
if (!frontendSource.includes('providerValid')
    || !frontendSource.includes('CONTAINER_PROVIDER_BY_DESTINATION')) {
  blockers.push('Frontend must validate the returned warehouse provider against the PO destination');
}
if (!containerTrackingSource.includes('function resolveTrackingDestination')
    || !containerTrackingSource.includes('function validateFindTeuDestination')
    || !serverSource.includes('destinationResolution.status !==')) {
  blockers.push('Container tracking must fail closed on unresolved PO destinations and wrong FindTEU voyages');
}
if (!serverSource.includes('resolveTrackingDestination(visiblePlannerPo(po))')
    || serverSource.includes("DESTINATIONS['default']")) {
  blockers.push('Standalone shipment tracker must use the shared fail-closed destination resolver');
}
if (!trackerFrontendSource.includes('function hasMappedDestination(s)')
    || !trackerFrontendSource.includes('else if (isAU)')
    || trackerFrontendSource.includes("s.destination.city||s.destination.port||'Melbourne'")
    || trackerFrontendSource.includes('Default: Australia route')) {
  blockers.push('Standalone shipment tracker must withhold unresolved routes instead of defaulting to Australia');
}
if (serverSource.includes('const rowsWithoutReference = listRows.filter')) {
  blockers.push('Cirro must not attach an inbound without an exact PO reference');
}
if (!containerTrackingSource.includes('!!compact(record?.asnNo)')
    || !containerTrackingSource.includes('compact(record?.containerNo) === container')) {
  blockers.push('Lecangs must require ASN, exact PO, and exact container identity');
}
if (!serverSource.includes("state: 'archived'")
    || !serverSource.includes('const warehouseComplete = warehouseResult.state')
    || !serverSource.includes('const poReceived = String(po.stage')
    || !serverSource.includes('warehouseComplete || poReceived')) {
  blockers.push('Completed or Cin7-received journeys must stop querying reusable container numbers');
}
if (!containerTrackingSource.includes("return 'overdue';")) {
  blockers.push('Expired expected tracking dates must become overdue');
}
if (!serverSource.includes('buildContainerTrackingSafetyChecks')
    || !serverSource.includes('Container tracking safety fixture mismatch')) {
  blockers.push('Health checks must include container-tracking truth fixtures');
}
if (!containerTrackingSource.includes('completedVoyageArchived') || !containerTrackingSource.includes('journeyLock')) {
  blockers.push('Completed reused containers must retain a PO/container/ASN journey lock');
}
if (!frontendSource.includes("filter(step => step.state !== 'archived')") || !frontendSource.includes('Original voyage archived')) {
  blockers.push('Completed reused-container voyages must hide superseded carrier warning rows');
}
if (!frontendSource.includes('Port departure to unloading') || !frontendSource.includes('Port departure</div>')) {
  blockers.push('Container tracking must start at port departure and continue through unloading');
}
if (!containerTrackingSource.includes("'pol-departure'") || !containerTrackingSource.includes("'Port departure'")) {
  blockers.push('Container tracking must retain the FindTEU port-departure milestone');
}
if (!containerTrackingSource.includes('function warehouseSourceForDestination')
    || !serverSource.includes("['lecangs_us', 'lecangs_ca'].includes(warehouseSource.key)")
    || !serverSource.includes("warehouseSource.key === 'cirro'")) {
  blockers.push('Warehouse tracking must route US and Canada to isolated Lecangs clients and UK to Cirro');
}
for (const provider of ['Lecangs Canada', 'Cirro', 'Capital Logistics', 'Pacificomm']) {
  if (!containerTrackingSource.includes(provider)) blockers.push(`Warehouse routing is missing provider: ${provider}`);
}
if (frontendSource.includes('POD to unloading') || frontendSource.includes('>POD</div>') || frontendSource.includes('from port of discharge to unloading')) {
  blockers.push('Ambiguous POD / port-of-discharge UI wording is still present');
}
if (!/['\"]cusb-us['\"]:\s*\{[^\n]*poDestination:\s*['\"]United States['\"]/.test(serverSource)) {
  blockers.push('Cushie US must filter POs to United States');
}
if (!/['\"]cusb-uk['\"]:\s*\{[^\n]*poDestination:\s*['\"]United Kingdom['\"]/.test(serverSource)) {
  blockers.push('Cushie UK must filter POs to United Kingdom');
}
const products = cache.cin7Products || {};
const stockByBranch = cache.cin7StockByBranch || {};
const pos = cache.cin7POs || [];

const trackedPos = pos.filter(po => normalizeContainerNumber(po?.trackingCode));
const unresolvedTrackedPos = trackedPos
  .map(po => resolveTrackingDestination(po))
  .filter(result => result.status !== 'resolved');
if (unresolvedTrackedPos.length) {
  blockers.push(`${unresolvedTrackedPos.length} tracked POs have unresolved or conflicting destination identity`);
}
const expectedProviderRoutes = {
  'United States': ['lecangs_us', 'ASN'],
  Canada: ['lecangs_ca', 'ASN'],
  'United Kingdom': ['cirro', 'inbound'],
  Australia: ['capital_logistics', 'warehouse record'],
  'New Zealand': ['pacificomm', 'warehouse record']
};
for (const [destination, [providerKey, recordLabel]] of Object.entries(expectedProviderRoutes)) {
  const route = warehouseSourceForDestination(destination);
  if (route.key !== providerKey || route.recordLabel !== recordLabel) {
    blockers.push(`${destination} tracking route must use ${providerKey} / ${recordLabel}`);
  }
}
if (selectLecangsRecords(
  [{ asnNo: 'ASN-SAFETY', poNo: 'PO-OTHER', containerNo: 'TSTU1234567' }],
  'PO-US-SAFETY',
  'TSTU1234567'
).length) {
  blockers.push('Lecangs reused-container fixture attached an ASN from the wrong PO');
}
const wrongDestination = normalizeFindTeu({
  data: {
    container: { number: 'TSTU1234567' },
    pod: { port: 'Rotterdam', country: 'Netherlands', iso_code: 'NLRTM' }
  }
});
if (validateFindTeuDestination(wrongDestination, 'Singapore').status !== 'mismatch') {
  blockers.push('FindTEU wrong-destination fixture was not rejected');
}
const missingCirroPo = normalizeWarehousePayload(
  {
    data: {
      list: [{
        receiving_code: 'IB-SAFETY',
        reference_no: '',
        query_container: 'TSTU1234567',
        receiving_status: 7
      }]
    }
  },
  warehouseSourceForDestination('United Kingdom'),
  'TSTU1234567',
  'PO-UK-SAFETY'
);
if (missingCirroPo.linkedAsnCount !== 0) {
  blockers.push('Cirro missing-PO fixture attached an inbound by container alone');
}

if (Object.keys(products).length < MIN_PRODUCTS) blockers.push(`Cin7 product count below floor: ${Object.keys(products).length}`);
if (Object.keys(stockByBranch).length === 0) blockers.push('Cin7 branch stock payload missing');
if (!Array.isArray(pos) || pos.length < MIN_POS) blockers.push(`Purchase order count below floor: ${Array.isArray(pos) ? pos.length : 'not-array'}`);
if (pos.some(po => !('items' in (po || {})))) blockers.push('One or more purchase orders are missing an items object');

const optionCounts = {};
for (const product of Object.values(products)) {
  const option1 = String(product?.option1 || '').trim();
  if (option1) optionCounts[norm(option1)] = (optionCounts[norm(option1)] || 0) + 1;
}
for (const required of REQUIRED_OPTION1) if (!optionCounts[norm(required)]) blockers.push(`Required Option1 category missing: ${required}`);

for (const store of EXPECTED_STORES) {
  if (!hasPayload(cache.shopifyInventory, store)) blockers.push(`Shopify ${store} inventory payload missing/empty`);
  if (!hasPayload(cache.shopifyVelocity, store)) blockers.push(`Shopify ${store} velocity payload missing/empty`);
  if (!hasPayload(cache.shopifyVelocityByCountry, store)) blockers.push(`Shopify ${store} velocityByCountry payload missing/empty`);
  if (!hasPayload(cache.shopifyOpenDemand, store)) blockers.push(`Shopify ${store} openDemand payload missing/empty`);
}

for (const [name, value] of Object.entries({ overall: cache.lastRefresh, cin7: cache.lastCin7Refresh, purchaseOrders: cache.lastPoRefresh, shopify: cache.lastShopifyRefresh })) {
  const age = ageHours(value);
  if (age === null) blockers.push(`${name} refresh timestamp missing/invalid`);
  else if (age > WARN_STALE_HOURS) warnings.push(`${name} data is ${age}h old`);
}

for (const [id, def] of Object.entries(CK_DEFS)) {
  let count = 0;
  for (const [sku, data] of Object.entries(products)) if (matchesDef(sku, data.option1 || '', def)) count += 1;
  if (count === 0) blockers.push(`CK panel has zero matching Cin7 SKUs: ${id}`);
}

const personalisedCoverDef = CK_DEFS['ll-personalised-cover'];
for (const sku of ['LLAU-CB-S-DGY-CV', 'LLNA-CB-TW-PST-CV', 'LLSG-CB-Q-BABL-CV', 'LLUK-CB-S-CTCN-CV']) {
  if (!matchesDef(sku, 'Category Killer - Little Lifely', personalisedCoverDef)) blockers.push(`Personalised Cover rejected valid cover SKU: ${sku}`);
}
for (const sku of ['LLAU-CB-S-DGY', 'LLUK-CB-S-FRM', 'LLAU-CB-S-DGY-CV-CSTM']) {
  if (matchesDef(sku, 'Category Killer - Little Lifely', personalisedCoverDef)) blockers.push(`Personalised Cover accepted invalid SKU: ${sku}`);
}

const fixtures = [
  { sku: 'LIFELY-CPD', expected: 'Case Goods' },
  { sku: 'COCOON-DOUBLE-IVR', expected: 'Cocoon Bed' },
  { sku: 'RDNT-D-BASE', expected: 'Radiant' },
  { sku: 'LLAU-CB-S-MSM', expected: 'Little Lifely AU' },
  { sku: 'DD-21153CF', expected: 'Deep Dream' },
  { sku: 'DD-34183K-SFM', expected: 'Deep Dream' },
  { sku: 'DDUK-2190CF', expected: 'LL Mattresses' },
  { sku: 'CAT-EDT-NAL', expected: 'Caterpillar Dining' },
  { sku: 'LLAU-CB-S-MSM-CV-CSTM', expected: 'Uncategorised' }
];
for (const fixture of fixtures) {
  const actual = routeSku(fixture.sku, products);
  if (actual !== fixture.expected) blockers.push(`SKU fixture route mismatch: ${fixture.sku} expected ${fixture.expected}, got ${actual}`);
}

if (warnings.length) {
  console.warn('Demand Planner deploy warnings:');
  for (const warning of warnings) console.warn(`- ${warning}`);
}
if (blockers.length) {
  console.error('Demand Planner deploy blocked:');
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exit(1);
}
console.log(`Demand Planner deploy gate passed: ${Object.keys(products).length} Cin7 SKUs, ${pos.length} POs, ${EXPECTED_STORES.length} Shopify stores checked.`);
