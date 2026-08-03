'use strict';

function cartonAvailableQuantity(carton) {
  if (typeof carton !== 'object' || carton === null) {
    const quantity = Number(carton);
    return Number.isFinite(quantity) ? quantity : 0;
  }

  // Available already accounts for committed sales. A missing Available value
  // must fail closed instead of falling back to physical stock on hand.
  const quantity = Number(carton.available);
  return Number.isFinite(quantity) ? quantity : 0;
}

function aggregateCartonsByWarehouse(cartonSkus, branchIds, stockByBranch) {
  const skus = [...new Set((cartonSkus || []).map(sku => String(sku || '').trim()).filter(Boolean))];
  const branches = [...new Set((branchIds || []).map(id => String(id)))];
  if (skus.length < 2 || branches.length === 0) return null;

  let soh = 0;
  let available = 0;
  let virtual = 0;
  let matchedBranches = 0;

  for (const branchId of branches) {
    const rows = skus.map(sku => stockByBranch?.[sku]?.[branchId]).filter(Boolean);
    if (rows.length === 0) continue;

    // Never construct a parent from only some of its cartons. A partial branch
    // is ambiguous inventory evidence and must fail closed.
    if (rows.length !== skus.length) return null;

    soh += Math.min(...rows.map(row => Number(row.soh || 0)));
    available += Math.min(...rows.map(cartonAvailableQuantity));
    virtual += Math.min(...rows.map(row => Number(row.virtual ?? row.soh ?? 0)));
    matchedBranches += 1;
  }

  if (matchedBranches === 0) return null;
  return { soh, available, virtual, matchedBranches };
}

module.exports = { cartonAvailableQuantity, aggregateCartonsByWarehouse };
