#!/usr/bin/env python3
"""
Scan every section's text + source + heading for inline RSA references and
produce data/rsa-links.json:

  {
    "outbound": { "<id>": ["<other_id>", ...] },
    "inbound":  { "<id>": ["<other_id>", ...] }
  }

Outbound edges are pre-deduped per source. Inbound is just the reversed
adjacency. References that don't resolve to a known section id are dropped.
A reference like 'RSA 632-A' (chapter only) is expanded to every section
in that chapter so users can navigate from a chapter-citing section to any
of its sections.
"""

import json
import os
import re

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
SHARDS = os.path.join(DATA_DIR, "laws-text")

# Matches "RSA 625:11", "RSA 632-A:5", "RSA 632-A:5-a", "RSA 21" (chapter only).
# Keeps the chapter and optional :section.
RSA_RE = re.compile(
    r"\bRSA\s+(\d+(?:-[A-Z])?)(?::([\w\-]+))?",
    re.I,
)


def load_corpus():
    titles = []
    for fn in sorted(os.listdir(SHARDS)):
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(SHARDS, fn)) as f:
            titles.append(json.load(f))
    return titles


def build_indexes(titles):
    """Return (section_ids, sections_by_chapter)."""
    section_ids = set()
    by_chapter = {}
    for t in titles:
        for c in t["chapters"]:
            sids = [s["id"] for s in c["sections"]]
            by_chapter[c["id"]] = sids
            section_ids.update(sids)
    return section_ids, by_chapter


def extract_refs(text, section_ids, by_chapter):
    refs = set()
    for m in RSA_RE.finditer(text or ""):
        chap, sec = m.group(1), m.group(2)
        if sec:
            full = f"{chap}:{sec}"
            if full in section_ids:
                refs.add(full)
        else:
            # Chapter-only reference: pull every section of that chapter
            for sid in by_chapter.get(chap, []):
                refs.add(sid)
    return refs


def main():
    titles = load_corpus()
    section_ids, by_chapter = build_indexes(titles)

    outbound = {}
    for t in titles:
        for c in t["chapters"]:
            for s in c["sections"]:
                blob = " ".join(filter(None, [s.get("text"), s.get("source"), s.get("heading")]))
                refs = extract_refs(blob, section_ids, by_chapter)
                refs.discard(s["id"])  # drop self-references
                if refs:
                    outbound[s["id"]] = sorted(refs)

    inbound = {}
    for src, dsts in outbound.items():
        for d in dsts:
            inbound.setdefault(d, []).append(src)
    for d in inbound:
        inbound[d].sort()

    out_path = os.path.join(DATA_DIR, "rsa-links.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"outbound": outbound, "inbound": inbound}, f, separators=(",", ":"))

    n_edges = sum(len(v) for v in outbound.values())
    print(f"Wrote {out_path}")
    print(f"  sections with outbound refs: {len(outbound)}")
    print(f"  sections with inbound refs:  {len(inbound)}")
    print(f"  total edges: {n_edges}")


if __name__ == "__main__":
    main()
