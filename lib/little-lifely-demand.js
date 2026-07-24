'use strict';

function normalizeSku(value) {
  return String(value || '').toUpperCase().trim();
}

function isLlnaSellableParentSku(sku) {
  const s = normalizeSku(sku);
  if (!s || /-(?:CV|FRM)$/.test(s)) return false;
  return /^LLNA-CB-(TWX|TW|F)-[A-Z0-9]+(?:-SET)?$/.test(s)
    || /^LLNA-CFDS-(TWX|TW|F)-[A-Z0-9]+(?:-SET)?$/.test(s)
    || /^LLNA-CTP-(TWX|TW|F)-[A-Z0-9]+-[A-Z0-9]+(?:-SET)?$/.test(s);
}

function expandComponents(components) {
  if (Array.isArray(components)) {
    return components.map(normalizeSku).filter(Boolean);
  }

  const expanded = [];
  for (const [rawSku, rawQty] of Object.entries(components || {})) {
    const sku = normalizeSku(rawSku);
    const qty = Math.max(0, Math.round(Number(rawQty || 0)));
    for (let i = 0; i < qty; i += 1) expanded.push(sku);
  }
  return expanded;
}

function llnaFrameComponentsForDemandSku(rawSku, bomMap = {}) {
  const sku = normalizeSku(rawSku);
  if (!isLlnaSellableParentSku(sku)) return [];

  const candidates = [sku];
  if (!sku.endsWith('-SET')) candidates.push(`${sku}-SET`);

  for (const candidate of candidates) {
    const bom = bomMap?.[candidate];
    if (!bom) continue;
    const frames = expandComponents(bom.components || bom)
      .filter(componentSku => /^LLNA-CB-(TWX|TW|F)-FRM$/.test(componentSku));
    if (frames.length) return frames;
  }

  const size = sku.match(/^LLNA-(?:CB|CFDS|CTP)-(TWX|TW|F)-/)?.[1];
  return size ? [`LLNA-CB-${size}-FRM`] : [];
}

function addLlnaFrameVelocity(target, source, bomMap = {}, canonicalize = sku => sku) {
  for (const [rawSku, rawVelocity] of Object.entries(source || {})) {
    if (String(rawSku || '').startsWith('_')) continue;
    const sku = normalizeSku(canonicalize(rawSku));
    const velocity = Number(rawVelocity || 0);
    if (!velocity) continue;
    for (const frameSku of llnaFrameComponentsForDemandSku(sku, bomMap)) {
      target[frameSku] = (target[frameSku] || 0) + velocity;
    }
  }
  return target;
}

module.exports = {
  isLlnaSellableParentSku,
  llnaFrameComponentsForDemandSku,
  addLlnaFrameVelocity
};
