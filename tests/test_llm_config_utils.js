const assert = require('node:assert/strict');

const {
  normalizeBaseUrlForStorage,
  buildChatCompletionsEndpoint,
  sanitizeModelList,
  resolveChatModels,
  resolveSummaryLLM,
  inferProviderType,
  getProviderPreset,
  inferChatApiProfile,
  resolveJsonResponseMode,
  isDeepSeekV4Model,
  resolveMaxOutputTokens,
  shouldUseXApiKeyHeader,
  buildStreamingChatPayload,
  buildConnectivityTestPayload,
} = require('../app/llm-config-utils.js');

// alias for backward compatibility in tests
const getDeepSeekPreset = (key) => getProviderPreset(key);

function testNormalizeBaseUrlForStorage() {
  assert.equal(
    normalizeBaseUrlForStorage('https://api.example.com/v1/chat/completions'),
    'https://api.example.com/v1',
  );
  assert.equal(
    normalizeBaseUrlForStorage('https://api.example.com/v1/'),
    'https://api.example.com/v1',
  );
}

function testBuildChatCompletionsEndpoint() {
  assert.equal(
    buildChatCompletionsEndpoint('https://api.example.com/v1'),
    'https://api.example.com/v1/chat/completions',
  );
  assert.equal(
    buildChatCompletionsEndpoint('https://api.example.com/custom-root'),
    'https://api.example.com/custom-root/v1/chat/completions',
  );
}

function testSanitizeModelList() {
  assert.deepEqual(
    sanitizeModelList(['deepseek-v4-flash', ' deepseek-v4-flash ', 'deepseek-v4-pro', 'custom-model', 'extra'], 3),
    ['deepseek-v4-flash', 'deepseek-v4-pro', 'custom-model'],
  );
}

function testResolveChatModelsAndSummary() {
  const secret = {
    summarizedLLM: {
      apiKey: 'sk-summary',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4.1-mini',
    },
    chatLLMs: [
      {
        apiKey: 'sk-chat',
        baseUrl: 'https://api.example.com/v1/',
        models: ['gpt-4.1-mini', 'claude-sonnet-4'],
      },
    ],
  };

  const chatModels = resolveChatModels(secret);
  assert.equal(chatModels.length, 2);
  assert.deepEqual(chatModels.map((item) => item.name), [
    'gpt-4.1-mini',
    'claude-sonnet-4',
  ]);

  const summary = resolveSummaryLLM(secret);
  assert.equal(summary.model, 'gpt-4.1-mini');
  assert.equal(summary.baseUrl, 'https://api.example.com/v1');
}

function testInferProviderType() {
  assert.equal(
    inferProviderType({
      summarizedLLM: {
        apiKey: 'sk',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
      },
    }),
    'deepseek',
  );
  assert.equal(
    inferProviderType({
      summarizedLLM: {
        apiKey: 'sk',
        baseUrl: 'https://example.com/v1',
        model: 'other-model',
      },
    }),
    'deepseek',
  );
}

function testGetDeepSeekPreset() {
  assert.deepEqual(
    getDeepSeekPreset('deepseek'),
    {
      key: 'deepseek',
      label: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek/deepseek-v4-flash',
      models: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'],
    },
  );
  assert.equal(getDeepSeekPreset('other-a'), null);
  assert.equal(getDeepSeekPreset('other-b'), null);
  assert.equal(getDeepSeekPreset('other-c'), null);
  assert.equal(getDeepSeekPreset('other-d'), null);
}

function testGetGlmPreset() {
  const preset = getProviderPreset('glm');
  assert.equal(preset.key, 'glm');
  assert.equal(preset.label, 'GLM 智谱');
  assert.equal(preset.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(preset.defaultModel, 'glm-4.7-flash');
  assert.ok(preset.models.length > 0);
  assert.ok(preset.models.includes('glm-4.7-flash'));
}

function testGetCustomPreset() {
  const preset = getProviderPreset('custom');
  assert.equal(preset.key, 'custom');
  assert.equal(preset.label, '自定义 LLM');
  assert.equal(preset.baseUrl, '');
  assert.equal(preset.defaultModel, '');
  assert.deepEqual(preset.models, []);
}

function testInferChatApiProfile() {
  assert.equal(
    inferChatApiProfile('https://api.deepseek.com', 'deepseek-v4-flash'),
    'deepseek',
  );
  assert.equal(
    inferChatApiProfile('https://open.bigmodel.cn/api/paas/v4', 'glm-4.7-flash'),
    'glm',
  );
  assert.equal(
    inferChatApiProfile('https://example.com/v1', 'other-model'),
    'custom',
  );
  assert.equal(
    inferChatApiProfile('', ''),
    'unsupported',
  );
}

function testResolveJsonResponseMode() {
  assert.equal(
    resolveJsonResponseMode({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    }),
    'json_object',
  );
  assert.equal(
    resolveJsonResponseMode({
      baseUrl: 'https://example.com/v1',
      model: 'other-model',
      preferSchema: false,
    }),
    'json_object',
  );
}

function testResolveMaxOutputTokens() {
  assert.equal(isDeepSeekV4Model('deepseek-v4-flash'), true);
  assert.equal(isDeepSeekV4Model('deepseek-v4-pro'), true);
  assert.equal(isDeepSeekV4Model('deepseek-chat'), false);
  assert.equal(
    resolveMaxOutputTokens({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    }),
    393216,
  );
  assert.equal(
    resolveMaxOutputTokens({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    }),
    393216,
  );
  assert.equal(
    resolveMaxOutputTokens({
      baseUrl: 'https://example.com/v1',
      model: 'other-model',
    }),
    null,
  );
}

function testShouldUseXApiKeyHeader() {
  assert.equal(
    shouldUseXApiKeyHeader({
      baseUrl: 'https://example.com/v1',
      model: 'other-model',
    }),
    true,
  );
  assert.equal(
    shouldUseXApiKeyHeader({
      baseUrl: 'https://example.com/v1',
      model: 'other-model',
    }),
    true,
  );
}

function testBuildStreamingChatPayload() {
  assert.deepEqual(
    buildStreamingChatPayload({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_tokens: 393216,
    },
  );

  assert.deepEqual(
    buildStreamingChatPayload({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_tokens: 393216,
    },
  );

}

function testBuildConnectivityTestPayload() {
  assert.deepEqual(
    buildConnectivityTestPayload({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    }),
    {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'Reply with exactly: hello world' },
        { role: 'user', content: 'hello world' },
      ],
      temperature: 0,
      max_tokens: 256,
    },
  );

  assert.deepEqual(
    buildConnectivityTestPayload({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    }),
    {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'Reply with exactly: hello world' },
        { role: 'user', content: 'hello world' },
      ],
      temperature: 0,
      max_tokens: 256,
    },
  );

}

testNormalizeBaseUrlForStorage();
testBuildChatCompletionsEndpoint();
testSanitizeModelList();
testResolveChatModelsAndSummary();
testInferProviderType();
testGetDeepSeekPreset();
testGetGlmPreset();
testGetCustomPreset();
testInferChatApiProfile();
testResolveJsonResponseMode();
testResolveMaxOutputTokens();
testShouldUseXApiKeyHeader();
testBuildStreamingChatPayload();
testBuildConnectivityTestPayload();

console.log('llm config utils tests passed');
