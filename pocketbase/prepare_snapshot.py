"""Prepare a private PocketBase snapshot from a verified Supabase backup."""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tomllib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit


EVENTS = {"page_views": ("visit", "visited_at"), "product_clicks": ("click", "clicked_at"),
          "product_likes": ("like", "liked_at"), "search_queries": ("search", "searched_at")}
TABLES = {*EVENTS, "users", "admin_users", "categories", "partners", "products", "own_products", "polls", "poll_options",
          "poll_votes", "contact_messages", "site_settings", "stats_reset_log", "product_clicks_reset_log", "amazon_order_imports"}
COPY = re.compile(r"COPY (?:public|auth)\.(\w+) \(([^)]+)\) FROM stdin;")
ESCAPE = re.compile(rb"\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)")
ESCAPED = {b"b": b"\b", b"f": b"\f", b"n": b"\n", b"r": b"\r", b"t": b"\t", b"v": b"\v"}
IMAGES = {"image/webp": "webp", "image/avif": "avif", "image/png": "png", "image/jpeg": "jpg"}


def copy_value(value):
    def unescape(match):
        code = match[1]
        if code.startswith(b"x") and len(code) > 1:
            return bytes([int(code[1:], 16)])
        if code[:1] in b"01234567":
            return bytes([int(code, 8)])
        return ESCAPED.get(code, code)

    return None if value == r"\N" else ESCAPE.sub(unescape, value.encode()).decode()


def read_tables(lines):
    tables = {}
    table = None
    for line in lines:
        line = line.rstrip("\r\n")
        if table:
            if line == r"\.":
                table = None
            else:
                tables[table].append(dict(zip(columns, map(copy_value, line.split("\t")), strict=True)))
        elif (match := COPY.fullmatch(line)) and match[1] in TABLES:
            table = match[1]
            canonical_schema = "auth" if table == "users" else "public"
            if not line.startswith(f"COPY {canonical_schema}.") or table in tables:
                raise ValueError(f"Unexpected duplicate or schema for table {table}.")
            columns = match[2].split(", ")
            tables[table] = []
    if table or tables.keys() != TABLES:
        raise ValueError("The archive did not supply all complete migration tables.")
    return tables


def timestamp(value):
    return datetime.fromisoformat(value).astimezone(timezone.utc).isoformat(timespec="milliseconds")


def select(row, *fields):
    return {name: row[name] for name in fields}


def catalog_row(row, *fields):
    if not re.fullmatch(r"[0-9]+", row["id"]):
        raise ValueError("Invalid source catalog ID.")
    return {"legacy_id": row["id"], "created_at": timestamp(row["created_at"]), "active": row["active"] == "t",
            **select(row, *fields)}


def catalog(tables, backup, target):
    project = tomllib.loads((backup / "project/repository-config.toml").read_text(encoding="utf-8"))["project_id"]
    if not re.fullmatch(r"[a-z0-9]{20}", project):
        raise ValueError("The backup's Supabase project reference is invalid.")
    storage = backup / "storage"
    files = {(row["bucket"], row["name"]): row for row in json.loads((storage / "manifest.json").read_text(encoding="utf-8"))["objects"]}
    objects = {(row["bucket_id"], row["name"]): row for row in
               json.loads((storage / "source-inventory.json").read_text(encoding="utf-8"))["objects"]}
    assets = target / "assets"
    assets.mkdir(mode=0o700)

    def copy_asset(bucket, key, name):
        object_path = PurePosixPath(key)
        if not key or object_path.is_absolute() or ".." in object_path.parts or "\\" in key or str(object_path) != key:
            raise ValueError("Invalid path in Supabase Storage backup.")
        source_root = (storage / "objects" / bucket).resolve(strict=True)
        source = (source_root / key).resolve(strict=True)
        if not source.is_relative_to(source_root):
            raise ValueError("A Storage object points outside the backup.")
        expected = files[bucket, key]
        mime = objects[bucket, key]["metadata"]["mimetype"]
        limit = (10 if bucket == "product-images" else 50) * 1024 * 1024
        extension = IMAGES.get(mime) if bucket == "product-images" else "pdf" if mime == "application/pdf" else None
        if not extension or not 0 < source.stat().st_size == expected["bytes"] <= limit:
            raise ValueError(f"Unsupported backup asset for {name}.")
        with source.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        if checksum != expected["sha256"]:
            raise ValueError(f"Backup asset checksum mismatch for {name}.")
        filename = f"{name}.{extension}"
        shutil.copyfile(source, assets / filename)
        return {"filename": filename, "sha256": checksum}

    def image(row, suffix):
        value = row["image_url"]
        if not value:
            return None
        url = urlsplit(value)
        prefix = "/storage/v1/object/public/product-images/"
        path = unquote(url.path)
        if url.scheme != "https" or url.netloc != f"{project}.supabase.co" or not path.startswith(prefix):
            raise ValueError(f"Unexpected image source for product {row['id']}.")
        return copy_asset("product-images", path[len(prefix):], f"{row['id']}-{suffix}")

    products = []
    for row in tables["products"]:
        product = catalog_row(row, "name", "description", "link", "category", "partner", "image_url")
        products.append({**product, "featured": row["featured"] == "t", "is_disney": row["is_disney"] == "t",
                         "image": image(row, "product"), "source": select(row, "normal_link", "keywords")})
    digital = []
    for row in tables["own_products"]:
        product = catalog_row(row, "name", "description", "purchase_url")
        price = Decimal(row["price"]) * 100 if row["price"] is not None else None
        if price is not None and (price < 0 or price != price.to_integral_value()):
            raise ValueError("Invalid digital product price.")
        digital.append({**product, "price_cents": None if price is None else int(price), "image": image(row, "cover"),
                        "download": {**copy_asset("product-files", row["file_path"], f"{row['id']}-download"),
                                     "name": row["file_name"]}})
    return {"products": products, "own_products": digital, **{
        name: [{**catalog_row(row, "name"), "sort_order": int(row["sort_order"] or 0)} for row in tables[name]]
        for name in ("categories", "partners")}}


