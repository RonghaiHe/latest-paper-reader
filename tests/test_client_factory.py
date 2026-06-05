import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from llm import (
    ClientFactory,
    DeepSeekClient,
    GlmClient,
    CustomClient,
    FallbackLLMClient,
    LLMClient,
    parse_provider_model,
)


class ClientFactoryTest(unittest.TestCase):
    def setUp(self):
        self.env_patcher = patch.dict("llm.os.environ", {}, clear=True)
        self.env_patcher.start()

    def tearDown(self):
        self.env_patcher.stop()

    def test_parse_provider_model(self):
        provider, model = parse_provider_model("deepseek/deepseek-v4-flash")
        self.assertEqual(provider, "deepseek")
        self.assertEqual(model, "deepseek-v4-flash")

    def test_parse_provider_model_with_slash(self):
        provider, model = parse_provider_model("openrouter/anthropic/claude-sonnet-4")
        self.assertEqual(provider, "openrouter")
        self.assertEqual(model, "anthropic/claude-sonnet-4")

    def test_parse_provider_model_no_slash(self):
        with self.assertRaises(ValueError):
            parse_provider_model("just-a-model")

    @patch.dict("llm.os.environ", {"LLM_MODEL": "deepseek/deepseek-v4-flash", "DEEPSEEK_API_KEY": "sk-test"})
    def test_from_env_deepseek(self):
        client = ClientFactory.from_env()
        self.assertIsInstance(client, DeepSeekClient)
        self.assertEqual(client.model, "deepseek-v4-flash")
        self.assertEqual(client.api_key, "sk-test")

    @patch.dict("llm.os.environ", {"LLM_MODEL": "glm/glm-4.7-flash", "GLM_API_KEY": "glm-test"})
    def test_from_env_glm(self):
        client = ClientFactory.from_env()
        self.assertIsInstance(client, GlmClient)
        self.assertEqual(client.model, "glm-4.7-flash")
        self.assertEqual(client.api_key, "glm-test")

    @patch.dict("llm.os.environ", {"LLM_MODEL": "custom/my-model", "CUSTOM_API_KEY": "custom-test", "LLM_BASE_URL": "https://my-proxy.example.com/v1"})
    def test_from_env_custom(self):
        client = ClientFactory.from_env()
        self.assertIsInstance(client, CustomClient)
        self.assertEqual(client.model, "my-model")
        self.assertEqual(client.api_key, "custom-test")
        self.assertEqual(client.base_url, "https://my-proxy.example.com/v1")

    @patch.dict("llm.os.environ", {"DEEPSEEK_MODEL": "deepseek-v4-flash", "DEEPSEEK_API_KEY": "sk-test"})
    def test_from_env_legacy_deepseek_model(self):
        """Fall back to DEEPSEEK_MODEL when LLM_MODEL is not set."""
        client = ClientFactory.from_env()
        self.assertIsInstance(client, DeepSeekClient)
        self.assertEqual(client.model, "deepseek-v4-flash")

    @patch.dict("llm.os.environ", {"SUMMARY_MODEL": "deepseek-chat", "SUMMARY_API_KEY": "sk-test"})
    def test_from_env_legacy_summary_model(self):
        """Fall back to SUMMARY_MODEL when LLM_MODEL is not set."""
        client = ClientFactory.from_env()
        self.assertIsInstance(client, DeepSeekClient)
        self.assertEqual(client.model, "deepseek-chat")

    @patch.object(ClientFactory, "_read_config_default_model", return_value="")
    def test_from_env_no_config_raises(self, mock_read):
        with self.assertRaises(ValueError):
            ClientFactory.from_env()

    @patch.dict("llm.os.environ", {
        "LLM_MODEL": "deepseek/deepseek-v4-flash",
        "LLM_FALLBACK_MODEL": "glm/glm-4.7-flash",
        "DEEPSEEK_API_KEY": "sk-test",
        "GLM_API_KEY": "glm-test",
    })
    def test_from_env_with_fallback(self):
        client = ClientFactory.from_env()
        self.assertIsInstance(client, FallbackLLMClient)
        self.assertIsInstance(client.primary, DeepSeekClient)
        self.assertIsInstance(client.fallback, GlmClient)
        self.assertEqual(client.model, "deepseek-v4-flash")

    @patch.dict("llm.os.environ", {"LLM_API_KEY": "universal-key", "LLM_MODEL": "deepseek/deepseek-v4-flash"})
    def test_from_env_universal_api_key(self):
        client = ClientFactory.from_env()
        self.assertEqual(client.api_key, "universal-key")

    @patch.dict("llm.os.environ", {"LLM_BASE_URL": "https://custom.api.com/v1", "LLM_MODEL": "deepseek/deepseek-v4-flash"})
    def test_from_env_custom_base_url(self):
        client = ClientFactory.from_env()
        self.assertEqual(client.base_url, "https://custom.api.com/v1")


