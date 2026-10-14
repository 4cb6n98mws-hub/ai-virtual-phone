import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the actual request builders with mocked I/O; never call a paid API.
function load(relativePath, dependencies, names) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const js = stripTypeScriptTypes(source, { mode: 'transform' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, '')
    .replace(/^export\s+/gm, '');
  return new Function(...Object.keys(dependencies), `${js}\nreturn {${names.join(',')}};`)(...Object.values(dependencies));
}
const helpers = load('../lib/api-helpers.ts', { pushApiLog() {} }, ['simpleLLMCall', 'normalizeOpenAIChatParameters', 'buildChatCompletionsUrl', 'buildRequestHeaders', 'determineBaseUrl', 'isNativeAnthropicApi', 'isNativeGoogleApi', 'stripHallucinatedTimestamps']);
const parameters = load('../lib/generation-parameters.ts', {}, ['resolveEnabledGenerationParameters']);
const adapter = load('../lib/llm-provider-adapter.ts', { ...helpers, ...parameters }, ['buildProviderRequest']);
const base = { provider: 'OpenAI', defaultModel: 'gpt-6.1-sol', apiKey: 'test-only-not-a-real-key' };
const messages = [{ role: 'user', content: 'hello' }];
for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5', 'gpt-5.1', 'o3', 'o4-mini', 'openai/gpt-6.1-sol']) {
  const request = adapter.buildProviderRequest({ ...base, defaultModel: model }, null, messages, { maxTokens: 4096 });
  assert.equal(request.body.max_completion_tokens, 4096, model);
  assert(!('max_tokens' in request.body), model);
}
for (const model of ['deepseek-flash', 'deepseek-reasoner', 'gpt-4o', 'gpt-4.1', 'custom-model']) {
  const request = adapter.buildProviderRequest({ ...base, defaultModel: model }, null, messages, { maxTokens: 512 });
  assert.equal(request.body.max_tokens, 512, model);
  assert(!('max_completion_tokens' in request.body), model);
}
const preset = { openai_max_tokens: 1024, enabled_generation_parameters: ['max_tokens'] };
assert.equal(adapter.buildProviderRequest(base, preset, messages).body.max_completion_tokens, 1024);
assert.equal(adapter.buildProviderRequest(base, preset, messages, { maxTokens: 2048 }).body.max_completion_tokens, 2048);
assert(!('max_completion_tokens' in adapter.buildProviderRequest(base, { ...preset, enabled_generation_parameters: [] }, messages, { maxTokens: 4096 }).body));
assert(!('max_completion_tokens' in adapter.buildProviderRequest(base, null, messages).body));
assert.equal(helpers.normalizeOpenAIChatParameters({ max_tokens: 8, max_completion_tokens: 16 }, 'gpt-6.1-sol').max_completion_tokens, 16);
const anthropic = adapter.buildProviderRequest({ ...base, provider: 'Anthropic', defaultModel: 'claude-test' }, null, messages, { maxTokens: 512 });
assert.equal(anthropic.body.max_tokens, 512);
// GPT-6 reasoning requests omit unsupported sampling controls in both paths.
const sampling = { temperature: 0.2, top_p: 0.9, top_logprobs: 3, logprobs: true, frequency_penalty: 0, presence_penalty: 0, top_k: 5, top_a: 0.1, min_p: 0.1, repetition_penalty: 1.1 };
const normalized = helpers.normalizeOpenAIChatParameters({ ...sampling, model: 'gpt-6.1-sol' }, 'gpt-6.1-sol');
for (const key of Object.keys(sampling)) assert(!(key in normalized), key);
assert.equal(sampling.temperature, 0.2, 'normalization does not mutate preset data');
const normalChat = adapter.buildProviderRequest(base, { temperature: 0.8, top_p: 1, frequency_penalty: 0, presence_penalty: 0 }, messages).body;
assert(!('temperature' in normalChat)); assert(!('top_p' in normalChat));
assert.equal(helpers.normalizeOpenAIChatParameters({ temperature: 0.4 }, 'deepseek-flash').temperature, 0.4);
assert.equal(helpers.normalizeOpenAIChatParameters({ temperature: 0.4, reasoning_effort: 'none' }, 'gpt-6-luna').temperature, 0.4);
assert(!('temperature' in helpers.normalizeOpenAIChatParameters({ temperature: 0.4, reasoning_effort: 'none' }, 'gpt-6.1-sol')));
const originalFetch = globalThis.fetch;
try {
  for (const [model, expected] of [['gpt-6.1-sol', 'max_completion_tokens'], ['deepseek-flash', 'max_tokens']]) {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body[expected], 4096);
      if (model === 'gpt-6.1-sol') assert(!('temperature' in body));
      else assert.equal(body.temperature, 0.2);
      assert(!((expected === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens') in body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }), { status: 200 });
    };
    assert.equal((await helpers.simpleLLMCall({ ...base, defaultModel: model }, messages, { max_tokens: 4096, temperature: 0.2 })).content, 'hello');
  }
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: connection-test helper, chat request builder, reasoning/legacy model families, preset limits, disabled limits, and Anthropic compatibility. No network requests made.');
