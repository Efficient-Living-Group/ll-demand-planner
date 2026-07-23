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

module.exports = { cartonAvailableQuantity };
