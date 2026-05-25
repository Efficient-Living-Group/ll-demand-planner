# Demand Planner field source/calculation discrepancy audit

Date: 2026-05-25 UTC  
Scope: shared/supposedly shared fields across CK dashboard tabs in `ll-demand-planner`.

## Files audited

- `server.js`
- `public/index.html`
- Runtime API output from local authenticated `/api/ck-list` and `/api/ck/:id`, using current `data/cache-snapshot.json`

Supporting generated files:

- `tmp/ck-field-summary-audit.json`
- `tmp/preorder-formula-diffs.json`

## Executive summary

The same visible field names are not fully consistent across tabs. Some differences are intentional per CK/BOM logic, but several are high-risk because the label implies one source while the code uses another calculation.

Highest-risk findings:

1. **`Preorders` is not consistently `max(-Stock.available, 0)` in table coverage columns.**  
   Server-side preorder source uses Cin7 `Stock.available` deficit, but frontend coverage calculation often subtracts SOH again (`Math.max(openDemand - soh, 0)`), especially in generic and Little Lifely coverage paths. This can understate preorder backlog.

2. **`Open Orders` and `Preorders` are mixed through `DATA.shopify` as a legacy negative-demand carrier.**  
   The object name `shopify` now often contains Cin7 preorder deficit, not Shopify inventory/order data. This makes calculations easy to misread and has already caused label/source confusion.

3. **`Net after Open Orders` displays `SOH - openOrders`, not the raw `available` field.**  
   This usually equals Cin7 `Stock.available`, but not always. The app separately returns `available`, yet the UI function `getNet()` does not use it.

4. **`Units/wk` can be real Shopify 30-day velocity or estimated last-in-stock velocity under the same column.**  
   `getVel()` silently falls back to `trendData.lastInStockVel`, so `Units/wk` may be historical estimated velocity while the tooltip says average weekly sales over last 30 days.

5. **Different CKs normalize SKUs differently before showing the same columns.**  
   Examples: Deep Dream/Cocoon/Radiant merge or explode sets/components; Lifely Sofa keeps components; LLAU keeps inactive Shopify SKUs; LL Mattresses has separate regional views. These are probably intentional, but the column labels do not disclose the normalization basis.

## Source map by shared field

### CIN7 SOH

Code paths:

- CK branch/source configuration: `server.js:52`
- Branch stock source: `dataCache.cin7StockByBranch`, aggregated in `buildCKData()` at `server.js:1828+`
- Main row output: `cin7` returned from `server.js:2749+`
- Frontend display: `public/index.html:819+`

Current behavior:

- Most CK tabs aggregate `Stock.stockOnHand` only from configured `stockBranches`.
- `normalizeCIN7()` merges `SKU-1`/`SKU-2` style box splits by **minimum** box SOH.
- `llau` additionally synthesizes swatch pack and now keeps existing inactive/base SKUs visible.
- `llna` now aggregates multiple US branches by default and exposes warehouse-specific views.
- `ll-mattresses` overrides normal panel data with `mattressRegions`.

Risk:

- Same label `CIN7 SOH` can mean: direct branch sum, normalized min-box stock, component-only stock, regional mattress stock, or warehouse-filtered stock.

### Open Orders

Code paths:

- Cin7 metric helper: `getCin7StockMetricBySku()` at `server.js:689`
- Raw open order wrapper: `getCin7OpenSalesBySku()` at `server.js:707`
- Market tab population: `server.js:1957-1989`
- Frontend getter: `getOpenSales()` / `getOpenOrdersDisplay()` at `public/index.html:279`

Current behavior:

- Open Orders comes from Cin7 `/Stock.openSales` when `openOrders[sku]` exists.
- For bundle/combo SKUs, `addCin7DemandToVisibleMap()` can explode demand into component/display SKUs.
- For rows with negative `Stock.available` but zero/blank `Stock.openSales`, Open Orders can display `0` while Preorder deficit exists.

Evidence:

- Runtime audit found 48 SKU rows where `max(openOrders - SOH, 0)` differs from `max(-available, 0)`.
- Large examples in `tmp/preorder-formula-diffs.json` include:
  - `case-goods / ODEN-D120-OAK-ECO`: SOH `1`, Open `0`, Available `-26`
  - `cusb-us / V2-QB-CREAM`: SOH `3`, Open `0`, Available `-16`
  - `cusb-au / LFSB-TW-WHT`: SOH `2`, Open `0`, Available `-12`

Risk:

- If users interpret Open Orders as all outstanding demand, rows with Available < 0 and Open Orders = 0 look contradictory.

