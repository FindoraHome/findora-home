"""Read the three poll tables from pg_restore and export aggregate results."""

import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone


TABLES = {"polls", "poll_options", "poll_votes"}
COPY = re.compile(r"COPY public\.(\w+) \(([^)]+)\) FROM stdin;")
ESCAPE = re.compile(r"\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)")
CHARACTERS = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v"}


def copy_value(value):
    def unescape(match):
        code = match[1]
        if code.startswith("x") and len(code) > 1:
            return chr(int(code[1:], 16))
        if code[0] in "01234567":
            return chr(int(code, 8))
        return CHARACTERS.get(code, code)

    return None if value == r"\N" else ESCAPE.sub(unescape, value)


def read_tables(lines, expected=TABLES):
    tables = {}
    table = None
    for line in lines:
        line = line.rstrip("\r\n")
        if table is not None:
            if line == r"\.":
                table = None
            else:
                tables[table].append(dict(zip(columns, map(copy_value, line.split("\t")), strict=True)))
            continue
        match = COPY.fullmatch(line)
        if match and match[1] in expected:
            table = match[1]
            columns = match[2].split(", ")
            tables[table] = []
    if table is not None or set(tables) != expected:
        raise ValueError("The archive did not supply all requested tables.")
    return tables


def utc(value):
    return datetime.fromisoformat(value).astimezone(timezone.utc).isoformat(timespec="milliseconds")


def aggregate(tables):
    participants = defaultdict(set)
    votes = Counter()
    for row in tables["poll_votes"]:
        participants[row["poll_id"]].add(row["visitor_token"])
        votes[row["option_id"]] += 1
    options = defaultdict(list)
    for row in sorted(tables["poll_options"], key=lambda item: (int(item["sort_order"]), int(item["id"]))):
        choices = options[row["poll_id"]]
        choices.append({"id": len(choices) + 1, "label": row["label"], "votes": votes[row["id"]]})
    return [
        {
            "legacy_id": row["id"], "question": row["question"], "active": row["active"] == "t",
            "created_at": utc(row["created_at"]), "ends_at": utc(row["ends_at"]),
            "participant_goal": int(row.get("participant_goal") or 0), "options": options[row["id"]],
            "imported_participants": len(participants[row["id"]]),
        }
        for row in tables["polls"]
    ]


if __name__ == "__main__":
    json.dump(aggregate(read_tables(sys.stdin)), sys.stdout)
