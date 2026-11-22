"""Export only the website features moving to PocketBase from pg_restore output."""

import hashlib
import json
import sys

from polls_snapshot import read_tables, utc


EVENT_TABLES = {
    "page_views": ("visit", "visited_at"), "product_clicks": ("click", "clicked_at"),
    "product_likes": ("like", "liked_at"), "search_queries": ("search", "searched_at"),
}
TABLES = set(EVENT_TABLES) | {"contact_messages", "site_settings", "stats_reset_log", "product_clicks_reset_log", "amazon_order_imports"}


def snapshot(tables):
    events = []
    for table, (kind, timestamp) in EVENT_TABLES.items():
        for row in tables[table]:
            token = row.get("visitor_token")
            events.append({
                "kind": kind, "source_id": row["id"], "product": row.get("product_id") or "",
                "visitor": hashlib.sha256(token.encode()).hexdigest() if token else "",
                "term": row.get("search_term", ""), "occurred_at": utc(row[timestamp]),
            })
    settings = [{"key": row["key"], "value": json.loads(row["value"])} for row in tables["site_settings"]
                if row["key"] in ("contact_enabled", "vacation_mode")]
    for table in ("stats_reset_log", "product_clicks_reset_log"):
        settings.extend({"key": table, "value": utc(row["reset_at"])} for row in tables[table] if row["reset_at"])
    contacts = [{"source_id": row["id"], "created_at": utc(row["created_at"]), "name": row["name"] or "",
                 "email": row["email"] or "", "topic": row["topic"], "message": row["message"],
                 "is_read": row["is_read"] == "t"} for row in tables["contact_messages"]]
    reports = []
    for row in tables["amazon_order_imports"]:
        entry = {key: row[key] for key in ("fingerprint", "report_date", "product_title", "asin", "source_file")}
        entry.update(ordered_count=int(row["ordered_count"]), earnings=float(row["earnings"]) if row["earnings"] else None)
        reports.append({"fingerprint": row["fingerprint"], "entry": entry, "imported_at": utc(row["imported_at"])})
    return {
        "staging_site_events": events, "staging_site_settings": settings,
        "staging_contact_messages": contacts, "staging_amazon_reports": reports,
    }


if __name__ == "__main__":
    json.dump(snapshot(read_tables(sys.stdin, TABLES)), sys.stdout)
