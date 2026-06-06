import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


def _load_module():
    root = Path(__file__).resolve().parents[1]
    fetcher_dir = root / "src" / "maintain" / "fetchers"
    src_path = fetcher_dir / "fetch_arxiv_by_ids.py"
    spec = importlib.util.spec_from_file_location("fetch_arxiv_by_ids_mod", src_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class FetchArxivByIdsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_module()

    def test_normalize_arxiv_id_removes_version(self):
        self.assertEqual(self.mod.normalize_arxiv_id("2401.12345v3"), "2401.12345")

    def test_normalize_arxiv_id_strips_url(self):
        cases = [
            ("https://arxiv.org/abs/2401.12345", "2401.12345"),
            ("http://arxiv.org/pdf/2402.67890.pdf", "2402.67890"),
            ("https://arxiv.org/abs/2303.abcde", "2303.abcde"),
        ]
        for raw, expected in cases:
            self.assertEqual(self.mod.normalize_arxiv_id(raw), expected)

    def test_normalize_arxiv_id_strips_arxiv_prefix(self):
        self.assertEqual(self.mod.normalize_arxiv_id("arxiv:2401.12345"), "2401.12345")

    def test_normalize_arxiv_id_returns_empty_for_invalid(self):
        self.assertEqual(self.mod.normalize_arxiv_id(""), "")
        self.assertEqual(self.mod.normalize_arxiv_id("   "), "")
        self.assertEqual(self.mod.normalize_arxiv_id("not-an-id"), "not-an-id")

    def test_parse_arxiv_ids_splits_commas(self):
        result = self.mod.parse_arxiv_ids("2401.12345,2402.67890,2303.abcde")
        self.assertEqual(result, ["2401.12345", "2402.67890", "2303.abcde"])

    def test_parse_arxiv_ids_splits_mixed_delimiters(self):
        result = self.mod.parse_arxiv_ids("2401.12345; 2303.abcde\n2402.67890")
        self.assertEqual(len(result), 3)
        for r in result:
            self.assertIn(r, ["2401.12345", "2303.abcde", "2402.67890"])

    def test_parse_arxiv_ids_deduplicates(self):
        result = self.mod.parse_arxiv_ids("2401.12345,2401.12345,2401.12345")
        self.assertEqual(result, ["2401.12345"])

    def test_parse_arxiv_ids_normalizes(self):
        result = self.mod.parse_arxiv_ids("https://arxiv.org/abs/2401.12345v2")
        self.assertEqual(result, ["2401.12345"])

    def test_parse_arxiv_ids_returns_empty_for_none(self):
        self.assertEqual(self.mod.parse_arxiv_ids(None), [])
        self.assertEqual(self.mod.parse_arxiv_ids(""), [])

    def test_batch_fetch_by_ids_returns_papers(self):
        mock_result = MagicMock()
        mock_result.get_short_id.return_value = "2401.12345"
        mock_result.title = "Test Paper"
        mock_result.summary = "Test abstract"
        mock_result.authors = []
        mock_result.primary_category = "cs.AI"
        mock_result.categories = ["cs.AI"]
        mock_result.published = "2024-01-01"
        mock_result.pdf_url = "http://arxiv.org/pdf/2401.12345"
        mock_result.entry_id = "http://arxiv.org/abs/2401.12345"

        with patch.object(self.mod, "arxiv") as mock_arxiv:
            mock_client = MagicMock()
            mock_arxiv.Client.return_value = mock_client
            mock_client.results.return_value = [mock_result]

            papers = self.mod.batch_fetch_by_ids(["2401.12345"])

        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0]["id"], "2401.12345")
        self.assertEqual(papers[0]["title"], "Test Paper")
        self.assertEqual(papers[0]["primary_category"], "cs.AI")

    def test_main_with_arxiv_ids(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "output.json"

            with patch.object(self.mod, "batch_fetch_by_ids", return_value=[
                {"id": "2401.12345", "title": "Test"}
            ]), patch.object(
                sys, "argv",
                [
                    "fetch_arxiv_by_ids.py",
                    "--arxiv-ids", "2401.12345",
                    "--output", str(output_path),
                ],
            ):
                self.mod.main()

            self.assertTrue(output_path.exists())
            data = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(len(data), 1)
            self.assertEqual(data[0]["id"], "2401.12345")

    def test_main_with_input_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_file = tmp / "ids.txt"
            input_file.write_text("2401.12345\n2402.67890\n", encoding="utf-8")
            output_path = tmp / "output.json"

            with patch.object(self.mod, "batch_fetch_by_ids", return_value=[
                {"id": "2401.12345", "title": "A"},
                {"id": "2402.67890", "title": "B"},
            ]), patch.object(
                sys, "argv",
                [
                    "fetch_arxiv_by_ids.py",
                    "--input-file", str(input_file),
                    "--output", str(output_path),
                ],
            ):
                self.mod.main()

            self.assertTrue(output_path.exists())
            data = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(len(data), 2)

    def test_main_exits_early_when_no_ids(self):
        with patch.object(self.mod, "batch_fetch_by_ids") as mock_fetch, \
             patch.object(sys, "argv", ["fetch_arxiv_by_ids.py"]):
            self.mod.main()
        mock_fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
