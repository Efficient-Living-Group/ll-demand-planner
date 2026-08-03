const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert(html.includes('function skuCopyCell(sku,labelHtml='), 'shared SKU copy-cell renderer missing');
assert(html.includes('class="sku-copy-button" data-sku='), 'SKU copy button missing');
assert(html.includes('aria-label="Copy SKU ${safe}"'), 'copy button accessible name missing');
assert(html.includes("navigator.clipboard?.writeText&&window.isSecureContext"), 'secure Clipboard API path missing');
assert(html.includes('try{await navigator.clipboard.writeText(value);return;}catch{}'), 'Clipboard API rejection must fall back to the legacy copy path');
assert(html.includes("document.execCommand('copy')"), 'clipboard fallback missing');
assert(html.includes("event.target.closest?.('.sku-copy-button')"), 'delegated copy interaction missing');
assert(html.includes('event.preventDefault();event.stopPropagation();copySkuFromButton(button);'), 'copy action must not trigger grid or table sorting');
assert(html.includes('return`<tr><td>${skuCopyCell(s,skuLabel(s))}</td>'), 'main stock SKU column must use the shared copy renderer');
assert(html.includes('.sku-copy-value{') && html.includes('user-select:text'), 'SKU text must remain selectable');
assert(html.includes('.sku-copy-button:focus-visible{'), 'copy button keyboard focus state missing');
assert(html.includes('SKU_COPIED_ICON'), 'copy success feedback missing');

const captureStart = html.indexOf('function captureLlnaClassicTable()');
const captureEnd = html.indexOf('function llnaGridTheme()', captureStart);
const captureBody = html.slice(captureStart, captureEnd);
assert(captureBody.includes("text=(cell?.textContent||'').trim()"), 'AG Grid must keep deriving searchable SKU text from the classic cell');

console.log('SKU one-click copy control regression: PASS');
