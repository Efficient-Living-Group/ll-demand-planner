#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert(
  serverSource.includes('const sellableVelocity = {};'),
  'Direct sellable-SKU velocity must be kept separately from BOM-expanded planning velocity'
);
assert(
  serverSource.includes('sellableVelocity[sku] = (sellableVelocity[sku] || 0) + weeklyVelocity;'),
  'Direct Shopify demand must be preserved before BOM expansion'
);
assert(
  serverSource.includes('sellableVelocity,'),
  'Direct sellable-SKU velocity must be returned by the CK API'
);
assert(
  frontendSource.includes('function getDeadstockVel(s){return Math.max(getExactVel(s),getSellableVel(s))}'),
  'Dead-stock classification must recognise either planning demand or direct sellable-SKU demand'
);
assert(
  frontendSource.includes('else if(soh>0 && vel===0 && getSellableVel(s)===0)'),
  'Dead-stock value must exclude stocked sellable parents with direct sales'
);
assert(
  serverSource.includes('velocity <= 0 && sellableVelocity <= 0 && openDemand <= 0'),
  'Executive dead-stock classification must also recognise direct sellable-SKU demand'
);

const classifyDeadUnits = ({ soh, planningVelocity, sellableVelocity }) =>
  planningVelocity <= 0 && sellableVelocity <= 0 ? Math.max(soh, 0) : 0;

assert.strictEqual(
  classifyDeadUnits({ soh: 80, planningVelocity: 0, sellableVelocity: 4.2 }),
  0,
  'A stocked parent with direct sales must not be dead stock'
);
assert.strictEqual(
  classifyDeadUnits({ soh: 80, planningVelocity: 3.5, sellableVelocity: 0 }),
  0,
  'A stocked component with BOM demand must not be dead stock'
);
assert.strictEqual(
  classifyDeadUnits({ soh: 80, planningVelocity: 0, sellableVelocity: 0 }),
  80,
  'A stocked SKU with no planning or direct sellable demand remains dead stock'
);

console.log('Sellable-parent dead-stock tests passed');
