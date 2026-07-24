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

function addLlnaFrameTrend(target, source, bomMap = {}, canonicalize = sku => sku) {
  target._7d ||= {};
  target._30d ||= {};
  target._weeklyBreakdown ||= {};
  target._firstSeen ||= {};

  addLlnaFrameVelocity(target._7d, source?._7d, bomMap, canonicalize);
  addLlnaFrameVelocity(target._30d, source?._30d, bomMap, canonicalize);

  for (const [rawSku, weeks] of Object.entries(source?._weeklyBreakdown || {})) {
    const sku = normalizeSku(canonicalize(rawSku));
    for (const frameSku of llnaFrameComponentsForDemandSku(sku, bomMap)) {
      target._weeklyBreakdown[frameSku] ||= {};
      for (const [week, rawQty] of Object.entries(weeks || {})) {
        target._weeklyBreakdown[frameSku][week] =
          (target._weeklyBreakdown[frameSku][week] || 0) + Number(rawQty || 0);
      }
    }
  }

  for (const [rawSku, firstSeen] of Object.entries(source?._firstSeen || {})) {
    if (!firstSeen) continue;
    const sku = normalizeSku(canonicalize(rawSku));
    for (const frameSku of llnaFrameComponentsForDemandSku(sku, bomMap)) {
      const existing = target._firstSeen[frameSku];
      if (!existing || String(firstSeen) < String(existing)) {
        target._firstSeen[frameSku] = firstSeen;
      }
    }
  }

  return target;
}

module.exports = {
  isLlnaSellableParentSku,
  llnaFrameComponentsForDemandSku,
  addLlnaFrameVelocity,
  addLlnaFrameTrend
};
