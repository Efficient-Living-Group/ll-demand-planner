'use strict';

const assert = require('assert');
const { cartonAvailableQuantity, aggregateCartonsByWarehouse } = require('../lib/inventory');

assert.strictEqual(cartonAvailableQuantity({ available: 0, soh: 5 }), 0);
assert.strictEqual(cartonAvailableQuantity({ available: 3, soh: 5 }), 3);
assert.strictEqual(cartonAvailableQuantity({ soh: 5 }), 0);
assert.strictEqual(cartonAvailableQuantity(4), 4);

const buildable = cartons => Math.min(...cartons.map(cartonAvailableQuantity));
assert.strictEqual(buildable([{ available: 3, soh: 5 }, { available: 0, soh: 2 }]), 0);
assert.strictEqual(buildable([{ available: 0, soh: 1 }, { available: 0, soh: 1 }]), 0);

const stockByBranch = {
  'SET-1': {
    A: { soh: 2, available: 1, virtual: 2 },
    B: { soh: 1, available: -4, virtual: 1 }
  },
  'SET-2': {
    A: { soh: 1, available: 0, virtual: 1 },
    B: { soh: 2, available: -3, virtual: 2 }
  }
};
assert.deepStrictEqual(
  aggregateCartonsByWarehouse(['SET-1', 'SET-2'], ['A', 'B'], stockByBranch),
  { soh: 2, available: -4, virtual: 2, matchedBranches: 2 }
);
assert.strictEqual(
  aggregateCartonsByWarehouse(['SET-1', 'SET-2'], ['A'], { 'SET-1': stockByBranch['SET-1'] }),
  null,
  'partial carton evidence must fail closed'
);

console.log('Carton availability tests passed');
