#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const trendStart = source.indexOf('function trendIndicator(sku)');
const trendEnd = source.indexOf('// Table sorting', trendStart);
assert(trendStart >= 0 && trendEnd > trendStart, 'trendIndicator source block must exist');

const trendSource = source.slice(trendStart, trendEnd);
assert(!trendSource.includes("title=\"'+tooltip"), 'Trend charts must not use the delayed native title tooltip');
assert(trendSource.includes("5w (old → new): "), 'Trend tooltip must expose exact five-week figures');
assert(trendSource.includes("trendTooltipMarkup(' ▲'"), 'Rising trend must use the instant tooltip');
assert(trendSource.includes("trendTooltipMarkup(' ▼'"), 'Falling trend must use the instant tooltip');
assert(source.includes('onmouseenter="showTrendTooltip(this)"'), 'Pointer hover must show the tooltip immediately');
assert(source.includes('onfocus="showTrendTooltip(this)"'), 'Keyboard focus must expose the same tooltip');
assert(source.includes('tooltip.hidden = false;'), 'Tooltip must become visible synchronously');
assert(source.includes('<div class="trend-tooltip" id="trendTooltip" role="tooltip" hidden></div>'), 'Shared tooltip surface must exist');

const tooltipCss = source.match(/\.trend-tooltip\{([^}]+)\}/)?.[1] || '';
assert(tooltipCss, 'Trend tooltip CSS must exist');
assert(!tooltipCss.includes('transition'), 'Trend tooltip must not add an appearance delay');
assert(!tooltipCss.includes('animation'), 'Trend tooltip must not animate before figures are readable');

console.log('Trend tooltip interaction tests passed');
