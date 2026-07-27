'use strict';

function normalizeSku(value) {
  return String(value || '').toUpperCase().trim();
}

function isLlnaSellableParentSku(sku) {
  const s = normalizeSku(sku);
  if (!s || /-(?:CV|FRM)$/.test(s)) return false;
  return /^LLNA-CB-(TWX|TW|F)-[A-Z0-9]+(?:-SET)?$/.test(s)
    || /^LLNA-CFDS-(TWX|TW|F)-[A-Z0-9]+(?:-SET)?$/.test(s);
}

function isLlnaShopifyVelocitySku(rawSku) {
  const sku = normalizeSku(rawSku);
  if (!sku || /-(?:FRM|CSTM)$/.test(sku)) return false;
  return /^LLNA-CTP-(?:TWX|TW|F)-/.test(sku)
    || /^LLNA-CB-(?:TWX|TW|F)-[A-Z0-9]+(?:-SET)?$/.test(sku)
    || /^LLNA-CFDS-(?:TWX|TW|F)-[A-Z0-9]+(?:-SET)?$/.test(sku)
    || /^LLNA-CB-(?:TWX|TW|F)-[A-Z0-9]+-CV$/.test(sku);
}

function isLlauActiveSetShopifyVelocitySku(rawSku) {
  const sku = normalizeSku(rawSku);
  if (!sku) return false;
  // Transition packs are active top-level sets even though their current
  // Shopify/Cin7 identity does not always carry a literal "-SET" suffix.
  return /^LLAU-CTP-(?:S|KS|D)-/.test(sku)
    || /^LLAU-CB-(?:S|KS|D)-[A-Z0-9]+-SET$/.test(sku)
    || /^LLAU-CBCF-(?:S|KS|D)-[A-Z0-9]+-SET$/.test(sku)
    // Swatch packs remain a separately sold planning item and are not a
    // legacy Little Lifely bed SKU.
    || sku === 'LLAU-CB-CS-PACK';
}

function isShopifyVelocitySourceEligibleForPanel(panelId, rawSku) {
  const id = String(panelId || '').toLowerCase();
  const sku = normalizeSku(rawSku);
  if (!sku) return false;

  if (id === 'llna' || id === 'llca') {
    return isLlnaShopifyVelocitySku(sku);
  }
  if (id === 'llau' || id === 'llnz' || id === 'llau-cbcf') {
    return isLlauActiveSetShopifyVelocitySku(sku);
  }
  if (id === 'll-mattresses' && sku.startsWith('LLAU-')) {
    return isLlauActiveSetShopifyVelocitySku(sku);
  }
  return true;
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

function directBomComponentsForDemandSku(rawSku, bomMap = {}, preferSetAlias = false) {
  const sku = normalizeSku(rawSku);
  if (!sku) return [];
  const alias = sku.endsWith('-SET') ? sku.slice(0, -4) : `${sku}-SET`;
  const candidates = preferSetAlias && !sku.endsWith('-SET') ? [alias, sku] : [sku, alias];

  for (const candidate of candidates) {
    const bom = bomMap?.[candidate];
    if (!bom) continue;
    const components = expandComponents(bom.components || bom);
    if (components.length) return components;
  }
  return [];
}

function littleLifelyCtpComponentsForDemandSku(rawSku, bomMap = {}) {
  const sku = normalizeSku(rawSku);
  if (!/^(?:LLAU|LLNA|LLUK)-CTP-/.test(sku)) return [];
  // LLNA has historical non-SET BOMs that point back to sellable bed parents;
  // the current -SET BOM is the physical frame/cover/mattress assembly.
  return directBomComponentsForDemandSku(sku, bomMap, sku.startsWith('LLNA-CTP-'));
}

function cocoonPhysicalComponentsForDemandSku(rawSku, bomMap = {}) {
  const sku = normalizeSku(rawSku);
  if (!/^COCOON-(?:DOUBLE|QUEEN|KING)-(?:CRML|IVR|MSGRN)$/.test(sku)) return [];
  return directBomComponentsForDemandSku(sku, bomMap)
    .filter(componentSku => /-(?:FRM|CV)$/.test(componentSku));
}

function caseGoodsBundleComponentsForDemandSku(rawSku) {
  const sku = normalizeSku(rawSku);
  if (sku === 'EMMA-NOAH-4S') {
    return ['EMMA-DT180-OAK-ECO', 'NOAH-DC-WHT-ECO', 'NOAH-DC-WHT-ECO'];
  }
  return [];
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
  isLlnaShopifyVelocitySku,
  isLlauActiveSetShopifyVelocitySku,
  isShopifyVelocitySourceEligibleForPanel,
  directBomComponentsForDemandSku,
  littleLifelyCtpComponentsForDemandSku,
  cocoonPhysicalComponentsForDemandSku,
  caseGoodsBundleComponentsForDemandSku,
  llnaFrameComponentsForDemandSku,
  addLlnaFrameVelocity,
  addLlnaFrameTrend
};
