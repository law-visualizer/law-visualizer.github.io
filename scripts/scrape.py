#!/usr/bin/env python3
"""
Scrape NH Revised Statutes HTML for the specified titles.

Structure:
  NHTOC/NHTOC-{TITLE}.htm         -> links to NHTOC-{TITLE}-{CHAPTER}.htm (chapter sub-TOCs)
  NHTOC/NHTOC-{TITLE}-{CHAPTER}.htm -> links to ../{TITLE}/{chapter}/{chapter}-{section}.htm
  {TITLE}/{chapter}/{chapter}-{section}.htm -> section page with the law text

Saves raw HTML to data/{TITLE}/... preserving the site's relative layout.
"""

import argparse
import os
import re
import sys
import time
import requests
from bs4 import BeautifulSoup

BASE = "https://gc.nh.gov/rsa/html"
DEFAULT_TITLES = ["LVIII", "LIX", "LX", "LXII"]

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(DATA_DIR, exist_ok=True)

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; NH-LawViz/1.0)"}


def fetch(url):
    for attempt in range(3):
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            r.raise_for_status()
            return r.text
        except requests.RequestException as e:
            print(f"  retry {attempt+1} for {url}: {e}")
            time.sleep(1 + attempt)
    return None


def save(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def scrape_title(title):
    print(f"\n=== Title {title} ===")
    title_dir = os.path.join(DATA_DIR, title)

    toc_url = f"{BASE}/NHTOC/NHTOC-{title}.htm"
    toc_html = fetch(toc_url)
    if not toc_html:
        print(f"Failed to fetch TOC for {title}")
        return
    save(os.path.join(title_dir, "toc.html"), toc_html)

    soup = BeautifulSoup(toc_html, "html.parser")
    chapter_toc_links = [
        a["href"] for a in soup.find_all("a", href=True)
        if re.fullmatch(rf"NHTOC-{re.escape(title)}-[\w\-]+\.htm", a["href"])
    ]
    print(f"  chapters: {len(chapter_toc_links)}")

    for chap_toc_href in chapter_toc_links:
        chap_toc_url = f"{BASE}/NHTOC/{chap_toc_href}"
        chap_toc_html = fetch(chap_toc_url)
        if not chap_toc_html:
            continue

        # Chapter id e.g. "625" or "632-A"
        m = re.match(rf"NHTOC-{re.escape(title)}-([\w\-]+)\.htm", chap_toc_href)
        chapter = m.group(1)
        save(os.path.join(title_dir, chapter, "toc.html"), chap_toc_html)

        chap_soup = BeautifulSoup(chap_toc_html, "html.parser")
        section_links = []
        for a in chap_soup.find_all("a", href=True):
            href = a["href"]
            # look for ../{title}/{chapter}/{file}.htm
            if href.startswith("../") and href.endswith(".htm") and f"/{title}/" in href:
                section_links.append(href)

        print(f"  {chapter}: {len(section_links)} sections")

        for sec_href in section_links:
            # normalize to absolute URL
            sec_url = f"{BASE}/{sec_href.lstrip('./')}" if sec_href.startswith("../") else f"{BASE}/{sec_href}"
            # derive local filename from trailing part
            fname = sec_href.split("/")[-1]
            out_path = os.path.join(title_dir, chapter, fname)
            if os.path.exists(out_path):
                continue  # skip already-downloaded
            sec_html = fetch(sec_url)
            if sec_html:
                save(out_path, sec_html)
            time.sleep(0.25)  # be polite


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("titles", nargs="*", help="Title roman numerals (e.g. LXI LXIII). Defaults to the original 4.")
    args = ap.parse_args()
    titles = args.titles or DEFAULT_TITLES
    for t in titles:
        scrape_title(t)
    print("\nScraping complete.")
