import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def _load_module():
    root = Path(__file__).resolve().parents[1]
    src_dir = root / "src"
    if str(src_dir) not in sys.path:
        sys.path.insert(0, str(src_dir))
    src_path = root / "src" / "main.py"
    spec = importlib.util.spec_from_file_location("main_pipeline_mod", src_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class MainPipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_module()

    def test_resolve_summary_step_env_uses_summary_overrides(self):
        with patch.dict(
            os.environ,
            {
                "DEEPSEEK_API_KEY": "base-key",
                "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
                "SUMMARY_API_KEY": "summary-key",
                "SUMMARY_BASE_URL": "https://summary.example.com/v1",
                "SUMMARY_MODEL": "deepseek-v4-flash",
            },
            clear=True,
        ):
            env = self.mod.resolve_summary_step_env()

        self.assertEqual(env["DEEPSEEK_API_KEY"], "summary-key")
        self.assertEqual(env["SUMMARY_API_KEY"], "summary-key")
        self.assertEqual(env["DEEPSEEK_BASE_URL"], "https://summary.example.com/v1")
        self.assertEqual(env["LLM_PRIMARY_BASE_URL"], "https://summary.example.com/v1")
        self.assertEqual(env["DEEPSEEK_MODEL"], "deepseek-v4-flash")

    def test_resolve_summary_step_env_falls_back_to_deepseek(self):
        with patch.dict(
            os.environ,
            {
                "DEEPSEEK_API_KEY": "fallback-key",
                "DEEPSEEK_BASE_URL": "https://fallback.example.com",
                "DEEPSEEK_MODEL": "deepseek-chat",
            },
            clear=True,
        ):
            env = self.mod.resolve_summary_step_env()
        self.assertEqual(env["DEEPSEEK_API_KEY"], "fallback-key")
        self.assertEqual(env["DEEPSEEK_BASE_URL"], "https://fallback.example.com")
        self.assertEqual(env["DEEPSEEK_MODEL"], "deepseek-chat")

    def test_normalize_arxiv_id_removes_version_suffix(self):
        self.assertEqual(self.mod.normalize_arxiv_id("2401.12345v2"), "2401.12345")
        self.assertEqual(self.mod.normalize_arxiv_id("2401.12345v1"), "2401.12345")

    def test_normalize_arxiv_id_strips_url_prefix(self):
        cases = [
            ("https://arxiv.org/abs/2401.12345", "2401.12345"),
            ("http://arxiv.org/pdf/2401.12345.pdf", "2401.12345"),
            ("https://arxiv.org/abs/2401.12345v2", "2401.12345"),
        ]
        for raw, expected in cases:
            self.assertEqual(self.mod.normalize_arxiv_id(raw), expected)

    def test_normalize_arxiv_id_strips_arxiv_prefix(self):
        self.assertEqual(self.mod.normalize_arxiv_id("arxiv:2401.12345"), "2401.12345")

    def test_normalize_arxiv_id_returns_empty_for_invalid(self):
        self.assertEqual(self.mod.normalize_arxiv_id(""), "")
        self.assertEqual(self.mod.normalize_arxiv_id("   "), "")
        self.assertEqual(self.mod.normalize_arxiv_id("not-an-id"), "not-an-id")

    def test_parse_trace_ids_deduplicates(self):
        with patch.dict(os.environ, {}, clear=True):
            result = self.mod.parse_trace_ids(["2401.12345", "2401.12345", "2402.67890"])
        self.assertEqual(result, ["2401.12345", "2402.67890"])

    def test_parse_trace_ids_normalizes(self):
        with patch.dict(os.environ, {}, clear=True):
            result = self.mod.parse_trace_ids(["https://arxiv.org/abs/2401.12345v2"])
        self.assertEqual(result, ["2401.12345"])

    def test_parse_trace_ids_reads_env(self):
        with patch.dict(os.environ, {"DPR_TRACE_ARXIV_IDS": "2403.abcde"}, clear=True):
            result = self.mod.parse_trace_ids(["2401.12345"])
        # env value "2403.abcde" is not a valid arXiv ID pattern, so it stays as-is
        self.assertIn("2403.abcde", result)
        self.assertIn("2401.12345", result)

    def test_parse_comma_ids_splits_mixed_delimiters(self):
        result = self.mod.parse_comma_ids("2401.12345, 2402.67890;2403.abcde")
        self.assertEqual(result, ["2401.12345", "2402.67890", "2403.abcde"])

    def test_parse_comma_ids_deduplicates(self):
        result = self.mod.parse_comma_ids("2401.12345,2401.12345")
        self.assertEqual(result, ["2401.12345"])

    def test_main_exits_early_when_no_ids(self):
        with patch.object(self.mod, "run_step") as mock_run:
            with patch.object(sys, "argv", ["main.py"]):
                self.mod.main()
        mock_run.assert_not_called()

    def test_main_calls_all_three_steps(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            src_dir = root / "src"
            src_dir.mkdir(parents=True, exist_ok=True)

            raw_dir = root / "archive" / "20260310" / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            raw_path = raw_dir / "arxiv_papers_20260310.by_ids.json"
            raw_path.write_text(json.dumps([{"id": "2401.12345", "title": "Test"}]), encoding="utf-8")

            calls = []
            def fake_run_step(label, args, env=None):
                calls.append((label, args, env))

            with patch.object(self.mod, "ROOT_DIR", str(root)), \
                 patch.object(self.mod, "SRC_DIR", str(src_dir)), \
                 patch.object(self.mod, "run_step", side_effect=fake_run_step), \
                 patch.object(self.mod, "load_json_safe", return_value=[{"id": "2401.12345"}]), \
                 patch.object(sys, "argv", ["main.py", "--arxiv-ids", "2401.12345"]), \
                 patch.dict(os.environ, {"PATH": os.environ.get("PATH", "")}, clear=True):
                self.mod.main()

            labels = [item[0] for item in calls]
            self.assertIn("Step 1 - fetch by IDs", labels)
            self.assertIn("Step 2 - select papers", labels)
            self.assertIn("Step 3 - generate docs", labels)
            self.assertEqual(len(labels), 3)


if __name__ == "__main__":
    unittest.main()
