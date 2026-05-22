#!/usr/bin/env python3
"""Sync rows into a NocoDB table.

Token-safe: pass secrets via env vars or CLI. This script never stores tokens.

Examples:
  # Append all rows from a CSV
  NOCODB_BASE_URL="https://nocodb.example.com" \
  NOCODB_TOKEN="***" \
  python3 scripts/nocodb_table_sync.py \
    --table-id "m123abc" \
    --file data/stock_rows.csv \
    --mode append

  # Upsert rows by SKU + market
  NOCODB_BASE_URL="https://nocodb.example.com" \
  NOCODB_TOKEN="***" \
  python3 scripts/nocodb_table_sync.py \
    --table-id "m123abc" \
    --file data/stock_rows.json \
    --mode upsert \
    --key-columns sku,market

Expected JSON input:
  - a list of row objects, OR
  - an object containing one of: rows, records, data, items

NocoDB notes:
  - Uses v2 table API: /api/v2/tables/{tableId}/records
  - Sends both `xc-token` and `Authorization: Bearer` headers for compatibility.
  - Upsert fetches existing records, matches by key columns, updates matches, creates misses.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_PAGE_SIZE = 1000
RECORD_ID_CANDIDATES = ("Id", "id", "ID", "_id", "ncRecordId", "row_id")


class NocoDBError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Append/upsert CSV or JSON rows into a NocoDB table.")
    parser.add_argument("--base-url", default=os.getenv("NOCODB_BASE_URL"), help="NocoDB base URL, e.g. https://nocodb.example.com. Or env NOCODB_BASE_URL.")
    parser.add_argument("--token", default=os.getenv("NOCODB_TOKEN"), help="NocoDB API token. Or env NOCODB_TOKEN.")
    parser.add_argument("--table-id", required=True, help="NocoDB table ID, e.g. md_xxxxx.")
    parser.add_argument("--file", required=True, help="CSV or JSON file containing rows to sync.")
    parser.add_argument("--mode", choices=("append", "upsert"), default="upsert", help="append creates all rows; upsert updates existing rows matched by key columns.")
    parser.add_argument("--key-columns", default="", help="Comma-separated key columns for upsert, e.g. sku,market. Required for mode=upsert.")
    parser.add_argument("--id-column", default="", help="Optional NocoDB record id column. Auto-detected from Id/id/etc if omitted.")
    parser.add_argument("--batch-size", type=int, default=50, help="Rows per create/update batch attempt. Script falls back to one-by-one if batch format is rejected.")
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE, help="Existing-record fetch page size.")
    parser.add_argument("--dry-run", action="store_true", help="Read and compare, but do not write to NocoDB.")
    parser.add_argument("--sleep", type=float, default=0.12, help="Sleep between write requests to avoid rate limits.")
    return parser.parse_args()


def require(value: str | None, name: str) -> str:
    if not value:
        raise SystemExit(f"Missing {name}. Pass it as an arg or env var.")
    return value.rstrip("/") if name == "NOCODB_BASE_URL" else value


def load_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise SystemExit(f"Input file not found: {path}")

    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as f:
            return [coerce_row(row) for row in csv.DictReader(f)]

    with path.open(encoding="utf-8") as f:
        payload = json.load(f)

    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = None
        for key in ("rows", "records", "data", "items"):
            if isinstance(payload.get(key), list):
                rows = payload[key]
                break
        if rows is None:
            raise SystemExit("JSON object must contain a list under rows, records, data, or items.")
    else:
        raise SystemExit("JSON input must be a list or an object containing rows/records/data/items.")

    clean_rows = []
    for row in rows:
        if not isinstance(row, dict):
            raise SystemExit("Every input row must be an object/dict.")
        clean_rows.append(coerce_row(row))
    return clean_rows


def coerce_row(row: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in row.items():
        if key is None or str(key).strip() == "":
            continue
        cleaned[str(key).strip()] = coerce_value(value)
    return cleaned


def coerce_value(value: Any) -> Any:
    if isinstance(value, str):
        v = value.strip()
        if v == "":
            return None
        lower = v.lower()
        if lower in {"true", "false"}:
            return lower == "true"
        if lower in {"null", "none", "nan"}:
            return None
        # Keep strings with leading zeroes untouched.
        if len(v) > 1 and v[0] == "0" and v[1].isdigit():
            return v
        try:
            if "." in v:
                return float(v)
            return int(v)
        except ValueError:
            return v
    return value


def request_json(method: str, base_url: str, token: str, path: str, body: Any | None = None, params: dict[str, Any] | None = None) -> Any:
    url = f"{base_url}{path}"
    if params:
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        url = f"{url}?{query}"

    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method.upper())
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("xc-token", token)
    req.add_header("Authorization", f"Bearer {token}")

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise NocoDBError(f"{method} {url} failed: HTTP {exc.code}: {raw[:1000]}") from exc


def records_path(table_id: str, record_id: str | int | None = None) -> str:
    base = f"/api/v2/tables/{urllib.parse.quote(table_id)}/records"
    if record_id is not None:
        return f"{base}/{urllib.parse.quote(str(record_id))}"
    return base


def extract_record_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        for key in ("list", "records", "data", "items"):
            if isinstance(payload.get(key), list):
                return [r for r in payload[key] if isinstance(r, dict)]
    return []


def has_more(payload: Any, fetched_count: int, page_size: int) -> bool:
    if isinstance(payload, dict):
        page_info = payload.get("pageInfo") or payload.get("page_info") or {}
        if isinstance(page_info, dict):
            if page_info.get("isLastPage") is True:
                return False
            if page_info.get("hasNextPage") is True:
                return True
            total_rows = page_info.get("totalRows") or page_info.get("total_rows")
            offset = page_info.get("offset") or 0
            try:
                return total_rows is not None and int(offset) + fetched_count < int(total_rows)
            except Exception:
                pass
    return fetched_count >= page_size


def fetch_existing(base_url: str, token: str, table_id: str, page_size: int) -> list[dict[str, Any]]:
    all_records: list[dict[str, Any]] = []
    offset = 0
    while True:
        payload = request_json(
            "GET",
            base_url,
            token,
            records_path(table_id),
            params={"limit": page_size, "offset": offset},
        )
        records = extract_record_list(payload)
        all_records.extend(records)
        if not has_more(payload, len(records), page_size):
            break
        offset += len(records)
        if not records:
            break
    return all_records


def row_key(row: dict[str, Any], key_columns: list[str]) -> tuple[str, ...]:
    return tuple("" if row.get(col) is None else str(row.get(col)) for col in key_columns)


def detect_record_id(row: dict[str, Any], explicit: str = "") -> Any:
    if explicit:
        return row.get(explicit)
    for col in RECORD_ID_CANDIDATES:
        if col in row:
            return row[col]
    return None


def chunks(rows: list[dict[str, Any]], size: int):
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


def create_rows(base_url: str, token: str, table_id: str, rows: list[dict[str, Any]], batch_size: int, sleep: float) -> int:
    created = 0
    for batch in chunks(rows, batch_size):
        try:
            request_json("POST", base_url, token, records_path(table_id), body=batch)
            created += len(batch)
            time.sleep(sleep)
            continue
        except NocoDBError:
            # Some NocoDB builds expect one object at a time instead of an array.
            pass

        for row in batch:
            request_json("POST", base_url, token, records_path(table_id), body=row)
            created += 1
            time.sleep(sleep)
    return created


def update_rows(base_url: str, token: str, table_id: str, rows: list[dict[str, Any]], id_column: str, batch_size: int, sleep: float) -> int:
    updated = 0
    for batch in chunks(rows, batch_size):
        # Try v2 bulk patch first: array of rows with Id included.
        try:
            request_json("PATCH", base_url, token, records_path(table_id), body=batch)
            updated += len(batch)
            time.sleep(sleep)
            continue
        except NocoDBError:
            pass

        # Try wrapped bulk patch.
        try:
            request_json("PATCH", base_url, token, records_path(table_id), body={"records": batch})
            updated += len(batch)
            time.sleep(sleep)
            continue
        except NocoDBError:
            pass

        # Fallback: patch individual /records/{id}.
        for row in batch:
            record_id = detect_record_id(row, id_column)
            if record_id is None:
                raise NocoDBError(f"Cannot update row without a NocoDB record id: {row}")
            body = {k: v for k, v in row.items() if k != id_column}
            request_json("PATCH", base_url, token, records_path(table_id, record_id), body=body)
            updated += 1
            time.sleep(sleep)
    return updated


def main() -> int:
    args = parse_args()
    base_url = require(args.base_url, "NOCODB_BASE_URL")
    token = require(args.token, "NOCODB_TOKEN")
    rows = load_rows(Path(args.file))

    if not rows:
        print("No rows found in input file.")
        return 0

    print(f"Loaded {len(rows)} rows from {args.file}")

    if args.mode == "append":
        if args.dry_run:
            print(f"DRY RUN: would create {len(rows)} rows in table {args.table_id}")
            return 0
        created = create_rows(base_url, token, args.table_id, rows, args.batch_size, args.sleep)
        print(json.dumps({"ok": True, "mode": "append", "created": created}, indent=2))
        return 0

    key_columns = [c.strip() for c in args.key_columns.split(",") if c.strip()]
    if not key_columns:
        raise SystemExit("--key-columns is required for --mode upsert")

    missing_key_cols = [col for col in key_columns if any(col not in row for row in rows)]
    if missing_key_cols:
        raise SystemExit(f"Input rows are missing required key column(s): {sorted(set(missing_key_cols))}")

    print(f"Fetching existing NocoDB rows from table {args.table_id}...")
    existing = fetch_existing(base_url, token, args.table_id, args.page_size)
    existing_by_key: dict[tuple[str, ...], dict[str, Any]] = {}
    for record in existing:
        key = row_key(record, key_columns)
        if all(part != "" for part in key):
            existing_by_key[key] = record

    to_create: list[dict[str, Any]] = []
    to_update: list[dict[str, Any]] = []
    for row in rows:
        key = row_key(row, key_columns)
        match = existing_by_key.get(key)
        if not match:
            to_create.append(row)
            continue
        record_id = detect_record_id(match, args.id_column)
        if record_id is None:
            raise SystemExit(f"Could not detect NocoDB record id for existing row with key {key}. Pass --id-column.")
        merged = dict(row)
        merged[args.id_column or "Id"] = record_id
        to_update.append(merged)

    print(f"Existing records: {len(existing)}")
    print(f"Rows to create: {len(to_create)}")
    print(f"Rows to update: {len(to_update)}")

    if args.dry_run:
        print(json.dumps({
            "ok": True,
            "dryRun": True,
            "mode": "upsert",
            "existing": len(existing),
            "create": len(to_create),
            "update": len(to_update),
            "keyColumns": key_columns,
        }, indent=2))
        return 0

    created = create_rows(base_url, token, args.table_id, to_create, args.batch_size, args.sleep) if to_create else 0
    updated = update_rows(base_url, token, args.table_id, to_update, args.id_column or "Id", args.batch_size, args.sleep) if to_update else 0

    print(json.dumps({
        "ok": True,
        "mode": "upsert",
        "created": created,
        "updated": updated,
        "keyColumns": key_columns,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
