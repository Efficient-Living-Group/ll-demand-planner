const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.strictEqual(pkg.dependencies['ag-grid-community'], '36.0.2', 'AG Grid Community must be pinned');
assert.strictEqual(pkg.scripts.postinstall, 'node scripts/install_frontend_vendor.js', 'local browser bundle installer missing');
assert(html.includes("const LLNA_GRID_PREF_KEY='dpLlnaGridMode:v1'"), 'LLNA pilot preference missing');
assert(html.includes("function getLlnaGridMode(){return localStorage.getItem(LLNA_GRID_PREF_KEY)==='ag'?'ag':'classic'}"), 'classic must be the default');
assert(html.includes("const available=Boolean(currentCK)&&isLlnaGridDesktop()"), 'AG Grid switch must be available on every CK desktop tab');
assert(html.includes("if(!currentCK||getLlnaGridMode()!=='ag'||!isLlnaGridDesktop()){showLlnaClassicTable();return;}"), 'runtime must fail back outside CK desktop views');
assert(html.includes('<span class="llna-grid-pilot-label">Table view</span>'), 'global table-view label missing');
assert(html.includes('>AG Grid</button>'), 'global AG Grid switch label missing');
assert(html.includes("script.src='/vendor/ag-grid-community.min.js?v=36.0.2'"), 'AG Grid must load from the pinned local bundle');
assert(html.includes('function captureLlnaClassicTable()'), 'classic table adapter missing');
assert(html.includes("const table=document.getElementById('stockTable')"), 'AG Grid must read the already-rendered classic table');
assert(html.includes('window.__llnaAgGridParity='), 'runtime parity evidence missing');
assert(html.includes("showLlnaClassicTable('AG Grid unavailable — Classic restored')"), 'automatic Classic fallback missing');
assert(html.includes('@media(max-width:768px){.llna-grid-pilot-controls,.llna-grid-pilot-shell{display:none!important}}'), 'mobile must remain on the classic table');
assert(html.includes('.llna-grid-state[hidden]{display:none}'), 'loading state must disappear after grid creation');
assert(html.includes('aria-pressed="${mode===\'ag\'}"'), 'view switch accessibility state missing');
assert(html.includes('id="stockTableWrap"') && html.includes('id="stockTable"'), 'classic table must remain intact');
assert(html.includes("row[column.field]=text;row.__cells[column.field]="), 'grid values must remain searchable text');
assert(html.includes("getQuickFilterText:params=>String(params.value||'')"), 'quick filter text adapter missing');
assert(html.includes("function classifyLlnaGridSku(sku)"), 'LLNA generation classifier missing');
assert(html.includes("['all','All'],['legacy','Legacy SKUs'],['components','New FRM + CV']"), 'LLNA segment tabs missing');
assert(html.includes("const available=currentCK==='llna'||currentCK==='dd';root.hidden=!available"), 'LLNA and Deep Dream segment visibility guard missing');
assert(html.includes("isExternalFilterPresent:()=>(currentCK==='llna'||currentCK==='dd')&&llnaGridSegment!=='all'"), 'segment filters must not affect other CK tabs');
assert(html.includes('doesExternalFilterPass:node=>stockGridSegmentMatches(node.data)'), 'shared segment filter predicate missing');
assert(html.includes("row.__llnaSegment=classifyLlnaGridSku"), 'LLNA segment must derive from the rendered SKU cell');
assert(html.includes("definition.headerComponent=LlnaIncomingHeaderComponent"), 'Incoming header ETA control missing');
assert(html.includes("this.eta.id='llnaGridIncomingToggle'"), 'ETA header control must preserve focus restoration');
assert(!html.includes('<button type="button" id="llnaGridIncomingToggle" onclick="return toggleIncomingDateColumns(event)">'), 'ETA control must not remain in the detached toolbar');

const captureStart = html.indexOf('function captureLlnaClassicTable()');
const captureEnd = html.indexOf('function llnaGridTheme()', captureStart);
const captureBody = html.slice(captureStart, captureEnd);
assert(!/\bDATA\b/.test(captureBody), 'presentation adapter must not recalculate from planner data');

const selectStart = html.indexOf('async function selectCK(ckId)');
const selectEnd = html.indexOf('function refreshAgeHours', selectStart);
const selectBody = html.slice(selectStart, selectEnd);
assert(selectBody.includes("llnaGridSearch='';llnaGridSegment='all'"), 'table search and LLNA segment must reset between CK tabs');
assert(selectBody.includes('showLlnaClassicTable()'), 'existing grid must be destroyed while a new CK tab loads');

console.log('All-tab AG Grid switch regression: PASS');
