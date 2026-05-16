#!/usr/bin/env python3
"""Refresh the Demand Planner fallback cache from the live Cin7 API.

This is intentionally independent of the Render app. Render's filesystem and
process memory are ephemeral, so the durable fallback cache must be generated
outside Render and committed to the repo. If Cin7 is rate-limited or returns a
partial/empty dataset, this script leaves the existing cache untouched.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / "data" / "cache-snapshot.json"
CACHE_BACKUP_PATH = ROOT / "data" / "cache-snapshot.last-good.json"
CIN7_CRED_PATH = Path("/home/lifely-agent/.openclaw/credentials/cin7.json")
SHOPIFY_CRED_PATH = Path("/home/lifely-agent/.openclaw/credentials/shopify.json")
GITHUB_JAKE_PATH = Path("/home/lifely-agent/.openclaw/credentials/github-jake.json")

ROWS = 250
SPACING_SECONDS = 1.55
MIN_PRODUCTS = 1000
MIN_PURCHASE_ORDERS = 50
SHOPIFY_STORES = {
    "lifely": "lifely",
    "cushie": "cushie",
    "littlelifely": "little_lifely",
}
SHOPIFY_SPACING_SECONDS = 0.55


class RateLimited(RuntimeError):
    def __init__(self, endpoint: str, retry_after: str | None):
        super().__init__(f"Cin7 rate limited {endpoint}; Retry-After={retry_after or 'unknown'}")
        self.endpoint = endpoint
        self.retry_after = retry_after


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def cin7_auth_header() -> str:
    creds = load_json(CIN7_CRED_PATH, {})
    raw = f"{creds['api_username']}:{creds['api_key']}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def load_shopify_stores() -> tuple[str, dict[str, dict[str, str]]]:
    creds = load_json(SHOPIFY_CRED_PATH, {})
    api_version = creds.get("api_version") or "2026-01"
    stores = creds.get("stores") or {}
    resolved: dict[str, dict[str, str]] = {}
    for planner_key, credential_key in SHOPIFY_STORES.items():
        store = stores.get(credential_key) or {}
        domain = store.get("shop_domain") or store.get("domain") or store.get("shop")
        token = store.get("access_token") or store.get("token") or store.get("admin_api_access_token")
        if domain and token:
            resolved[planner_key] = {"domain": domain, "token": token}
    return api_version, resolved


def cin7_get(endpoint: str, page: int, auth: str) -> list[dict[str, Any]]:
    url = f"https://api.cin7.com/api/v1/{endpoint}?page={page}&rows={ROWS}"
    req = urllib.request.Request(url, headers={"Authorization": auth})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            status = res.status
            payload = res.read().decode("utf-8")
            if status == 429:
                raise RateLimited(endpoint, res.headers.get("Retry-After"))
            data = json.loads(payload) if payload else []
            if not isinstance(data, list):
                raise RuntimeError(f"Unexpected Cin7 {endpoint} page {page} response: {type(data).__name__}")
            return data
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RateLimited(endpoint, exc.headers.get("Retry-After")) from exc
        raise RuntimeError(f"Cin7 {endpoint} page {page} HTTP {exc.code}: {exc.reason}") from exc


def fetch_all(endpoint: str, auth: str, max_pages: int = 100) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for page in range(1, max_pages + 1):
        data = cin7_get(endpoint, page, auth)
        print(f"{endpoint} page {page}: {len(data)} rows")
        if not data:
            break
        rows.extend(data)
        time.sleep(SPACING_SECONDS)
    return rows


def next_path_from_link(link: str | None) -> str | None:
    if not link:
        return None
    match = re.search(r'<([^>]+)>;\s*rel="next"', link)
    if not match:
        return None
    parsed = urlsplit(match.group(1))
    return parsed.path + (f"?{parsed.query}" if parsed.query else "")


def shopify_get(domain: str, token: str, path: str) -> tuple[dict[str, Any], dict[str, str]]:
    req = urllib.request.Request(
        f"https://{domain}{path}",
        headers={"X-Shopify-Access-Token": token, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            payload = res.read().decode("utf-8")
            data = json.loads(payload) if payload else {}
            headers = {k.lower(): v for k, v in res.headers.items()}
            return data, headers
    except urllib.error.HTTPError as exc:
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
        if exc.code == 429:
            raise RuntimeError(f"Shopify rate limited {domain}; Retry-After={retry_after or 'unknown'}") from exc
        raise RuntimeError(f"Shopify {domain} HTTP {exc.code}: {exc.reason}") from exc


def parse_shopify_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def country_code(order: dict[str, Any]) -> str | None:
    addr = order.get("shipping_address") or {}
    raw = str(addr.get("country_code") or addr.get("country") or "").strip()
    if not raw:
        return None
    return raw.upper() if len(raw) == 2 else raw


def week_key(dt: datetime) -> str:
    start = datetime(dt.year, 1, 1, tzinfo=dt.tzinfo)
    jan4 = datetime(dt.year, 1, 4, tzinfo=dt.tzinfo)
    js_jan4_day = (jan4.weekday() + 1) % 7
    day_of_year = (dt - start).days
    week_num = max(1, math.ceil((day_of_year + js_jan4_day + 1) / 7))
    return f"{dt.year}-W{week_num:02d}"


def ensure_country_bucket(by_country: dict[str, Any], country: str) -> dict[str, Any]:
    if country not in by_country:
        by_country[country] = {"skuUnits": {}, "skuWeekly": {}, "sku7d": {}, "sku30d": {}, "skuFirstSeen": {}}
    return by_country[country]


def fetch_shopify_velocity(store_key: str, store: dict[str, str], api_version: str) -> dict[str, Any]:
    sku_units: dict[str, float] = {}
    sku_weekly: dict[str, dict[str, float]] = {}
    sku_7d: dict[str, float] = {}
    sku_30d: dict[str, float] = {}
    sku_first_seen: dict[str, datetime] = {}
    by_country: dict[str, Any] = {}
    now = datetime.now(timezone.utc)
    now_7d = now - timedelta(days=7)
    now_30d = now - timedelta(days=30)
    since = (now - timedelta(days=90)).isoformat().replace("+00:00", "Z")
    params = {
        "status": "any",
        "limit": 250,
        "created_at_min": since,
        "fields": "id,created_at,line_items,financial_status,shipping_address",
    }
    path = f"/admin/api/{api_version}/orders.json?{urlencode(params)}"
    orders_seen = 0

    for page in range(1, 31):
        body, headers = shopify_get(store["domain"], store["token"], path)
        orders = body.get("orders") or []
        print(f"Shopify velocity {store_key} page {page}: {len(orders)} orders")
        if not orders:
            break
        orders_seen += len(orders)
        for order in orders:
            if order.get("financial_status") in {"refunded", "voided"}:
                continue
            dt = parse_shopify_datetime(order.get("created_at"))
            if not dt:
                continue
            wk = week_key(dt)
            c = country_code(order)
            bucket = ensure_country_bucket(by_country, c) if c else None
            for line in order.get("line_items") or []:
                sku = line.get("sku")
                if not sku:
                    continue
                qty = float(line.get("quantity") or 0)
                sku_units[sku] = sku_units.get(sku, 0) + qty
                if dt >= now_7d:
                    sku_7d[sku] = sku_7d.get(sku, 0) + qty
                if dt >= now_30d:
                    sku_30d[sku] = sku_30d.get(sku, 0) + qty
                if sku not in sku_first_seen or dt < sku_first_seen[sku]:
                    sku_first_seen[sku] = dt
                sku_weekly.setdefault(sku, {})[wk] = sku_weekly.setdefault(sku, {}).get(wk, 0) + qty

                if bucket is not None:
                    bucket["skuUnits"][sku] = bucket["skuUnits"].get(sku, 0) + qty
                    if dt >= now_7d:
                        bucket["sku7d"][sku] = bucket["sku7d"].get(sku, 0) + qty
                    if dt >= now_30d:
                        bucket["sku30d"][sku] = bucket["sku30d"].get(sku, 0) + qty
                    if sku not in bucket["skuFirstSeen"] or dt < bucket["skuFirstSeen"][sku]:
                        bucket["skuFirstSeen"][sku] = dt
                    bucket["skuWeekly"].setdefault(sku, {})[wk] = bucket["skuWeekly"].setdefault(sku, {}).get(wk, 0) + qty
        next_path = next_path_from_link(headers.get("link"))
        if not next_path:
            break
        path = next_path
        time.sleep(SHOPIFY_SPACING_SECONDS)

    weeks = 30 / 7
    velocity = {sku: round((units / weeks) * 10) / 10 for sku, units in sku_30d.items()}
    for sku in sku_units:
        velocity.setdefault(sku, 0)
    velocity["_weeklyBreakdown"] = sku_weekly
    velocity["_7d"] = sku_7d
    velocity["_30d"] = sku_30d
    velocity["_firstSeen"] = {sku: dt.isoformat().replace("+00:00", "Z") for sku, dt in sku_first_seen.items()}
    velocity["_byCountry"] = {}
    for country, bucket in by_country.items():
        country_velocity = {sku: round((units / weeks) * 10) / 10 for sku, units in bucket["sku30d"].items()}
        for sku in bucket["skuUnits"]:
            country_velocity.setdefault(sku, 0)
        country_velocity["_weeklyBreakdown"] = bucket["skuWeekly"]
        country_velocity["_7d"] = bucket["sku7d"]
        country_velocity["_30d"] = bucket["sku30d"]
        country_velocity["_firstSeen"] = {sku: dt.isoformat().replace("+00:00", "Z") for sku, dt in bucket["skuFirstSeen"].items()}
        velocity["_byCountry"][country] = country_velocity
    print(f"Shopify velocity {store_key}: {orders_seen} orders, {len([k for k in velocity if not k.startswith('_')])} SKUs")
    return velocity


def fetch_shopify_open_demand(store_key: str, store: dict[str, str], api_version: str) -> dict[str, dict[str, float]]:
    open_demand: dict[str, dict[str, float]] = {}
    params = {"status": "open", "limit": 250, "fields": "id,financial_status,shipping_address,line_items"}
    path = f"/admin/api/{api_version}/orders.json?{urlencode(params)}"
    orders_seen = 0
    for page in range(1, 41):
        body, headers = shopify_get(store["domain"], store["token"], path)
        orders = body.get("orders") or []
        print(f"Shopify open demand {store_key} page {page}: {len(orders)} orders")
        if not orders:
            break
        orders_seen += len(orders)
        for order in orders:
            if order.get("financial_status") in {"refunded", "voided"}:
                continue
            c = country_code(order)
            if not c:
                continue
            bucket = open_demand.setdefault(c, {})
            for line in order.get("line_items") or []:
                sku = line.get("sku")
                if not sku:
                    continue
                qty = line.get("fulfillable_quantity")
                if qty is None:
                    qty = line.get("current_quantity")
                if qty is None:
                    qty = line.get("quantity")
                qty = float(qty or 0)
                if qty <= 0:
                    continue
                bucket[sku] = bucket.get(sku, 0) + qty
        next_path = next_path_from_link(headers.get("link"))
        if not next_path:
            break
        path = next_path
        time.sleep(SHOPIFY_SPACING_SECONDS)
    print(f"Shopify open demand {store_key}: {orders_seen} orders, {sum(len(v) for v in open_demand.values())} country/SKU rows")
    return open_demand


def fetch_shopify_inventory(store_key: str, store: dict[str, str], api_version: str) -> dict[str, Any]:
    inventory: dict[str, Any] = {}
    inactive: set[str] = set()
    params = {"limit": 250, "fields": "id,status,variants"}
    path = f"/admin/api/{api_version}/products.json?{urlencode(params)}"
    products_seen = 0
    for page in range(1, 21):
        body, headers = shopify_get(store["domain"], store["token"], path)
        products = body.get("products") or []
        print(f"Shopify inventory {store_key} page {page}: {len(products)} products")
        if not products:
            break
        products_seen += len(products)
        for product in products:
            status = product.get("status") or "active"
            for variant in product.get("variants") or []:
                sku = variant.get("sku")
                if not sku:
                    continue
                inventory[sku] = inventory.get(sku, 0) + float(variant.get("inventory_quantity") or 0)
                if status != "active":
                    inactive.add(sku)
        next_path = next_path_from_link(headers.get("link"))
        if not next_path:
            break
        path = next_path
        time.sleep(SHOPIFY_SPACING_SECONDS)
    inventory["__inactive__"] = sorted(inactive)
    print(f"Shopify inventory {store_key}: {products_seen} products, {len([k for k in inventory if not k.startswith('__')])} SKUs")
    return inventory


def fetch_shopify_snapshot() -> dict[str, Any]:
    api_version, stores = load_shopify_stores()
    missing = sorted(set(SHOPIFY_STORES) - set(stores))
    if missing:
        raise RuntimeError(f"Missing Shopify credentials for planner stores: {', '.join(missing)}")
    velocity: dict[str, Any] = {}
    velocity_by_country: dict[str, Any] = {}
    inventory: dict[str, Any] = {}
    open_demand: dict[str, Any] = {}
    for store_key, store in stores.items():
        velocity[store_key] = fetch_shopify_velocity(store_key, store, api_version)
        velocity_by_country[store_key] = velocity[store_key].get("_byCountry") or {}
        inventory[store_key] = fetch_shopify_inventory(store_key, store, api_version)
        open_demand[store_key] = fetch_shopify_open_demand(store_key, store, api_version)
    return {
        "shopifyVelocity": velocity,
        "shopifyVelocityByCountry": velocity_by_country,
        "shopifyInventory": inventory,
        "shopifyOpenDemand": open_demand,
    }


def build_products_and_stock(products_raw: list[dict[str, Any]], product_options_raw: list[dict[str, Any]], stock_raw: list[dict[str, Any]], fx_usd_aud: float) -> tuple[dict[str, Any], dict[str, Any]]:
    products: dict[str, Any] = {}
    stock_by_branch: dict[str, Any] = {}

    for product in products_raw:
        cbm = product.get("volume") or 0
        for variant in product.get("productOptions") or []:
            sku = variant.get("code")
            if not sku:
                continue
            pc = variant.get("priceColumns") or {}
            cost_aud = pc.get("costAUD") or ((pc.get("costUSD") or 0) * fx_usd_aud)
            products[sku] = {
                "soh": variant.get("stockOnHand") or 0,
                "available": variant.get("stockAvailable") or 0,
                "costAUD": cost_aud,
                "cbm": cbm,
                "option1": variant.get("option1") or product.get("option1") or "",
            }
        style_code = product.get("styleCode")
        if style_code and (product.get("stockOnHand") or 0) > 0:
            products[style_code] = {
                "soh": product.get("stockOnHand") or 0,
                "available": product.get("stockAvailable") or 0,
                "cbm": cbm,
                "option1": product.get("option1") or "",
            }

    for option in product_options_raw:
        sku = option.get("code") or option.get("productOptionCode")
        if not sku:
            continue
        pc = option.get("priceColumns") or {}
        cost_aud = pc.get("costAUD") or ((pc.get("costUSD") or 0) * fx_usd_aud)
        existing = products.get(sku) or {}
        products[sku] = {
            **existing,
            "soh": existing.get("soh", option.get("stockOnHand") or 0),
            "available": existing.get("available", option.get("stockAvailable") or 0),
            "costAUD": existing.get("costAUD") or cost_aud or 0,
            "cbm": existing.get("cbm") or 0,
            "option1": option.get("option1") or existing.get("option1") or "",
        }

    for row in stock_raw:
        sku = row.get("code")
        branch_id = row.get("branchId") or 0
        if not sku or not branch_id:
            continue
        branch_key = str(int(branch_id))
        stock_by_branch.setdefault(sku, {})[branch_key] = {
            "soh": float(row.get("stockOnHand") or 0),
            "available": float(row.get("available") or 0),
            "branchName": row.get("branchName") or "",
        }

    for sku, branches in stock_by_branch.items():
        total_soh = sum(float(b.get("soh") or 0) for b in branches.values())
        total_available = sum(float(b.get("available") or 0) for b in branches.values())
        if sku in products:
            products[sku]["soh"] = total_soh
            products[sku]["available"] = total_available
        else:
            products[sku] = {"soh": total_soh, "available": total_available, "costAUD": 0, "cbm": 0, "option1": ""}

    return products, stock_by_branch


def build_purchase_orders(pos_raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pos: list[dict[str, Any]] = []
    for po in pos_raw:
        if po.get("isVoid"):
            continue
        items: dict[str, float] = {}
        item_names: dict[str, str] = {}
        item_option1: dict[str, str] = {}
        for line in po.get("lineItems") or []:
            sku = line.get("code")
            qty = line.get("qty") or 0
            if sku and qty > 0:
                items[sku] = items.get(sku, 0) + float(qty)
                if line.get("name"):
                    item_names[sku] = line["name"]
                if line.get("option1"):
                    item_option1[sku] = line["option1"]
        if not items:
            continue
        pos.append({
            "id": po.get("id") or po.get("ID") or po.get("purchaseOrderId") or po.get("orderId"),
            "reference": str(po.get("reference") or ""),
            "status": po.get("status"),
            "stage": po.get("stage") or "",
            "arrival": po.get("estimatedArrivalDate"),
            "etd": po.get("estimatedDeliveryDate"),
            "estimatedArrivalDate": po.get("estimatedArrivalDate"),
            "fullyReceivedDate": po.get("fullyReceivedDate"),
            "customFields": po.get("customFields") or {},
            "company": po.get("company") or "",
            "total": po.get("total") or 0,
            "currencyCode": po.get("currencyCode") or "USD",
            "deliveryCountry": po.get("deliveryCountry") or "",
            "deliveryCity": po.get("deliveryCity") or "",
            "trackingCode": po.get("trackingCode") or "",
            "port": po.get("port") or "",
            "logisticsCarrier": po.get("logisticsCarrier") or "",
            "internalComments": po.get("internalComments") or "",
            "freightTotal": po.get("freightTotal") or 0,
            "createdBy": po.get("createdBy"),
            "invoiceDate": po.get("invoiceDate"),
            "supplierInvoiceReference": po.get("supplierInvoiceReference") or "",
            "itemNames": item_names,
            "itemOption1": item_option1,
            "items": items,
        })
    return pos


def write_cache(
    products: dict[str, Any],
    stock_by_branch: dict[str, Any],
    pos: list[dict[str, Any]],
    shopify_payload: dict[str, Any] | None = None,
    dry_run: bool = False,
    cin7_updated: bool = True,
) -> None:
    existing = load_json(CACHE_PATH, {})
    ts = now_iso()
    shopify_payload = shopify_payload or {}
    shopify_updated = bool(shopify_payload)
    snapshot = {
        **existing,
        "snapshotCreatedAt": ts,
        "lastSnapshotWrite": ts,
        "lastRefresh": ts,
        "lastCin7Refresh": ts if cin7_updated else existing.get("lastCin7Refresh"),
        "lastPoRefresh": ts if cin7_updated else existing.get("lastPoRefresh"),
        "cin7Products": products,
        "cin7StockByBranch": stock_by_branch,
        "cin7POs": pos,
        "shopifyVelocity": shopify_payload.get("shopifyVelocity", existing.get("shopifyVelocity", {})),
        "shopifyVelocityByCountry": shopify_payload.get("shopifyVelocityByCountry", existing.get("shopifyVelocityByCountry", {})),
        "shopifyInventory": shopify_payload.get("shopifyInventory", existing.get("shopifyInventory", {})),
        "shopifyOpenDemand": shopify_payload.get("shopifyOpenDemand", existing.get("shopifyOpenDemand", {})),
        "lastShopifyRefresh": ts if shopify_updated else existing.get("lastShopifyRefresh"),
        "error": None,
        "cin7Source": "live-cin7-api-cache",
        "cacheGeneratedBy": "scripts/refresh_live_cin7_cache.py",
    }
    if dry_run:
        print(f"DRY RUN: would write {len(products)} SKUs, {len(pos)} POs at {ts}; shopify_updated={shopify_updated}")
        return
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(snapshot, separators=(",", ":"))
    CACHE_PATH.write_text(payload)
    CACHE_BACKUP_PATH.write_text(payload)
    print(f"Wrote cache: {len(products)} SKUs, {len(pos)} POs at {ts}")


def git_commit_and_push(message: str) -> None:
    subprocess.run(["git", "add", "data/cache-snapshot.json", "data/cache-snapshot.last-good.json"], cwd=ROOT, check=True)
    diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
    if diff.returncode == 0:
        print("No cache diff to commit")
        return
    subprocess.run(["git", "commit", "-m", message], cwd=ROOT, check=True)

    if not GITHUB_JAKE_PATH.exists():
        subprocess.run(["git", "push", "origin", "main"], cwd=ROOT, check=True)
        return
    gh = load_json(GITHUB_JAKE_PATH, {})
    raw = f"{gh.get('user', 'x-access-token')}:{gh['pat']}".encode()
    header = "Authorization: Basic " + base64.b64encode(raw).decode()
    subprocess.run(["git", "-c", "credential.helper=", "-c", f"http.extraHeader={header}", "push", "origin", "main"], cwd=ROOT, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--push", action="store_true")
    parser.add_argument("--include-shopify", action="store_true", help="Refresh Shopify velocity/inventory/open-demand data as part of the cache write")
    parser.add_argument("--skip-cin7", action="store_true", help="Reuse existing Cin7 cache and refresh only requested non-Cin7 sources")
    args = parser.parse_args()

    existing = load_json(CACHE_PATH, {})
    cin7_updated = not args.skip_cin7
    if args.skip_cin7:
        products = existing.get("cin7Products") or {}
        stock_by_branch = existing.get("cin7StockByBranch") or {}
        pos = existing.get("cin7POs") or []
        print(f"Reusing existing Cin7 cache: SKUs={len(products)}, POs={len(pos)}")
    else:
        auth = cin7_auth_header()
        try:
            products_raw = fetch_all("Products", auth, max_pages=60)
            product_options_raw = fetch_all("ProductOptions", auth, max_pages=60)
            stock_raw = fetch_all("Stock", auth, max_pages=80)
            pos_raw = fetch_all("PurchaseOrders", auth, max_pages=20)
        except RateLimited as exc:
            print(str(exc))
            return 75

        products, stock_by_branch = build_products_and_stock(products_raw, product_options_raw, stock_raw, fx_usd_aud=1.45)
        pos = build_purchase_orders(pos_raw)
        print(f"Fetched live Cin7: products_raw={len(products_raw)}, product_options={len(product_options_raw)}, stock_rows={len(stock_raw)}, SKUs={len(products)}, POs={len(pos)}")

    if len(products) < MIN_PRODUCTS or len(pos) < MIN_PURCHASE_ORDERS:
        print(f"Refusing to write suspicious cache: SKUs={len(products)}, POs={len(pos)}")
        return 2

    shopify_payload = fetch_shopify_snapshot() if args.include_shopify else None

    write_cache(products, stock_by_branch, pos, shopify_payload=shopify_payload, dry_run=args.dry_run, cin7_updated=cin7_updated)
    if args.commit and not args.dry_run:
        message = "Update live Cin7 and Shopify cache" if args.include_shopify and cin7_updated else "Update live Shopify cache" if args.include_shopify else "Update live Cin7 cache"
        git_commit_and_push(message)
    elif args.push:
        print("--push requires --commit; skipping push")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