### Net after Open Orders

Code paths:

- Frontend getter: `getNet()` at `public/index.html:277`
- Tooltip/header: `public/index.html:819+`

Current behavior:

```js
getNet(s) = DATA.cin7[s] - DATA.openOrders[s]
```

Fallbacks:

- If no `openOrders[s]`, generic coverage open demand can be used.
- Else fallback is `DATA.cin7[s] + Math.min(DATA.shopify[s], 0)`.

Risk:

- The API returns `available`, but the UI does not use it for Net.
- If Cin7 `Stock.available` differs from `SOH - openSales`, the visible Net differs from the actual `available` source of truth.

Recommendation:

- Either rename this field to **SOH minus Open Orders**, or make `getNet()` use `DATA.available[s]` where available.

### Preorders / preorder coverage

Code paths:

- Preorder metric helper: `getCin7PreordersBySku()` at `server.js:711`, using `max(-Stock.available, 0)`.
- Little Lifely coverage data: `coverageAux.openDemandBySku` at `server.js:2099-2137`.
- Generic coverage data: `coverageAux.openDemandBySku` at `server.js:2144-2180`.
- Frontend coverage calculation: `buildPreorderCoverage()` at `public/index.html:283`.
- Table coverage columns: `public/index.html:816-833`.

Current behavior:

Server correctly sources preorder deficit from `max(-available, 0)` in several paths.

But frontend coverage often does:

```js
preorderUnits = Math.max(openDemandOrOpenSales - soh, 0)
```

For generic coverage, `openDemandBySku` is already preorder deficit, not raw open sales. Subtracting SOH again can understate backlog.

Risk:

- High. Same `Preorders` label can show available deficit in cards but a second-derived `open/deficit minus SOH` in table coverage cells.

Recommendation:

- Split variables clearly:
  - `rawOpenOrders = Stock.openSales`
  - `preorderDeficit = max(-Stock.available, 0)`
  - `netAvailable = Stock.available`
- Table `Preorders` should display `preorderDeficit` directly, not recompute from open orders/SOH.

### Incoming

Code paths:

- PO inclusion: `server.js` `isOpenPO()` around `server.js:684`.
- Dashboard incoming getter: `getIncoming()` at `public/index.html:278`.
- PO tab data: `/api/all-pos` around `server.js:2949+`.

Current behavior:

- Dashboard `Incoming` sums open POs from `DATA.pos` for the visible SKU.
- PO status logic uses open PO rules: not received, not void/cancelled.
- This is generally consistent, but the PO tab also shows all/history POs when filters allow.

Risk:

- Medium/low. Same PO records, but tab context differs: dashboard incoming = open incoming only; PO tab can include received/history depending on filter.

### Units/wk

Code paths:

- Shopify velocity fetch: `fetchShopifyVelocity()` at `server.js:1410+`.
- Velocity merge/explosion: `server.js:1995+`.
- Frontend getter: `getVel()` at `public/index.html:427`.
- Trend data: `server.js:2797+`.

Current behavior:

- Base source is Shopify order history, 30-day units ÷ 30 × 7.
- Some CKs explode bundle velocity into component rows.
- If current velocity is 0 and `lastInStockVel` exists, frontend `getVel()` returns last active-week average instead.

Risk:

- Medium/high. Column label says last-30-day Shopify velocity, but displayed value can be an estimate.
- Reorder/stockout calculations also use `getVel()`, so they may use estimated demand while appearing as live 30-day sales velocity.

Recommendation:

- Keep separate display fields: `Units/wk` and `Estimated Units/wk`, or show an explicit `est` summary/card when fallback is used.

### Wks Left / Wks Left + Incoming

Code paths:

- Dashboard row calculation: `public/index.html:822+`
- Projection helper: `project()` around `public/index.html:445+`
- Reorder tab: `renderReorder()` at `public/index.html:920+`

Current behavior:

- `Wks Left Now = getNet() / getVel()`.
- Because `getNet()` may not use `available`, and `getVel()` may be estimated, this field inherits both inconsistencies.

Risk:

- Medium/high for reorder decisions.

### Coverage PO / Preorder Date / Coverage Status

Code paths:

- Coverage helper: `buildPreorderCoverage()` at `public/index.html:283`.
- Component/BOM helper: `renderSeparateComponentPanel()` at `public/index.html:530+`.
- Table columns: `public/index.html:816-833`.

Current behavior:

- Coverage status uses dated PO rows and accumulated incoming qty.
- For Little Lifely AU/NZ/UK, coverage can combine bed/mattress or frame/cover logic.
- For generic tabs, coverage uses `coverageAux.poRows`.

