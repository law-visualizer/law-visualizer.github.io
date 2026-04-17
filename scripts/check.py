#!/usr/bin/env python3
"""
Validate that laws.json is well-formed and every ref in issues.json resolves.
Prints per-title counts so a new import is easy to sanity-check.
"""

import json
import os
import sys
from collections import Counter

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")


def main():
    with open(os.path.join(DATA_DIR, "laws-index.json")) as f:
        laws = json.load(f)
    with open(os.path.join(DATA_DIR, "issues.json")) as f:
        issues = json.load(f)

    idx = {s["id"]: (t, c, s) for t in laws["titles"] for c in t["chapters"] for s in c["sections"]}

    print("== Titles ==")
    for t in laws["titles"]:
        nchap = len(t["chapters"])
        nsec = sum(len(c["sections"]) for c in t["chapters"])
        print(f"  {t['id']}: {t['name']}  — {nchap} chapters, {nsec} sections")

    total_chapters = sum(len(t["chapters"]) for t in laws["titles"])
    total_sections = sum(len(c["sections"]) for t in laws["titles"] for c in t["chapters"])
    print(f"\nTotals: {len(laws['titles'])} titles, {total_chapters} chapters, {total_sections} sections")

    missing = [(i["id"], r) for i in issues["issues"] for r in i["refs"] if r not in idx]
    print(f"\n== Issues ==")
    print(f"  issues: {len(issues['issues'])}, refs: {sum(len(i['refs']) for i in issues['issues'])}")
    print(f"  by category: {dict(Counter(i['category'] for i in issues['issues']))}")

    if missing:
        print(f"\n!! MISSING REFS: {missing}")
        sys.exit(1)
    else:
        print(f"  all refs resolve")


if __name__ == "__main__":
    main()
