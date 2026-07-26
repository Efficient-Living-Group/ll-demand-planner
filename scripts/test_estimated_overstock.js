#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
assert(source.includes('function getExactVel(s)'), 'Exact current velocity helper must exist');
assert(source.includes('filtered.forEach(s=>{let vel=getExactVel(s)'), 'Financial overstock must use exact current velocity, never historical estimates');
assert(source.includes('wks>=25&&vel>0&&!isEstVel(s)'), 'Row-level overstock dollars must exclude estimated velocity');
assert(source.includes('w>=25&&sku&&isEstVel(sku)'), 'Estimated rows above 25 weeks must be labelled as estimates, not overstock');
assert(source.includes('>ESTIMATE</span>'), 'Estimated status badge must be visible');
console.log('Estimated overstock exclusion tests passed');
