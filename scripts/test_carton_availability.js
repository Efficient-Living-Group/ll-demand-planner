'use strict';

const assert = require('assert');
const { cartonAvailableQuantity } = require('../lib/inventory');

assert.strictEqual(cartonAvailableQuantity({ available: 0, soh: 5 }), 0);
assert.strictEqual(cartonAvailableQuantity({ available: 3, soh: 5 }), 3);
assert.strictEqual(cartonAvailableQuantity({ soh: 5 }), 0);
assert.strictEqual(cartonAvailableQuantity(4), 4);

const buildable = cartons => Math.min(...cartons.map(cartonAvailableQuantity));
assert.strictEqual(buildable([{ available: 3, soh: 5 }, { available: 0, soh: 2 }]), 0);
assert.strictEqual(buildable([{ available: 0, soh: 1 }, { available: 0, soh: 1 }]), 0);

console.log('Carton availability tests passed');