def polls(tables):
    participants = defaultdict(set)
    votes = Counter()
    for row in tables["poll_votes"]:
        participants[row["poll_id"]].add(row["visitor_token"])
        votes[row["option_id"]] += 1
    options = defaultdict(list)
    for row in sorted(tables["poll_options"], key=lambda item: (int(item["sort_order"]), int(item["id"]))):
        choices = options[row["poll_id"]]
        choices.append({"id": len(choices) + 1, "label": row["label"], "votes": votes[row["id"]]})
    return [{**catalog_row(row, "question"), "ends_at": timestamp(row["ends_at"]),
             "participant_goal": int(row.get("participant_goal") or 0), "options": options[row["id"]],
             "imported_participants": len(participants[row["id"]])} for row in tables["polls"]]


def site_data(tables):
    settings = [{"key": row["key"], "value": json.loads(row["value"])} for row in tables["site_settings"]
                if row["key"] in ("contact_enabled", "vacation_mode")]
    for table in ("stats_reset_log", "product_clicks_reset_log"):
        settings.extend({"key": table, "value": timestamp(row["reset_at"])} for row in tables[table] if row["reset_at"])
    events = [{"kind": kind, "source_id": row["id"], "product": row.get("product_id") or "",
               "visitor": hashlib.sha256(row["visitor_token"].encode()).hexdigest() if row.get("visitor_token") else "",
               "term": row.get("search_term") or "", "occurred_at": timestamp(row[date])}
              for table, (kind, date) in EVENTS.items() for row in tables[table]]
    contacts = [{**select(row, "name", "email", "topic", "message"), "source_id": row["id"],
                 "created_at": timestamp(row["created_at"]), "is_read": row["is_read"] == "t"} for row in tables["contact_messages"]]
    reports = [{"fingerprint": row["fingerprint"], "imported_at": timestamp(row["imported_at"]), "entry": {
        **select(row, "fingerprint", "report_date", "product_title", "asin", "source_file"),
        "ordered_count": int(row["ordered_count"]), "earnings": float(row["earnings"]) if row["earnings"] else None,
    }} for row in tables["amazon_order_imports"]]
    return {"staging_site_settings": settings, "staging_site_events": events, "staging_contact_messages": contacts,
            "staging_amazon_reports": reports}


def prepare(tables, backup, target):
    admin_ids = {row["user_id"] for row in tables["admin_users"]}
    admins = [{"email": row["email"], "hash": row["encrypted_password"]} for row in tables["users"]
              if row["id"] in admin_ids and row["email_confirmed_at"] and not row["deleted_at"] and not row["banned_until"]]
    if not admins:
        raise ValueError("The backup does not contain an active, verified admin.")
    target.mkdir(mode=0o700)
    rows = {**catalog(tables, backup, target), **site_data(tables), "staging_polls": polls(tables), "findora_admins": admins}
    with (target / "snapshot.json").open("x", encoding="utf-8") as output:
        json.dump(rows, output, ensure_ascii=False)
    print(json.dumps({table: len(records) for table, records in rows.items()}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup", type=Path)
    parser.add_argument("target", type=Path, help="new, private directory for the snapshot and assets")
    args = parser.parse_args()
    command = ["pg_restore", "--data-only", "--schema=public", "--schema=auth", "--file=-",
               *(f"--table={table}" for table in sorted(TABLES)), str(args.backup / "database/findora.dump")]
    with subprocess.Popen(command, stdout=subprocess.PIPE, text=True, encoding="utf-8") as archive:
        tables = read_tables(archive.stdout)
        if archive.wait():
            raise SystemExit("pg_restore could not read the backup.")
    prepare(tables, args.backup, args.target)
