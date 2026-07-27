#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const helperStart = source.indexOf('const STOCK_TURN_TRAILING_DAYS=90;');
const helperEnd = source.indexOf('function fmtStockTurnDays', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, '90-day stock-turn helper must exist');

const helper = source.slice(helperStart, helperEnd);
assert(helper.includes('DATA.weeklyData?.[s]'), 'Stock turn must use mapped Shopify weekly history');
assert(helper.includes('trailingUnits/STOCK_TURN_TRAILING_DAYS*7'), '90-day units must be normalized to a weekly rate for the shared day formula');
assert(!helper.includes('lastInStockVel'), 'Stock turn must not use the estimated last-in-stock velocity');

assert(source.includes('tTurnVel+=getStockTurnVel(s)'), 'Average stock turn must aggregate 90-day trailing velocity');
assert(source.includes('calcStockTurnDays(tNet,tTurnVel)'), 'Average stock turn must use the 90-day aggregate');
assert(source.includes('calcStockTurnDays(net,getStockTurnVel(s))'), 'Row stock turn and target status must use the 90-day rate');
assert(source.includes('primaryTurnVel += getStockTurnVel(sku);'), 'Component summary stock turn must use the 90-day rate');
assert(source.includes('primaryVel += c.totalDemand;'), 'The existing 30-day Avg Wks Stock calculation must remain unchanged');
assert(source.includes('90-day trailing Shopify sales ÷ 90'), 'Stock-turn formula must be explained in the UI');

const ninetyDayUnits = 900;
const weeklyRate = ninetyDayUnits / 90 * 7;
const netAvailable = 300;
const stockTurnDays = netAvailable / weeklyRate * 7;
assert.strictEqual(stockTurnDays, 30, '900 units over 90 days with 300 available must equal 30 stock-turn days');

console.log('90-day stock-turn tests passed');
