'use strict';

function normalizeSku(value) {
  return String(value || '').toUpperCase().trim();
}

function rawComponentMap(bom) {
  const source = bom?.components || bom || {};
  if (Array.isArray(source)) {
    const out = {};
    for (const row of source) {
      const sku = normalizeSku(row?.code || row?.sku || row);
      const qty = Number(row?.qty ?? row?.quantity ?? 1);
      if (!sku || !Number.isFinite(qty) || qty <= 0) continue;
      out[sku] = (out[sku] || 0) + qty;
    }
    return out;
  }
  const out = {};
  for (const [rawSku, rawQty] of Object.entries(source || {})) {
    const sku = normalizeSku(rawSku);
    const qty = Number(rawQty || 0);
    if (!sku || !Number.isFinite(qty) || qty <= 0) continue;
    out[sku] = (out[sku] || 0) + qty;
  }
  return out;
}

function cartonBaseSku(sku) {
  const value = normalizeSku(sku);
  const match = value.match(/^(.+)-(?:[1-4]|C[1-4])$/);
  return match ? match[1] : '';
}

// Cin7 BOM Master can list the sellable/buildable parent and one or more of
// its carton rows together. Those carton siblings describe one required unit,
// so use the limiting/max quantity rather than summing the boxes.
function normalizeBomComponentMap(bom) {
  const direct = rawComponentMap(bom);
  const grouped = {};
  const rawSkus = new Set(Object.keys(direct));

  for (const [sku, qty] of Object.entries(direct)) {
    const base = cartonBaseSku(sku);
    if (!base) {
      if (!grouped[sku]) grouped[sku] = { direct: 0, cartons: [] };
      grouped[sku].direct += qty;
      continue;
    }
    if (!grouped[base]) grouped[base] = { direct: 0, cartons: [] };
    grouped[base].cartons.push(qty);
  }

  const out = {};
  for (const [sku, group] of Object.entries(grouped)) {
    const directQty = group.direct;
    const cartonQty = group.cartons.length ? Math.max(...group.cartons) : 0;
    // When both the base row and carton rows are listed, they describe the
    // same required buildable unit. Keep the larger requirement once.
    out[sku] = directQty > 0 && cartonQty > 0
      ? Math.max(directQty, cartonQty)
      : directQty + cartonQty;
  }

  // A lone numbered child without its base/siblings can be a genuine SKU.
  // Restore it unless the BOM also supplied the base or multiple cartons.
  for (const [sku, qty] of Object.entries(direct)) {
    const base = cartonBaseSku(sku);
    if (!base) continue;
    const siblings = [...rawSkus].filter(candidate => cartonBaseSku(candidate) === base);
    if (!rawSkus.has(base) && siblings.length === 1) {
      delete out[base];
      out[sku] = qty;
    }
  }
  return out;
}

function selectBomMasterRecord(rawSku, bomMap = {}) {
  const sku = normalizeSku(rawSku);
  if (!sku) return null;
  if (bomMap?.[sku]) {
    return {
      requestedSku: sku,
      bomSku: sku,
      alias: false,
      bom: bomMap[sku]
    };
  }
  // The -SET identity is an explicit BOM Master record used when the exact
  // sellable/component code has no BOM Master of its own. Composition and
  // quantity still come exclusively from that BOM Master record.
  if (!sku.endsWith('-SET') && bomMap?.[`${sku}-SET`]) {
    return {
      requestedSku: sku,
      bomSku: `${sku}-SET`,
      alias: true,
      bom: bomMap[`${sku}-SET`]
    };
  }
  return null;
}

function addQty(target, sku, qty) {
  if (!sku || !Number.isFinite(qty) || qty <= 0) return;
  target[sku] = (target[sku] || 0) + qty;
}

function resolveBomMasterLeaves(rawSku, bomMap = {}) {
  const parentSku = normalizeSku(rawSku);
  const root = selectBomMasterRecord(parentSku, bomMap);
  if (!root) {
    return {
      ok: false,
      parentSku,
      reason: 'bom_master_missing',
      components: {},
      provenance: [],
      issues: [`${parentSku}: BOM Master missing`]
    };
  }

  const leaves = {};
  const provenance = [];
  const issues = [];

  const expand = (sku, multiplier, path) => {
    const record = selectBomMasterRecord(sku, bomMap);
    if (!record) {
      addQty(leaves, normalizeSku(sku), multiplier);
      return;
    }
    if (path.includes(record.bomSku)) {
      // A physical component can share the root parent's "-SET" identity
      // (for example RDNT-K-MF inside RDNT-K-MF-SET). In that case the
      // component is a leaf; following the alias back to the root would invent
      // recursion that is not present in BOM Master.
      if (record.alias) {
        addQty(leaves, normalizeSku(sku), multiplier);
        return;
      }
      issues.push(`${record.bomSku}: BOM Master cycle`);
      addQty(leaves, normalizeSku(sku), multiplier);
      return;
    }

    const components = normalizeBomComponentMap(record.bom);
    if (!Object.keys(components).length) {
      issues.push(`${record.bomSku}: BOM Master has no positive components`);
      return;
    }
    provenance.push({
      requestedSku: record.requestedSku,
      bomSku: record.bomSku,
      reference: record.bom?.reference || '',
      modifiedDate: record.bom?.modifiedDate || null,
      alias: record.alias,
      components
    });

    const nextPath = [...path, record.bomSku];
    for (const [componentSku, rawQty] of Object.entries(components)) {
      const qty = Number(rawQty || 0);
      if (!Number.isFinite(qty) || qty <= 0) {
        issues.push(`${record.bomSku}: invalid quantity for ${componentSku}`);
        continue;
      }
      if (!Number.isInteger(qty)) {
        issues.push(`${record.bomSku}: non-integer quantity ${qty} for ${componentSku}`);
      }
      // Some multi-carton BOMs contain the normalized parent itself. Treat it
      // as the required buildable leaf instead of recursing into a cycle.
      if (normalizeSku(componentSku) === normalizeSku(sku)) {
        addQty(leaves, normalizeSku(componentSku), multiplier * qty);
        continue;
      }
      expand(componentSku, multiplier * qty, nextPath);
    }
  };

  expand(parentSku, 1, []);
  return {
    ok: issues.length === 0 && Object.keys(leaves).length > 0,
    parentSku,
    bomSku: root.bomSku,
    components: leaves,
    provenance,
    issues
  };
}

