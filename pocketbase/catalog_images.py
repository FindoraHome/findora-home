import argparse
import hashlib
import json
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener, urlopen


MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_EXTENSIONS = {
    "image/webp": "webp",
    "image/avif": "avif",
    "image/png": "png",
    "image/jpeg": "jpg",
}


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, destination):
        raise ValueError("The image source attempted to redirect the download.")


def read_image(response):
    image = response.read(MAX_IMAGE_BYTES + 1)
    if not 0 < len(image) <= MAX_IMAGE_BYTES:
        raise ValueError("Image size is outside the supported range.")
    return image


def snapshot(database, directory, project_ref, backup=None):
    if not re.fullmatch(r"[a-z0-9]{20}", project_ref):
        raise ValueError("Expected the source Supabase project reference.")
    host = f"{project_ref}.supabase.co"
    prefix = "/storage/v1/object/public/product-images/"
    products = database.execute(
        "SELECT legacy_id, image_url FROM products WHERE image_url <> '' ORDER BY legacy_id"
    ).fetchall()

    if backup is not None:
        inventory = json.loads((backup / "source-inventory.json").read_text(encoding="utf-8"))
        manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
        source_objects = {row["name"]: row for row in inventory["objects"]
                          if row["bucket_id"] == "product-images"}
        saved_images = {row["name"]: row for row in manifest["objects"]
                        if row["bucket"] == "product-images"}

    def prepare_image(product):
        legacy_id, source_url = product
        source = urlsplit(source_url)
        object_path = unquote(source.path)
        if (source.scheme != "https" or source.netloc != host or not object_path.startswith(prefix)
                or "\\" in object_path or any(part in (".", "..") for part in object_path.split("/"))):
            raise ValueError(f"Product {legacy_id} has an unexpected image source.")

        if backup is None:
            with build_opener(NoRedirects()).open(source_url, timeout=15) as response:
                content_type = response.headers.get_content_type()
                image = read_image(response)
        else:
            object_name = object_path.removeprefix(prefix)
            if object_name not in source_objects or object_name not in saved_images:
                raise ValueError(f"Product {legacy_id} is missing from the verified backup.")
            entry = saved_images[object_name]
            content_type = source_objects[object_name]["metadata"]["mimetype"]
            with (backup / "objects" / "product-images" / object_name).open("rb") as source_file:
                image = read_image(source_file)
            if len(image) != entry["bytes"] or hashlib.sha256(image).hexdigest() != entry["sha256"]:
                raise ValueError(f"Backup checksum does not match product {legacy_id}.")

        extension = IMAGE_EXTENSIONS.get(content_type)
        if extension is None:
            raise ValueError(f"Product {legacy_id} has an unsupported image type.")

        filename = f"{legacy_id}.{extension}"
        (directory / filename).write_bytes(image)
        return {
            "legacy_id": legacy_id,
            "source_url": source_url,
            "filename": filename,
            "sha256": hashlib.sha256(image).hexdigest(),
            "bytes": len(image),
        }

    with ThreadPoolExecutor(max_workers=8) as pool:
        entries = list(pool.map(prepare_image, products))
    (directory / "images.json").write_text(json.dumps(entries), encoding="utf-8")
    print(f"Prepared {len(entries)} images ({sum(entry['bytes'] for entry in entries):,} bytes).")


def verify(database, directory):
    entries = json.loads((directory / "images.json").read_text(encoding="utf-8"))
    products = {
        legacy_id: (record_id, filename, checksum)
        for legacy_id, record_id, filename, checksum in database.execute(
            "SELECT legacy_id, id, image, image_import_sha256 FROM products WHERE image_url <> ''"
        )
    }
    if len(entries) != len(products):
        raise ValueError("The image snapshot and catalog have different record counts.")

    def verify_file(entry):
        record_id, filename, checksum = products[entry["legacy_id"]]
        if not filename or checksum != entry["sha256"]:
            raise ValueError(f"Image metadata does not match product {entry['legacy_id']}.")
        url = f"http://127.0.0.1:8090/api/files/products/{record_id}/{quote(filename, safe='')}"
        with urlopen(url, timeout=10) as response:
            uploaded = read_image(response)
        if hashlib.sha256(uploaded).hexdigest() != checksum:
            raise ValueError(f"Image file does not match the source for product {entry['legacy_id']}.")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(verify_file, entries))
    print(f"Verified the bytes of all {len(entries)} images through the PocketBase file API.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Copy and verify staged Findora catalog images.")
    parser.add_argument("action", choices=("snapshot", "verify"))
    parser.add_argument("database", type=Path)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--project-ref", default="")
    parser.add_argument("--backup", type=Path, help="use the verified Storage backup instead of the network")
    args = parser.parse_args()

    with sqlite3.connect(f"{args.database.resolve().as_uri()}?mode=ro", uri=True) as database:
        if args.action == "snapshot":
            snapshot(database, args.directory, args.project_ref, args.backup)
        else:
            verify(database, args.directory)