Risk:

- Medium/high because coverage start quantity may be wrong if `preorderUnits` is recomputed incorrectly.

### FOB / Freight/u / Landed / CBM

Code paths:

- Cost from Cin7 product/product option: `server.js:1254-1257`, `1293-1303`.
- Landed-cost calculation section: `server.js:2574+`.
- Frontend display: `public/index.html:833+`.

Current behavior:

- FOB is from Cin7 `costAUD` or USD×FX.
- Freight/u and Landed can come from Excel landed costs or CBM-based estimates.
- Swatches/covers/protectors are skipped by landed-cost logic.

Risk:

- Medium. Field names are shared, but rows with estimated vs actual landed cost have different confidence. Current UI marks estimates but summary-level users may miss it.

## CK/tab special cases that intentionally diverge

| CK/tab family | Divergence |
|---|---|
| Little Lifely AU/NZ | Bed + mattress combo coverage; AU also keeps inactive/base SKUs and has warehouse filter. |
| Little Lifely NA/CA/SG | Dropship/combo family handling; combo demand can be funneled into stocked bed SKUs. |
| Little Lifely UK | Frame-cover component mode, not standard bed rows. |
| LL Mattresses | Region switcher replaces base API maps with `mattressRegions`; velocity comes from combo sales. |
| Radiant | Set SKUs are exploded into components; set rows are hidden. |
| Cocoon/Deep Dream | Combo rows can be excluded/exploded to bed or mattress side. |
| Lifely Sofa | Keeps physical component/carton SKUs; does not merge back into sellable combos. |
| Cushie US | Uses verified SKU mapping before panel aggregation. |
| Case Goods | No coverage columns currently despite large `available` vs open order discrepancies. |

## Recommendations

### P0 — Align preorder/net semantics

1. Make API return explicit maps for every CK:
   - `sohBySku`
   - `rawOpenOrdersBySku`
   - `availableBySku`
   - `preorderDeficitBySku`
   - `incomingBySku`
2. Frontend table should not derive preorder deficit from open orders/SOH.
3. `getNet()` should either:
   - use `DATA.available[s]`, and label `Net Available`, or
   - keep current formula and label it exactly `SOH - Open Orders`.

### P1 — Remove misleading `shopify` demand carrier

Rename/replace `DATA.shopify` in API/frontend for demand planning use. Suggested structure:

```js
inventoryBySku: { shopify: ..., cin7: ... }
demandBySku: { rawOpenOrders, preorderDeficit, velocity }
```

### P1 — Add source badges/tooltips per tab

Example:

- SOH: `Cin7 Stock.stockOnHand · branches: AU 3+60976`
- Open Orders: `Cin7 Stock.openSales`
- Preorders: `max(-Cin7 Stock.available, 0)`
- Units/wk: `Shopify paid orders · 30d` or `Estimated last-active weeks`

### P2 — Add automated audit test

Add a script that fails if:

- table preorder formula differs from `max(-available, 0)` for rows with coverage columns,
- `Net after Open Orders` differs from `available` when the UI claims available-based net,
- same field label maps to multiple source paths without an explicit tooltip/source badge.

## Immediate fix candidates

1. Fix `buildPreorderCoverage()` so `preorderUnits` is taken from `preorderDeficitBySku` directly.
2. Update `getNet()` to use `DATA.available[s]` if the intended business meaning is net available.
3. Stop using `DATA.shopify` to carry Cin7 preorder deficits.
4. Add `fieldSources` metadata to `/api/ck/:id`, so frontend labels are generated from source metadata rather than static generic copy.

## Fixes applied after audit

Commit pending from this working session applies the first remediation pass:

- Frontend `Preorders` / coverage now uses explicit preorder deficit via `getPreorderUnits()` instead of treating preorder deficit as raw open sales and subtracting SOH again.
- `Net after Open Orders` was relabelled to `Net Available`, and `getNet()` now prefers Cin7 `Stock.available` when present.
- API now returns an explicit `incoming` map per CK.
- Warehouse-filtered views now include branch-specific `incoming`; frontend `getIncoming()` uses that map before falling back to PO rows.

Remaining design work:

- `DATA.shopify` is still a legacy negative preorder carrier in parts of the frontend. It should be renamed to an explicit preorder/demand map in a future cleanup.
- Normalized SKU vs raw PO item matching still needs a dedicated normalization layer for PO rows.
- `Units/wk` still needs clearer source labelling or split actual/estimated velocity fields.