function expandResolvedComponentMap(componentMap = {}) {
  const out = [];
  for (const [sku, rawQty] of Object.entries(componentMap || {})) {
    const qty = Number(rawQty || 0);
    if (!Number.isInteger(qty) || qty <= 0) continue;
    for (let i = 0; i < qty; i += 1) out.push(normalizeSku(sku));
  }
  return out;
}

function isBomMasterDemandParentForPanel(panelId, rawSku) {
  const id = String(panelId || '').toLowerCase();
  const sku = normalizeSku(rawSku);
  if (!sku || /(?:-CV|-FRM|-CSTM)$/.test(sku)) return false;
  if (id === 'llau' || id === 'llnz') {
    return /^LLAU-(?:CBCF|CTP)-/.test(sku)
      || /^LLAU-CB-(?:S|KS|D)-[A-Z0-9]+(?:-SET)?$/.test(sku);
  }
  if (id === 'llau-cbcf') return /^LLAU-CBCF-/.test(sku);
  if (id === 'llna' || id === 'llca') {
    return /^LLNA-(?:CFDS|CTP)-/.test(sku)
      || /^LLNA-CB-(?:TW|TWX|F)-[A-Z0-9]+(?:-SET)?$/.test(sku);
  }
  if (id === 'lluk') {
    return /^LLUK-(?:CBCF|CTP)-/.test(sku)
      || /^LLUK-CB-(?:S|SD|D)-[A-Z0-9]+(?:-SET)?$/.test(sku);
  }
  if (id === 'llsg') {
    return /^LLSG-(?:CFDS|CTP)-/.test(sku)
      || /^LLSG-CB-(?:S|SS|Q)-[A-Z0-9]+-SET$/.test(sku);
  }
  if (id === 'll-mattresses') return /^(?:LLAU|LLUK)-(?:CBCF|CTP)-/.test(sku);
  if (id === 'rdnt') return /^RDNT-.*-SET$/.test(sku) || sku.startsWith('COCOON-RDNT-');
  if (id === 'cocoon') return /^COCOON-(?:DOUBLE|QUEEN|KING|D|Q|K|RDNT-)/.test(sku);
  if (id === 'dd') return /^COCOON-(?:D|Q|K)MF-/.test(sku);
  if (id === 'lifely-sofa') {
    return /^(?:LIFELY-SOFA-|LIFELY-OTM-)/.test(sku)
      || /^LFSF-\d+S(?:-|$)/.test(sku);
  }
  if (id === 'cusb-us' || id === 'cusb-ca') return /^V2-/.test(sku) && /(?:-SET(?:-|$)|-BDL-|\d+X)/.test(sku);
  if (id === 'cusb-us-snuggle' || id === 'cusb-ca-snuggle') return /^V3-/.test(sku) && /(?:-SET(?:-|$)|-BDL-|\d+X)/.test(sku);
  if (id === 'cusb-uk') return /^LFSB-/.test(sku) && /-SET(?:-|$)/.test(sku);
  if (id === 'cusb-uk-snuggle') return /^CUSB-/.test(sku) && /-SET(?:-|$)/.test(sku);
  if (id === 'cusb-au-snuggle') return /^CUSB-/.test(sku) && /-SET(?:-|$)/.test(sku);
  if (id === 'cusb-au-lifely' || id === 'cmss') return /^CMSS-/.test(sku);
  if (id === 'case-goods') return /^(?:EMMA-NOAH-|RKU-SOFA-SET$|RAI-AMBR-.*-4S$)/.test(sku);
  return false;
}

function bomMasterComponentsForPanel(panelId, rawSku, bomMap = {}) {
  if (!isBomMasterDemandParentForPanel(panelId, rawSku)) return null;
  const resolved = resolveBomMasterLeaves(rawSku, bomMap);
  // Empty is deliberate fail-closed behavior: the caller knows this is a
  // parent/configuration but must not fall back to an inferred formula.
  return resolved.ok ? expandResolvedComponentMap(resolved.components) : [];
}

module.exports = {
  normalizeSku,
  rawComponentMap,
  normalizeBomComponentMap,
  selectBomMasterRecord,
  resolveBomMasterLeaves,
  expandResolvedComponentMap,
  isBomMasterDemandParentForPanel,
  bomMasterComponentsForPanel
};
