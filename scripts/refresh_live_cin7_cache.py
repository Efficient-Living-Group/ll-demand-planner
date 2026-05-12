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
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / "data" / "cache-snapshot.json"
CACHE_BACKUP_PATH = ROOT / "data" / "cache-snapshot.last-good.json"
CIN7_CRED_PATH = Path("/home/lifely-agent/.openclaw/credentials/cin7.json")
GITHUB_JAKE_PATH = Path("/home/lifely-agent/.openclaw/credentials/github-jake.json")

ROWS = 250
SPACING_SECONDS = 1.55
MIN_PRODUCTS = 1000
MIN_PURCHASE_ORDERS = 50


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


def clean_po_reference(ref: Any) -> str:
    value = str(ref or "")
    return value[:-6] if value.lower().endswith("-cover") else value


def build_products_and_stock(products_raw: list[dict[str, Any]], stock_raw: list[dict[str, Any]], fx_usd_aud: float) -> tuple[dict[str, Any], dict[str, Any]]:
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
            }
        style_code = product.get("styleCode")
        if style_code and (product.get("stockOnHand") or 0) > 0:
            products[style_code] = {
                "soh": product.get("stockOnHand") or 0,
                "available": product.get("stockAvailable") or 0,
                "cbm": cbm,
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
            products[sku] = {"soh": total_soh, "available": total_available, "costAUD": 0, "cbm": 0}

    return products, stock_by_branch


def merge_pos_by_reference(pos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for po in pos:
        ref = po.get("reference") or f"__id_{po.get('id')}"
        if ref not in merged:
            merged[ref] = po
            continue
        existing = merged[ref]
        for sku, qty in (po.get("items") or {}).items():
            existing.setdefault("items", {})[sku] = existing.setdefault("items", {}).get(sku, 0) + qty
        for sku, name in (po.get("itemNames") or {}).items():
            existing.setdefault("itemNames", {})[sku] = name
        # Prefer non-empty latest metadata without discarding received/status fields.
        for field in ["arrival", "etd", "estimatedArrivalDate", "fullyReceivedDate", "trackingCode", "port", "stage", "status"]:
            if po.get(field):
                existing[field] = po[field]
    return list(merged.values())


def build_purchase_orders(pos_raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pos: list[dict[str, Any]] = []
    for po in pos_raw:
        if po.get("isVoid"):
            continue
        items: dict[str, float] = {}
        item_names: dict[str, str] = {}
        for line in po.get("lineItems") or []:
            sku = line.get("code")
            qty = line.get("qty") or 0
            if sku and qty > 0:
                items[sku] = items.get(sku, 0) + float(qty)
                if line.get("name"):
                    item_names[sku] = line["name"]
        if not items:
            continue
        pos.append({
            "id": po.get("id") or po.get("ID") or po.get("purchaseOrderId") or po.get("orderId"),
            "reference": clean_po_reference(po.get("reference")),
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
            "items": items,
        })
    return merge_pos_by_reference(pos)


def write_cache(products: dict[str, Any], stock_by_branch: dict[str, Any], pos: list[dict[str, Any]], dry_run: bool = False) -> None:
    existing = load_json(CACHE_PATH, {})
    ts = now_iso()
    snapshot = {
        **existing,
        "snapshotCreatedAt": ts,
        "lastSnapshotWrite": ts,
        "lastRefresh": ts,
        "lastCin7Refresh": ts,
        "lastPoRefresh": ts,
        "cin7Products": products,
        "cin7StockByBranch": stock_by_branch,
        "cin7POs": pos,
        "shopifyVelocity": existing.get("shopifyVelocity", {}),
        "shopifyVelocityByCountry": existing.get("shopifyVelocityByCountry", {}),
        "shopifyInventory": existing.get("shopifyInventory", {}),
        "shopifyOpenDemand": existing.get("shopifyOpenDemand", {}),
        "lastShopifyRefresh": existing.get("lastShopifyRefresh"),
        "error": None,
        "cin7Source": "live-cin7-api-cache",
        "cacheGeneratedBy": "scripts/refresh_live_cin7_cache.py",
    }
    if dry_run:
        print(f"DRY RUN: would write {len(products)} SKUs, {len(pos)} POs at {ts}")
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
    args = parser.parse_args()

    auth = cin7_auth_header()
    try:
        products_raw = fetch_all("Products", auth, max_pages=60)
        stock_raw = fetch_all("Stock", auth, max_pages=80)
        pos_raw = fetch_all("PurchaseOrders", auth, max_pages=20)
    except RateLimited as exc:
        print(str(exc))
        return 75

    products, stock_by_branch = build_products_and_stock(products_raw, stock_raw, fx_usd_aud=1.45)
    pos = build_purchase_orders(pos_raw)
    print(f"Fetched live Cin7: products_raw={len(products_raw)}, stock_rows={len(stock_raw)}, SKUs={len(products)}, POs={len(pos)}")
    if len(products) < MIN_PRODUCTS or len(pos) < MIN_PURCHASE_ORDERS:
        print(f"Refusing to write suspicious cache: SKUs={len(products)}, POs={len(pos)}")
        return 2

    write_cache(products, stock_by_branch, pos, dry_run=args.dry_run)
    if args.commit and not args.dry_run:
        git_commit_and_push("Update live Cin7 cache")
    elif args.push:
        print("--push requires --commit; skipping push")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
