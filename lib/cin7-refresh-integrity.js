'use strict';

function countKeys(value) {
  return value && typeof value === 'object' ? Object.keys(value).length : 0;
}

function retainedFloor(existingCount, minimum, ratio = 0.75) {
  const existing = Math.max(0, Number(existingCount || 0));
  return existing > 0
    ? Math.max(minimum, Math.floor(existing * ratio))
    : minimum;
}

function validateCin7RefreshCandidate(existing = {}, candidate = {}) {
  const counts = {
    products: countKeys(candidate.products),
    branchStock: countKeys(candidate.stockByBranch),
    boms: countKeys(candidate.boms),
    purchaseOrders: Array.isArray(candidate.purchaseOrders) ? candidate.purchaseOrders.length : 0
  };
  const existingCounts = {
    products: countKeys(existing.products),
    branchStock: countKeys(existing.stockByBranch),
    boms: countKeys(existing.boms),
    purchaseOrders: Array.isArray(existing.purchaseOrders) ? existing.purchaseOrders.length : 0
  };
  const floors = {
    products: retainedFloor(existingCounts.products, 1000),
    branchStock: retainedFloor(existingCounts.branchStock, 250),
    boms: retainedFloor(existingCounts.boms, 250),
    purchaseOrders: retainedFloor(existingCounts.purchaseOrders, 100)
  };
  const errors = [];
  for (const key of Object.keys(floors)) {
    if (counts[key] < floors[key]) {
      errors.push(`${key} incomplete: ${counts[key]} received, ${floors[key]} required`);
    }
  }
  return { ok: errors.length === 0, counts, existingCounts, floors, errors };
}

module.exports = { retainedFloor, validateCin7RefreshCandidate };
