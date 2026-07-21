#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const match = html.match(/function toggleIncomingDateColumns\(event\)\{[\s\S]*?\n\}\nfunction incomingHeaderHtml/);
assert(match, 'toggleIncomingDateColumns must exist in public/index.html');
const functionSource = match[0].replace(/\nfunction incomingHeaderHtml$/, '');

const originalWrap = { scrollLeft: 216, scrollTop: 37 };
const nextWrap = { scrollLeft: 0, scrollTop: 0 };
let rendered = false;
let dashboardRenders = 0;
let bomRenders = 0;
let restoredWindow = null;
let focusedWith = null;
const event = {
  prevented: false,
  stopped: false,
  preventDefault() { this.prevented = true; },
  stopPropagation() { this.stopped = true; }
};

const context = {
  DATA: { bomData: null },
  window: {
    scrollX: 18,
    scrollY: 640,
    _incomingDateColumnsExpanded: false,
    scrollTo(x, y) { restoredWindow = { x, y }; }
  },
  document: {
    getElementById(id) {
      assert.strictEqual(id, 'stockTable');
      return { closest: selector => {
        assert.strictEqual(selector, '.table-wrap');
        return rendered ? nextWrap : originalWrap;
      } };
    },
    querySelector(selector) {
      assert.strictEqual(selector, '#stockTable .incoming-toggle');
      return { focus(options) { focusedWith = options; } };
    }
  },
  renderDashboard() { dashboardRenders += 1; rendered = true; },
  renderBOM() { bomRenders += 1; rendered = true; },
  requestAnimationFrame(callback) { callback(); }
};

vm.runInNewContext(functionSource, context);
const returned = context.toggleIncomingDateColumns(event);

assert.strictEqual(returned, false, 'inline handler must return false');
assert.strictEqual(event.prevented, true, 'toggle must prevent default behavior');
assert.strictEqual(event.stopped, true, 'toggle must stop the click from reaching table sorting');
assert.strictEqual(context.window._incomingDateColumnsExpanded, true, 'toggle must expand incoming dates');
assert.strictEqual(dashboardRenders, 1, 'standard table must render once');
assert.strictEqual(bomRenders, 0, 'standard table must not render BOM mode');
assert.deepStrictEqual(restoredWindow, { x: 18, y: 640 }, 'page position must be restored');
assert.strictEqual(nextWrap.scrollLeft, 216, 'horizontal table position must be preserved');
assert.strictEqual(nextWrap.scrollTop, 37, 'vertical table position must be preserved');
assert.strictEqual(focusedWith?.preventScroll, true, 'restored focus must not move the page');

console.log('Incoming toggle interaction test passed.');
