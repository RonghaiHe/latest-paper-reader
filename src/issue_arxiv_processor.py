#!/usr/bin/env python
"""
Lightweight script to add a single arXiv paper to the 速读区.

Usage:
    python src/issue_arxiv_processor.py --arxiv-id 2401.12345

Steps:
    1. Fetch paper metadata from arXiv API
    2. Generate paper page in docs/<YYYYMM>/<DD>/
    3. Update daily README.md
    4. Update docs/_sidebar.md
    5. Update docs/papers/index.json + dirs.json
"""

import argparse
import html
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple
from urllib.parse import quote_plus

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))

TODAY_STR = datetime.now(timezone.utc).strftime("%Y%m%d")
RANGE_DATE_RE = re.compile(r"^(\d{8})-(\d{8})$")


# ── Helpers (mirroring 6.generate_docs.py) ──────────────────────────


def slugify(title: str) -> str:
    s = (title or "").strip().lower()
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"[^a-z0-9\-]+", "", s)
    return s or "paper"


def format_date_str(date_str: str) -> str:
    s = str(date_str or "").strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return date_str


def build_docsify_id_href(path_no_ext: str) -> str:
    p = str(path_no_ext or "").strip().replace("\\", "/").strip()
    p = re.sub(r"\.md$", "", p, flags=re.IGNORECASE)
    if not p:
        return "/"
    return f"/{p.lstrip('/')}"