class CustomClientTest(unittest.TestCase):
    def test_custom_base_url(self):
        client = CustomClient(api_key="test", model="my-model", base_url="https://my-proxy.example.com/v1")
        self.assertIn("my-proxy", client.base_url)

    def test_custom_empty_base_url(self):
        client = CustomClient(api_key="test", model="my-model")
        self.assertEqual(client.base_url, "")


class FallbackLLMClientTest(unittest.TestCase):
    def _mock_success_response(self):
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        return resp

    def _mock_error_response(self, status_code=500):
        resp = MagicMock()
        resp.status_code = status_code
        resp.text = "Server Error"
        resp.raise_for_status.side_effect = requests.exceptions.HTTPError(
            f"HTTP {status_code}", response=resp,
        )
        return resp

    @patch("llm.requests.post")
    def test_fallback_on_failure(self, mock_post):
        mock_post.side_effect = [
            self._mock_error_response(500),
            self._mock_success_response(),
        ]
        primary = DeepSeekClient(api_key="pk", model="m1", base_url="https://a.com")
        fallback = DeepSeekClient(api_key="fk", model="m2", base_url="https://b.com")
        wrapper = FallbackLLMClient(primary, fallback)
        result = wrapper.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(result["content"], "ok")
        self.assertEqual(mock_post.call_count, 2)

    @patch("llm.requests.post")
    def test_no_fallback_on_success(self, mock_post):
        mock_post.return_value = self._mock_success_response()
        primary = DeepSeekClient(api_key="pk", model="m1", base_url="https://a.com")
        fallback = DeepSeekClient(api_key="fk", model="m2", base_url="https://b.com")
        wrapper = FallbackLLMClient(primary, fallback)
        result = wrapper.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(result["content"], "ok")
        self.assertEqual(mock_post.call_count, 1)

    @patch("llm.requests.post")
    def test_auth_error_does_not_fallback(self, mock_post):
        resp = MagicMock()
        resp.status_code = 401
        resp.text = "Unauthorized"
        resp.raise_for_status.side_effect = requests.exceptions.HTTPError(
            "401 Unauthorized", response=resp,
        )
        mock_post.return_value = resp
        primary = DeepSeekClient(api_key="bad", model="m1", base_url="https://a.com")
        fallback = DeepSeekClient(api_key="good", model="m2", base_url="https://b.com")
        wrapper = FallbackLLMClient(primary, fallback)
        with self.assertRaises(Exception):
            wrapper.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(mock_post.call_count, 1)

    def test_kwargs_delegates_to_primary(self):
        primary = DeepSeekClient(api_key="pk", model="m1", base_url="https://a.com")
        fallback = DeepSeekClient(api_key="fk", model="m2", base_url="https://b.com")
        wrapper = FallbackLLMClient(primary, fallback)
        wrapper.kwargs["temperature"] = 0.5
        self.assertEqual(primary.kwargs["temperature"], 0.5)

    def test_model_property(self):
        primary = DeepSeekClient(api_key="pk", model="my-model", base_url="https://a.com")
        fallback = DeepSeekClient(api_key="fk", model="other", base_url="https://b.com")
        wrapper = FallbackLLMClient(primary, fallback)
        self.assertEqual(wrapper.model, "my-model")


if __name__ == "__main__":
    unittest.main()
