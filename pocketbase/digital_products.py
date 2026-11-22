import argparse
import hashlib
import json
import re
import shutil
import sqlite3
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import urlopen


POCKETBASE = "http://127.0.0.1:8090"


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(work_dir, archive):
    source = json.loads((work_dir / "source.json").read_text(encoding="utf-8"))
    products = source["products"]
    if not products or not re.fullmatch(r"[a-z0-9]{20}", source["project_ref"]):
        raise ValueError("Missing digital products or unexpected source project reference.")
    host = f"{source['project_ref']}.supabase.co"
    inventory = {(row["bucket"], row["name"]): row for row in source["storage_manifest"]["objects"]}

    def stage_file(bucket, key, output_name, allowed_extensions):
        if key != Path(key).name or "/" in key or "\\" in key or key in ("", ".", ".."):
            raise ValueError("Unexpected Storage object name.")
        suffix = Path(key).suffix.lower()
        if suffix not in allowed_extensions:
            raise ValueError("Unexpected Storage object extension.")
        expected = inventory[bucket, key]
        original = archive / "objects" / bucket / key
        if original.stat().st_size != expected["bytes"] or sha256(original) != expected["sha256"]:
            raise ValueError(f"Archived {bucket} object does not match the verified Supabase backup.")
        output = work_dir / f"{output_name}{suffix}"
        shutil.copyfile(original, output)
        return {"filename": output.name, "sha256": expected["sha256"]}

    for product in products:
        legacy_id = product["legacy_id"]
        if not re.fullmatch(r"[0-9]+", legacy_id):
            raise ValueError("Invalid source product ID.")
        image_url = urlsplit(product.pop("image_url"))
        prefix = "/storage/v1/object/public/product-images/"
        if image_url.scheme != "https" or image_url.netloc != host or not image_url.path.startswith(prefix):
            raise ValueError(f"Unexpected cover image source for product {legacy_id}.")
        product["image"] = stage_file("product-images", unquote(image_url.path[len(prefix):]),
                                      f"{legacy_id}-cover", {".webp", ".avif", ".png", ".jpeg", ".jpg"})
        product["document"] = stage_file("product-files", product.pop("source_file"),
                                         f"{legacy_id}-download", {".pdf"})

    (work_dir / "products.json").write_text(json.dumps(products, ensure_ascii=False), encoding="utf-8")
    print(f"Prepared verified covers and PDFs for {len(products)} products.")


def verify(work_dir, data_dir):
    expected = {row["legacy_id"]: row for row in json.loads((work_dir / "products.json").read_text(encoding="utf-8"))}
    with urlopen(f"{POCKETBASE}/api/collections/own_products/records?perPage=200", timeout=10) as response:
        public_products = json.load(response)
    if set(row["legacy_id"] for row in public_products["items"]) != {key for key, row in expected.items() if row["active"]}:
        raise ValueError("Visible digital products do not match the source.")

    for row in public_products["items"]:
        source = expected[row["legacy_id"]]
        if row["price_cents"] != source["price_cents"] or row["name"] != source["name"]:
            raise ValueError("A digital product price or name does not match the source.")
        if {"document", "download_name", "import_sha256"}.intersection(row):
            raise ValueError("A public product response contained private download fields.")
        filename = quote(row["image"], safe="")
        with urlopen(f"{POCKETBASE}/api/files/own_products/{row['id']}/{filename}", timeout=10) as response:
            if hashlib.file_digest(response, "sha256").hexdigest() != source["image"]["sha256"]:
                raise ValueError("A staged cover does not match the backup.")

    database_url = f"{(data_dir / 'data.db').resolve().as_uri()}?mode=ro"
    with sqlite3.connect(database_url, uri=True) as database:
        collection_id, = database.execute("SELECT id FROM _collections WHERE name = 'own_product_downloads'").fetchone()
        staged_files = database.execute(
            "SELECT p.legacy_id, d.id, d.document, d.download_name FROM own_product_downloads d "
            "JOIN own_products p ON p.id = d.product"
        ).fetchall()
    if {row[0] for row in staged_files} != expected.keys():
        raise ValueError("Private download records do not match the source products.")

    for legacy_id, record_id, filename, name in staged_files:
        source = expected[legacy_id]
        if name != source["download_name"] or sha256(data_dir / "storage" / collection_id / record_id / filename) != source["document"]["sha256"]:
            raise ValueError("A protected PDF does not match the backup.")
        url = f"{POCKETBASE}/api/files/{collection_id}/{record_id}/{quote(filename, safe='')}"
        try:
            with urlopen(url, timeout=10):
                raise ValueError("A private PDF was accessible without authorization.")
        except HTTPError as error:
            if error.code not in (403, 404):
                raise

    try:
        with urlopen(f"{POCKETBASE}/api/collections/own_product_downloads/records", timeout=10):
            raise ValueError("The private download collection accepted an anonymous request.")
    except HTTPError as error:
        if error.code != 403:
            raise

    print(f"Verified {len(staged_files)} digital products and PDFs. Anonymous PDF access and listing are blocked.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare and verify Findora's staged digital products.")
    parser.add_argument("action", choices=("prepare", "verify"))
    parser.add_argument("work_dir", type=Path)
    parser.add_argument("source_dir", type=Path)
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.work_dir, args.source_dir)
    else:
        verify(args.work_dir, args.source_dir)
