const assert = require('assert');
const { validateCin7RefreshCandidate } = require('../lib/cin7-refresh-integrity');

function keyed(count) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`SKU-${i}`, {}]));
}

const healthyExisting = {
  products: keyed(4951),
  stockByBranch: keyed(2481),
  boms: keyed(2232),
  purchaseOrders: Array.from({ length: 596 }, (_, i) => ({ id: i }))
};

const partialManualPull = validateCin7RefreshCandidate(healthyExisting, {
  products: keyed(1000),
  stockByBranch: {},
  boms: {},
  purchaseOrders: Array.from({ length: 195 }, (_, i) => ({ id: i }))
});
assert.strictEqual(partialManualPull.ok, false, 'Partial Cin7 pull must fail closed');
assert(partialManualPull.errors.some(error => error.startsWith('products incomplete:')));
assert(partialManualPull.errors.some(error => error.startsWith('branchStock incomplete:')));
assert(partialManualPull.errors.some(error => error.startsWith('boms incomplete:')));
assert(partialManualPull.errors.some(error => error.startsWith('purchaseOrders incomplete:')));

const completePull = validateCin7RefreshCandidate(healthyExisting, {
  products: keyed(4900),
  stockByBranch: keyed(2450),
  boms: keyed(2200),
  purchaseOrders: Array.from({ length: 580 }, (_, i) => ({ id: i }))
});
assert.strictEqual(completePull.ok, true, 'Complete Cin7 pull should pass');

console.log('Cin7 refresh integrity tests passed');
