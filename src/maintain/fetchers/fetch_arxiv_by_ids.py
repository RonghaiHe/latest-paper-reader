#!/usr/bin/env python
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import arxiv

BATCH_SIZE = 100
REQ_DELAY = 1.0


def log(message: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {message}", flush=True)


def normalize_arxiv_id(value: str) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    if text.startswith("arxiv:"):
        text = text.split(":", 1)[1].strip()
    if text.startswith("http://") or text.startswith("https://"):
        text = text.split("?", 1)[0].split("#", 1)[0]
        text = text.rstrip("/")
        if "/abs/" in text:
            text = text.rsplit("/abs/", 1)[-1]
        elif "/pdf/" in text:
            text = text.rsplit("/pdf/", 1)[-1]
        else:
            text = text.rsplit("/", 1)[-1]
    if text.endswith(".pdf"):
        text = text[: -len(".pdf")]
    text = text.strip()
    matched = re.match(r"^(\d{4}\.\d{4,5})(?:v\d+)?$", text)
    if matched:
        return matched.group(1)
    return text


def parse_arxiv_ids(raw: str | None) -> list[str]:
    if not raw:
        return []
    parts = re.split(r"[\s,;]+", raw.strip())
    seen: set[str] = set()
    result: list[str] = []
    for p in parts:
        token = normalize_arxiv_id(p)
        if token and token not in seen:
            seen.add(token)
            result.append(token)
    return result


def batch_fetch_by_ids(ids: list[str], batch_size: int = BATCH_SIZE) -> list[dict]:
    client = arxiv.Client(delay_seconds=REQ_DELAY, num_retries=3)
    all_papers: list[dict] = []
    total = len(ids)
    seen_ids: set[str] = set()

    for start in range(0, total, batch_size):
        batch = ids[start : start + batch_size]
        batch_label = f"[{start + 1}-{min(start + batch_size, total)}/{total}]"
        log(f"Fetching batch {batch_label}: {len(batch)} IDs")

        try:
            results = list(client.results(arxiv.Search(id_list=batch, max_results=None)))
        except Exception as e:
            log(f"ERROR fetching batch {batch_label}: {e}")
            continue

        count = 0
        for r in results:
            pid = normalize_arxiv_id(r.get_short_id())
            if not pid or pid in seen_ids:
                continue
            seen_ids.add(pid)
            pdf_link = getattr(r, "pdf_url", None) or r.entry_id
            paper_dict = {
                "id": pid,
                "source": "arxiv",
                "title": r.title.replace("\n", " "),
                "abstract": r.summary.replace("\n", " "),
                "authors": [a.name for a in r.authors],
                "primary_category": r.primary_category,
                "categories": r.categories,
                "published": str(r.published),
                "link": pdf_link,
            }
            all_papers.append(paper_dict)
            count += 1

        log(f"  Batch {batch_label}: got {count} papers (total unique: {len(all_papers)})")
        time.sleep(0.5)

    return all_papers


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch arXiv paper metadata by ID list.")
    parser.add_argument("--arxiv-ids", type=str, default=None, help="Comma/space/newline separated arXiv IDs")
    parser.add_argument("--input-file", type=str, default=None, help="File with one arXiv ID per line")
    parser.add_argument("--output", type=str, default=None, help="Output JSON file path")
    args = parser.parse_args()

    raw_ids_str = args.arxiv_ids or ""
    if args.input_file:
        try:
            with open(args.input_file, "r", encoding="utf-8") as f:
                file_content = f.read()
            if raw_ids_str:
                raw_ids_str += "," + file_content
            else:
                raw_ids_str = file_content
        except Exception as e:
            log(f"ERROR reading input file {args.input_file}: {e}")
            sys.exit(1)

    ids = parse_arxiv_ids(raw_ids_str)
    if not ids:
        log("No valid arXiv IDs provided. Nothing to do.")
        return

    log(f"Total unique arXiv IDs after normalization: {len(ids)}")
    papers = batch_fetch_by_ids(ids)
    log(f"Total papers fetched: {len(papers)}")

    if not papers:
        log("No papers were fetched. Exiting.")
        return

    output_path = args.output
    if not output_path:
        run_token = datetime.now(timezone.utc).strftime("%Y%m%d")
        script_dir = os.path.dirname(os.path.abspath(__file__))
        root_dir = os.path.abspath(os.path.join(script_dir, "..", "..", ".."))
        archive_dir = os.path.join(root_dir, "archive", run_token, "raw")
        os.makedirs(archive_dir, exist_ok=True)
        output_path = os.path.join(archive_dir, f"arxiv_papers_{run_token}.by_ids.json")

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(papers, f, ensure_ascii=False, indent=2)
    log(f"Saved {len(papers)} papers to {output_path}")


if __name__ == "__main__":
    main()
