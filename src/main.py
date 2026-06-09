#!/usr/bin/env python
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any

SRC_DIR = os.path.dirname(__file__)
ROOT_DIR = os.path.abspath(os.path.join(SRC_DIR, ".."))


def run_step(label: str, args: list[str], env: dict[str, str] | None = None) -> None:
    print(f"[INFO] {label}: {' '.join(args)}", flush=True)
    subprocess.run(args, check=True, env=env)


def load_json_safe(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        print(f"[TRACE] 读取失败: {path} | {exc}", flush=True)
        return None


def save_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def normalize_arxiv_id(value: Any) -> str:
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


def parse_trace_ids(cli_values: list[str] | None) -> list[str]:
    raw_parts: list[str] = []
    for value in cli_values or []:
        raw_parts.extend(re.split(r"[,\s]+", str(value or "").strip()))
    env_value = str(os.getenv("DPR_TRACE_ARXIV_IDS") or "").strip()
    if env_value:
        raw_parts.extend(re.split(r"[,\s]+", env_value))

    seen: set[str] = set()
    result: list[str] = []
    for item in raw_parts:
        token = normalize_arxiv_id(item)
        if not token or token in seen:
            continue
        seen.add(token)
        result.append(token)
    return result


def parse_comma_ids(raw: str | None) -> list[str]:
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


def resolve_summary_step_env() -> dict[str, str]:
    env = os.environ.copy()
    summary_api_key = str(os.getenv("SUMMARY_API_KEY") or os.getenv("DEEPSEEK_API_KEY") or "").strip()
    summary_base_url = str(os.getenv("SUMMARY_BASE_URL") or os.getenv("DEEPSEEK_BASE_URL") or "").strip()
    summary_model = str(os.getenv("SUMMARY_MODEL") or os.getenv("DEEPSEEK_MODEL") or "").strip()

    if summary_api_key:
        env["SUMMARY_API_KEY"] = summary_api_key
        env["DEEPSEEK_API_KEY"] = summary_api_key
    if summary_base_url:
        env["LLM_PRIMARY_BASE_URL"] = summary_base_url
        env["SUMMARY_BASE_URL"] = summary_base_url
        env["DEEPSEEK_BASE_URL"] = summary_base_url
    if summary_model:
        env["SUMMARY_MODEL"] = summary_model
        env["DEEPSEEK_MODEL"] = summary_model
    return env


def print_trace_recommend(stage: str, path: str, trace_ids: list[str]) -> None:
    if not os.path.exists(path):
        return
    data = load_json_safe(path)
    if not isinstance(data, dict):
        return

    deep = data.get("deep_dive")
    quick = data.get("quick_skim")
    deep_index: dict[str, dict] = {}
    quick_index: dict[str, dict] = {}
    trace_set = set(trace_ids)

    if isinstance(deep, list):
        for idx, item in enumerate(deep, start=1):
            pid = normalize_arxiv_id(item.get("id") or item.get("paper_id"))
            if pid and pid not in deep_index:
                deep_index[pid] = {"rank": idx, "item": item}
    if isinstance(quick, list):
        for idx, item in enumerate(quick, start=1):
            pid = normalize_arxiv_id(item.get("id") or item.get("paper_id"))
            if pid and pid not in quick_index:
                quick_index[pid] = {"rank": idx, "item": item}

    print(f"[TRACE][{stage}] path={path}", flush=True)
    for pid in trace_ids:
        deep_item = deep_index.get(pid)
        quick_item = quick_index.get(pid)
        zone = "none"
        pos = "-"
        if deep_item:
            zone = "deep_dive"
            pos = str(deep_item["rank"])
        elif quick_item:
            zone = "quick_skim"
            pos = str(quick_item["rank"])
        print(f"[TRACE][{stage}] id={pid} | zone={zone} | rank={pos}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Latest Paper Reader pipeline (fetch_by_ids → select → generate_docs).",
    )
    parser.add_argument(
        "--arxiv-ids",
        type=str,
        default="",
        help="Comma/space/newline separated arXiv IDs to fetch and process.",
    )
    parser.add_argument(
        "--deep-dive-ids",
        type=str,
        default="",
        help="Comma/space/newline separated arXiv IDs to mark as deep-dive (精读).",
    )
    parser.add_argument(
        "--trace-arxiv-id",
        action="append",
        default=None,
        help="Trace specific arXiv IDs through pipeline for debugging.",
    )
    args = parser.parse_args()

    arxiv_ids_str = str(args.arxiv_ids or "").strip()
    deep_dive_ids_str = str(args.deep_dive_ids or "").strip()

    # cron / empty trigger: 空跑不报错
    if not arxiv_ids_str:
        print("[INFO] 无 arXiv ID 输入，跳过本次执行。", flush=True)
        return

    run_date_token = datetime.now(timezone.utc).strftime("%Y%m%d")
    os.environ["DPR_RUN_DATE"] = run_date_token
    print(f"[INFO] DPR_RUN_DATE={run_date_token}", flush=True)

    trace_ids = parse_trace_ids(args.trace_arxiv_id)
    if trace_ids:
        print(f"[TRACE] 启用论文追踪: {', '.join(trace_ids)}", flush=True)

    archive_dir = os.path.join(ROOT_DIR, "archive", run_date_token)
    raw_dir = os.path.join(archive_dir, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    raw_path = os.path.join(raw_dir, f"arxiv_papers_{run_date_token}.by_ids.json")

    recommend_dir = os.path.join(archive_dir, "recommend")
    recommend_path = os.path.join(recommend_dir, f"arxiv_papers_{run_date_token}.manual.json")

    python = sys.executable

    # Step 1: fetch by IDs
    run_step(
        "Step 1 - fetch by IDs",
        [
            python,
            os.path.join(SRC_DIR, "maintain", "fetchers", "fetch_arxiv_by_ids.py"),
            "--arxiv-ids",
            arxiv_ids_str,
            "--output",
            raw_path,
        ],
    )

    raw_data = load_json_safe(raw_path)
    if not raw_data:
        print("[ERROR] 未获取到论文数据，终止管道。", flush=True)
        sys.exit(1)

    if trace_ids:
        print(f"[TRACE][RAW] path={raw_path}", flush=True)
        trace_set = set(trace_ids)
        for pid in trace_ids:
            found = next(
                (
                    p
                    for p in (raw_data if isinstance(raw_data, list) else [])
                    if isinstance(p, dict) and normalize_arxiv_id(p.get("id")) == pid
                ),
                None,
            )
            print(f"[TRACE][RAW] id={pid} | found={'Y' if found else 'N'}", flush=True)

    # Step 2: select papers
    select_args = [
        python,
        os.path.join(SRC_DIR, "5.select_papers.py"),
        "--raw-input-mode",
        "--input",
        raw_path,
        "--output-dir",
        recommend_dir,
    ]
    if deep_dive_ids_str:
        select_args.extend(["--deep-dive-ids", deep_dive_ids_str])
    run_step("Step 2 - select papers", select_args)

    if trace_ids:
        print_trace_recommend("RECOMMEND", recommend_path, trace_ids)

    # Step 3: generate docs
    run_step(
        "Step 3 - generate docs",
        [
            python,
            os.path.join(SRC_DIR, "6.generate_docs.py"),
            "--mode", "manual",
        ],
        env=resolve_summary_step_env(),
    )


if __name__ == "__main__":
    main()
