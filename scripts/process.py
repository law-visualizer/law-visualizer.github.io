#!/usr/bin/env python3
"""
Walk scraped HTML in data/ and produce data/laws.json with nested structure:

{
  "titles": [
    {
      "id": "LXII",
      "name": "CRIMINAL CODE",
      "chapters": [
        {
          "id": "625",
          "name": "PRELIMINARY",
          "sections": [
            {
              "id": "625:1",
              "heading": "Name",
              "text": "This title shall be known as the Criminal Code.",
              "source": "1971, 518:1, eff. Nov. 1, 1973.",
              "url": "https://gc.nh.gov/rsa/html/LXII/625/625-1.htm"
            }
          ]
        }
      ]
    }
  ]
}
"""

import json
import os
import re
from bs4 import BeautifulSoup

BASE_URL = "https://gc.nh.gov/rsa/html"
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")


def discover_titles():
    """Return sorted list of title ids present as directories in data/."""
    if not os.path.isdir(DATA_DIR):
        return []
    return sorted(
        name for name in os.listdir(DATA_DIR)
        if os.path.isdir(os.path.join(DATA_DIR, name))
        and os.path.exists(os.path.join(DATA_DIR, name, "toc.html"))
    )


def clean_text(s):
    if s is None:
        return ""
    s = s.replace("\u2013", "-").replace("\u2014", "-").replace("\u0096", "-")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def title_name_from_toc(toc_html):
    soup = BeautifulSoup(toc_html, "html.parser")
    for h in soup.find_all("h2"):
        t = clean_text(h.get_text())
        # e.g. "LXII: CRIMINAL CODE"
        m = re.match(r"[A-Z\-]+:\s*(.+)", t)
        if m:
            return m.group(1).strip()
    return ""


def chapter_name_from_toc(toc_html):
    soup = BeautifulSoup(toc_html, "html.parser")
    for h in soup.find_all("h2"):
        t = clean_text(h.get_text())
        # e.g. "CHAPTER 625: PRELIMINARY"
        m = re.match(r"CHAPTER\s+[\w\-]+:\s*(.+)", t, re.I)
        if m:
            return m.group(1).strip()
    return ""


def parse_section(html, title, chapter, filename):
    soup = BeautifulSoup(html, "html.parser")

    # Section id + heading from the bold tag: "625:1 Name. --"
    heading = ""
    section_id = ""
    b = soup.find("b")
    if b:
        raw = clean_text(b.get_text())
        # Strip trailing dash artifacts
        raw = re.sub(r"[-\s]+$", "", raw)
        m = re.match(r"([\w\-]+:[\w\-]+(?:-[\w]+)?)\s+(.+?)\.?$", raw)
        if m:
            section_id = m.group(1)
            heading = m.group(2).strip().rstrip(".")
        else:
            heading = raw

    codesect = soup.find("codesect")
    text = clean_text(codesect.get_text()) if codesect else ""

    sourcenote = soup.find("sourcenote")
    source = ""
    if sourcenote:
        s = clean_text(sourcenote.get_text())
        source = re.sub(r"^Source\.\s*", "", s)

    # Fallback: derive id from filename, e.g. "625-1.htm" -> "625:1"
    if not section_id:
        stem = filename.replace(".htm", "")
        section_id = stem.replace("-", ":", 1)

    url = f"{BASE_URL}/{title}/{chapter}/{filename}"

    return {
        "id": section_id,
        "heading": heading,
        "text": text,
        "source": source,
        "url": url,
    }


def section_sort_key(sec_id):
    # "625:1" -> (625, 1), "632-A:5" -> (632, 'A', 5) — normalize to tuple
    parts = re.split(r"[:\-]", sec_id)
    key = []
    for p in parts:
        key.append((0, int(p)) if p.isdigit() else (1, p))
    return key


def process_title(title):
    title_dir = os.path.join(DATA_DIR, title)
    if not os.path.isdir(title_dir):
        return None

    toc_path = os.path.join(title_dir, "toc.html")
    title_name = ""
    if os.path.exists(toc_path):
        with open(toc_path, encoding="utf-8") as f:
            title_name = title_name_from_toc(f.read())

    chapters = []
    for chap in sorted(os.listdir(title_dir)):
        chap_dir = os.path.join(title_dir, chap)
        if not os.path.isdir(chap_dir):
            continue

        chap_toc = os.path.join(chap_dir, "toc.html")
        chap_name = ""
        if os.path.exists(chap_toc):
            with open(chap_toc, encoding="utf-8") as f:
                chap_name = chapter_name_from_toc(f.read())

        sections = []
        for fname in os.listdir(chap_dir):
            if fname == "toc.html" or not fname.endswith(".htm"):
                continue
            fpath = os.path.join(chap_dir, fname)
            with open(fpath, encoding="utf-8") as f:
                sec = parse_section(f.read(), title, chap, fname)
            sections.append(sec)

        sections.sort(key=lambda s: section_sort_key(s["id"]))
        chapters.append({"id": chap, "name": chap_name, "sections": sections})

    chapters.sort(key=lambda c: section_sort_key(c["id"]))
    return {"id": title, "name": title_name, "chapters": chapters}


def roman_key(r):
    """Sort key for roman-numeral title ids (e.g. 'LVIII', 'LXI', 'LXI-A')."""
    romans = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    base, suffix = (r.split("-", 1) + [""])[:2]
    total = 0
    prev = 0
    for ch in reversed(base):
        v = romans.get(ch, 0)
        total += v if v >= prev else -v
        prev = v
    return (total, suffix)


def main():
    title_ids = discover_titles()
    titles_full = []
    for t in sorted(title_ids, key=roman_key):
        td = process_title(t)
        if td:
            titles_full.append(td)

    # Write index (lightweight: no text/source) — drives the viz
    index = {
        "titles": [
            {
                "id": t["id"],
                "name": t["name"],
                "chapters": [
                    {
                        "id": c["id"],
                        "name": c["name"],
                        "sections": [
                            {"id": s["id"], "heading": s["heading"], "url": s["url"]}
                            for s in c["sections"]
                        ],
                    }
                    for c in t["chapters"]
                ],
            }
            for t in titles_full
        ]
    }
    index_path = os.path.join(DATA_DIR, "laws-index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    # Write per-title full-text shards
    shard_dir = os.path.join(DATA_DIR, "laws-text")
    os.makedirs(shard_dir, exist_ok=True)
    for t in titles_full:
        shard_path = os.path.join(shard_dir, f"{t['id']}.json")
        with open(shard_path, "w", encoding="utf-8") as f:
            json.dump(t, f, ensure_ascii=False, separators=(",", ":"))

    # Remove legacy monolithic file if present
    legacy = os.path.join(DATA_DIR, "laws.json")
    if os.path.exists(legacy):
        os.remove(legacy)

    total_sections = sum(len(c["sections"]) for t in titles_full for c in t["chapters"])
    total_chapters = sum(len(t["chapters"]) for t in titles_full)
    index_size = os.path.getsize(index_path)
    print(f"Wrote {index_path} ({index_size/1024:.1f} KB)")
    print(f"Wrote {len(titles_full)} shards in {shard_dir}/")
    print(f"  titles: {len(titles_full)}, chapters: {total_chapters}, sections: {total_sections}")


if __name__ == "__main__":
    main()