def normalize_arxiv_id(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    if raw.startswith("http://") or raw.startswith("https://"):
        raw = raw.rsplit("/", 1)[-1]
    raw = raw.split("?")[0]
    if raw.startswith("abs/"):
        raw = raw[len("abs/") :]
    if raw.startswith("pdf/"):
        raw = raw[len("pdf/") :].replace(".pdf", "")
    return raw.strip().lower()


def prepare_paper_paths(
    docs_dir: str, date_str: str, title: str, arxiv_id: str
) -> Tuple[str, str, str]:
    slug = slugify(title)
    basename = f"{arxiv_id}-{slug}" if arxiv_id else slug
    ym = date_str[:6]
    day = date_str[6:]
    target_dir = os.path.join(docs_dir, ym, day)
    paper_id = f"{ym}/{day}/{basename}"
    md_path = os.path.join(target_dir, f"{basename}.md")
    txt_path = os.path.join(target_dir, f"{basename}.txt")
    return md_path, txt_path, paper_id


# ── arXiv fetch ──────────────────────────────────────────────────────


def parse_arxiv_xml_feed(xml_text: str) -> Dict[str, Any]:
    root = ET.fromstring(xml_text)
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    entry = root.find("atom:entry", ns)
    if entry is None:
        raise RuntimeError("arXiv API did not return any entry")

    def _text(tag: str) -> str:
        elem = entry.find(tag, ns)
        return (elem.text or "").strip() if elem is not None else ""

    arxiv_id = _text("atom:id")
    if arxiv_id:
        arxiv_id = arxiv_id.rsplit("/", 1)[-1]

    title = " ".join(_text("atom:title").split())
    abstract = " ".join(_text("atom:summary").split())
    published = _text("atom:published")
    published_date = ""
    if published:
        published_date = published.split("T", 1)[0].replace("-", "")

    authors = []
    for a in entry.findall("atom:author", ns):
        name_elem = a.find("atom:name", ns)
        if name_elem is not None:
            name = (name_elem.text or "").strip()
            if name and name not in authors:
                authors.append(name)

    pdf_url = ""
    for link in entry.findall("atom:link", ns):
        href = (link.attrib.get("href") or "").strip()
        if href.endswith(".pdf"):
            pdf_url = href
            break
        if link.attrib.get("title") == "pdf" and href:
            pdf_url = href
            break

    return {
        "id": arxiv_id,
        "title": title,
        "abstract": abstract,
        "published": published_date,
        "authors": authors,
        "link": pdf_url,
        "pdf_url": pdf_url,
    }


def fetch_arxiv_paper_meta(arxiv_id: str) -> Dict[str, Any]:
    pid = normalize_arxiv_id(arxiv_id)
    if not pid:
        raise ValueError("arXiv ID is empty")
    url = f"https://export.arxiv.org/api/query?id_list={quote_plus(pid)}"
    print(f"[INFO] Fetching arXiv metadata: {url}", flush=True)
    resp = requests.get(url, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"arXiv API request failed, status={resp.status_code}")
    return parse_arxiv_xml_feed(resp.text)


# ── Paper markdown generation ────────────────────────────────────────


def generate_paper_markdown(
    arxiv_id: str,
    title: str,
    authors: List[str],
    date_str: str,
    pdf_url: str,
    abstract: str,
) -> str:
    date_label = format_date_str(date_str)
    date_iso = f"{date_label}"
    authors_str = ", ".join(authors)

    lines: List[str] = []
    lines.append("---")
    lines.append(f'title: "{title}"')
    lines.append(f'authors: "{authors_str}"')
    lines.append(f"date: {date_iso}")
    lines.append(f'pdf: "{pdf_url}"')
    lines.append("score: 0.0")
    lines.append("source: arxiv")
    lines.append("selection_source: issue")
    lines.append("tldr: \"\"")
    lines.append("---")
    lines.append("")
    lines.append("## Abstract")
    lines.append(abstract)
    lines.append("")
    return "\n".join(lines)


# ── Daily README ─────────────────────────────────────────────────────


def build_day_report_markdown(
    date_str: str,
    quick_entries: List[Tuple[str, str]],
) -> str:
    date_label = format_date_str(date_str)
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    total = len(quick_entries)

    lines: List[str] = []
    lines.append(f"# 日报 · {date_label}")
    lines.append("")
    lines.append(f"- 生成时间：{generated_at}")
    lines.append(f"- 当次推荐总数：{total}")
    lines.append("- 精读区：0")
    lines.append(f"- 速读区：{total}")
    lines.append("")

    lines.append("## 精读区")
    lines.append("- 本次无精读推荐。")
    lines.append("")

    lines.append("## 速读区")
    if quick_entries:
        for idx, (paper_id, title) in enumerate(quick_entries, start=1):
            lines.append(
                f"{idx}. [{title}]({build_docsify_id_href(paper_id)}) （0.0/10）"
            )
    else:
        lines.append("- 本次无速读推荐。")
    lines.append("")

    lines.append("---")
    lines.append("使用键盘方向键可在日报/论文之间快速切换。")
    lines.append("")
    return "\n".join(lines)


def update_day_readme(
    docs_dir: str,
    date_str: str,
    paper_id: str,
    title: str,
) -> str:
    ym = date_str[:6]
    day = date_str[6:]
    day_dir = os.path.join(docs_dir, ym, day)
    os.makedirs(day_dir, exist_ok=True)
    day_readme = os.path.join(day_dir, "README.md")

    existing_entries: List[Tuple[str, str]] = []
    if os.path.exists(day_readme):
        try:
            with open(day_readme, "r", encoding="utf-8") as f:
                content = f.read()
            # Parse existing quick entries from 速读区 section
            in_quick = False
            for line in content.splitlines():
                if line.strip() == "## 速读区":
                    in_quick = True
                    continue
                if in_quick and line.startswith("## "):
                    break
                if in_quick and line.startswith("1.") or (
                    in_quick and re.match(r"^\d+\.", line.strip())
                ):
                    # Extract from format: 1. [Title](/path) （score）
                    m = re.match(r"^\d+\.\s*\[(.+?)\]\((.+?)\)", line.strip())
                    if m:
                        entry_title = m.group(1)
                        entry_href = m.group(2)
                        # Reconstruct paper_id from href (strip leading / and .md)
                        entry_pid = entry_href.lstrip("/").replace(".md", "")
                        existing_entries.append((entry_pid, entry_title))
        except Exception:
            pass

    # Add new entry if not already present
    if not any(pid == paper_id for pid, _ in existing_entries):
        existing_entries.append((paper_id, title))

    content = build_day_report_markdown(date_str, existing_entries)
    with open(day_readme, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"[OK] Daily README updated: {day_readme}", flush=True)
    return day_readme


# ── Sidebar update ───────────────────────────────────────────────────


def build_sidebar_item_payload(paper_id: str, title: str) -> str:
    arxiv_id = str(paper_id or "").strip().split("/")[-1]
    # Extract just the arXiv ID from the filename (remove slug)
    arxiv_id_part = arxiv_id.split("-", 1)[0] if "-" in arxiv_id else arxiv_id
    paper_link = f"https://arxiv.org/abs/{arxiv_id_part}"
    payload = {
        "title": (title or "").strip() or paper_id,
        "link": paper_link,
        "score": "0.0",
        "tags": [],
    }
    return html.escape(json.dumps(payload, ensure_ascii=False), quote=True)


def update_sidebar(
    sidebar_path: str,
    date_str: str,
    paper_id: str,
    title: str,
) -> None:
    date_label = format_date_str(date_str)
    marker = f"<!--dpr-date:{date_str}-->"
    day_heading = f"  * {date_label} {marker}\n"

    lines: List[str] = []
    if os.path.exists(sidebar_path):
        with open(sidebar_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

    # Find "Latest Papers"
    latest_idx = -1
    for i, line in enumerate(lines):
        if line.strip().startswith("* Latest Papers"):
            latest_idx = i
            break
    if latest_idx == -1:
        if not any("[首页]" in line for line in lines):
            lines.append("* <a class=\"dpr-sidebar-root-link\" href=\"#/\">首页</a>\n")
        if not any("[论文列表]" in line for line in lines):
            lines.append(
                "* <a class=\"dpr-sidebar-root-link\" href=\"#/papers/README\">论文列表</a>\n"
            )
        lines.append("* Latest Papers\n")
        latest_idx = len(lines) - 1
    else:
        if not any("[论文列表]" in line for line in lines):
            lines.insert(
                latest_idx,
                "* <a class=\"dpr-sidebar-root-link\" href=\"#/papers/README\">论文列表</a>\n",
            )
            latest_idx += 1

    # Find or create date entry
    day_idx = -1
    for i in range(latest_idx + 1, len(lines)):
        line = lines[i]
        if line.startswith("* ") and not line.startswith("  * "):
            break
        if marker in line:
            day_idx = i
            break

    if day_idx != -1:
        end = day_idx + 1
        while end < len(lines):
            if lines[end].startswith("  * ") and not lines[end].startswith("    * "):
                break
            end += 1
        del lines[day_idx:end]

    # Build block
    block: List[str] = [day_heading]
    block.append("    * 速读区\n")
    safe_title = html.escape((title or "").strip() or paper_id)
    href = f"#/{paper_id}"
    payload_json = build_sidebar_item_payload(paper_id, title)
    block.append(
        "      * "
        f'<a class="dpr-sidebar-item-link dpr-sidebar-item-structured" '
        f'href="{href}" data-sidebar-item="{payload_json}">{safe_title}</a>\n'
    )

    insert_idx = latest_idx + 1
    lines[insert_idx:insert_idx] = block

    # Clean legacy 日报 entries
    i = latest_idx + 1
    while i < len(lines):
        if lines[i].startswith("* "):
            break
        if lines[i].startswith("    * [日报]("):
            del lines[i]
            continue
        i += 1

    with open(sidebar_path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(f"[OK] Sidebar updated: {sidebar_path}", flush=True)


# ── Papers index update ──────────────────────────────────────────────


def update_papers_index(
    docs_dir: str,
    date_str: str,
    paper_id: str,
    title: str,
    authors: List[str],
    abstract: str,
    pdf_url: str,
) -> None:
    date_label = format_date_str(date_str)
    ym = date_str[:6]
    day = date_str[6:]

    # Update papers/index.json
    index_path = os.path.join(docs_dir, "papers", "index.json")
    os.makedirs(os.path.dirname(index_path), exist_ok=True)

    data: Dict[str, Any] = {"count": 0, "papers": []}
    if os.path.exists(index_path):
        try:
            with open(index_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            pass

    # Check if already exists
    existing_ids = {p.get("paper_id") for p in data.get("papers", [])}
    if paper_id not in existing_ids:
        entry = {
            "paper_id": paper_id,
            "section": "quick",
            "title_en": title,
            "authors": ", ".join(authors),
            "date": f"{date_label}",
            "pdf": pdf_url,
            "score": "0.0",
            "evidence": "",
            "tldr": "",
            "tags": "",
            "abstract_en": abstract,
            "source": "arxiv",
            "selection_source": "issue",
            "_date_label": date_label,
            "_date": date_label,
        }
        data.setdefault("papers", []).append(entry)
        data["count"] = len(data["papers"])

    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"[OK] papers/index.json updated: {index_path}", flush=True)

    # Update papers/dirs.json
    dirs_path = os.path.join(docs_dir, "papers", "dirs.json")
    dirs: List[str] = []
    if os.path.exists(dirs_path):
        try:
            with open(dirs_path, "r", encoding="utf-8") as f:
                dirs = json.load(f)
        except Exception:
            pass

    dir_key = f"{ym}/{day}"
    if dir_key not in dirs:
        dirs.insert(0, dir_key)

    with open(dirs_path, "w", encoding="utf-8") as f:
        json.dump(dirs, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"[OK] papers/dirs.json updated: {dirs_path}", flush=True)

    # Update papers.meta.json in day directory
    meta_path = os.path.join(docs_dir, ym, day, "papers.meta.json")
    meta_data: Dict[str, Any] = {
        "label": date_label,
        "date": date_label,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "count": 0,
        "papers": [],
    }
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta_data = json.load(f)
        except Exception:
            pass

    meta_ids = {p.get("paper_id") for p in meta_data.get("papers", [])}
    if paper_id not in meta_ids:
        meta_entry = {
            "paper_id": paper_id,
            "section": "quick",
            "title_en": title,
            "authors": ", ".join(authors),
            "date": date_label,
            "pdf": pdf_url,
            "score": "0.0",
            "evidence": "",
            "tldr": "",
            "tags": "",
            "abstract_en": abstract,
            "source": "arxiv",
            "selection_source": "issue",
        }
        meta_data.setdefault("papers", []).append(meta_entry)
        meta_data["count"] = len(meta_data["papers"])

    os.makedirs(os.path.dirname(meta_path), exist_ok=True)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta_data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"[OK] papers.meta.json updated: {meta_path}", flush=True)


# ── Main ─────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add a single arXiv paper to the 速读区.",
    )
    parser.add_argument(
        "--arxiv-id",
        type=str,
        required=True,
        help="arXiv ID (e.g. 2401.12345)",
    )
    parser.add_argument(
        "--date",
        type=str,
        default="",
        help="Output date as YYYYMMDD (default: today UTC).",
    )
    args = parser.parse_args()

    arxiv_id = normalize_arxiv_id(args.arxiv_id)
    if not arxiv_id:
        print("[ERROR] Invalid arXiv ID.", flush=True)
        sys.exit(1)

    date_str = (args.date or "").strip() or TODAY_STR
    if len(date_str) != 8 or not date_str.isdigit():
        print(f"[ERROR] Invalid date format: {date_str}. Expected YYYYMMDD.", flush=True)
        sys.exit(1)

    # Fetch metadata
    paper = fetch_arxiv_paper_meta(arxiv_id)
    title = (paper.get("title") or "").strip()
    authors = paper.get("authors") or []
    abstract = (paper.get("abstract") or "").strip()
    pdf_url = (paper.get("pdf_url") or paper.get("link") or "").strip()

    if not title:
        print(f"[ERROR] Could not fetch title for arXiv ID: {arxiv_id}", flush=True)
        sys.exit(1)

    print(f"[INFO] Paper: {title}", flush=True)
    print(f"[INFO] Authors: {', '.join(authors)}", flush=True)
    print(f"[INFO] Date: {date_str}", flush=True)

    # Resolve docs dir
    docs_dir = os.path.join(ROOT_DIR, "docs")

    # Generate paper page
    md_path, txt_path, paper_id = prepare_paper_paths(docs_dir, date_str, title, arxiv_id)
    os.makedirs(os.path.dirname(md_path), exist_ok=True)

    md_content = generate_paper_markdown(arxiv_id, title, authors, date_str, pdf_url, abstract)

    if os.path.exists(md_path):
        print(f"[WARN] Paper page already exists, overwriting: {md_path}", flush=True)

    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md_content)
    print(f"[OK] Paper page created: {md_path}", flush=True)

    # Update daily README
    update_day_readme(docs_dir, date_str, paper_id, title)

    # Update sidebar
    sidebar_path = os.path.join(docs_dir, "_sidebar.md")
    update_sidebar(sidebar_path, date_str, paper_id, title)

    # Update papers index
    update_papers_index(docs_dir, date_str, paper_id, title, authors, abstract, pdf_url)

    print(f"\n[OK] Done! Paper {arxiv_id} added to 速读区.", flush=True)
    print(f"  paper_id: {paper_id}", flush=True)
    print(f"  md_path:  {md_path}", flush=True)


if __name__ == "__main__":
    main()
