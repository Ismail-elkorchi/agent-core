import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProviderError } from '@agent-core/model';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenAICodexProvider } from '@agent-core/provider-openai-codex';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';
import { ClaudeProvider } from '@agent-core/provider-claude';
import { OllamaProvider } from '@agent-core/provider-ollama';

function fixture(name, { status, error, stream = false, fail }) {
  const model =
    name === 'claude' ? 'claude-sonnet-4-6' : name === 'openrouter' ? 'fixture/model' : 'gpt-5.6';
  const fetch = async (url) => {
    if (String(url).endsWith('/models'))
      return Response.json({
        data: [
          {
            id: model,
            context_length: 32768,
            top_provider: { context_length: 32768, max_completion_tokens: 4096 },
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            supported_parameters: ['max_tokens']
          }
        ]
      });
    fail?.();
    return stream
      ? new Response(`data: ${JSON.stringify({ error })}\n\n`, {
          headers: { 'content-type': 'text/event-stream' }
        })
      : Response.json({ error }, { status });
  };
  const providers = {
    openai: () => new OpenAIProvider({ apiKey: 'fixture', fetch }),
    'openai-codex': () =>
      new OpenAICodexProvider({
        auth: {
          type: 'bearer',
          tokenProvider: {
            describe: () => ({ type: 'oauth', provider: 'openai-codex' }),
            getBearerToken: async () => ({ token: 'fixture', metadata: { accountId: 'fixture' } })
          }
        },
        fetch
      }),
    openrouter: () => new OpenRouterProvider({ apiKey: 'fixture', fetch }),
    claude: () => new ClaudeProvider({ apiKey: 'fixture', fetch }),
    ollama: () =>
      new OllamaProvider({
        clientFactory: () => ({
          show: async () => ({
            capabilities: ['completion'],
            model_info: { 'fixture.context_length': 32768 }
          }),
          chat: async () => {
            fail?.();
            throw Object.assign(new Error(error.message), { status_code: status });
          }
        })
      })
  };
  return {
    provider: providers[name](),
    request: {
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      ...(name === 'openai-codex' ? {} : { maxOutputTokens: 100 })
    }
  };
}

for (const name of ['openai', 'openai-codex', 'openrouter', 'claude', 'ollama'])
  for (const [status, message, code, retryable] of [
    [401, 'Access token expired', 'invalid_request', false],
    [403, 'Token lacks permission for this context', 'invalid_request', false],
    [429, 'Token rate limit exceeded', 'rate_limited', true],
    [408, 'Request timed out while loading context', 'provider_unavailable', true],
    [500, 'Internal token decoder failed', 'provider_unavailable', true],
    [413, 'Uploaded image is too large', 'invalid_request', false],
    [400, 'Invalid max_tokens parameter', 'invalid_request', false]
  ])
    test(`${name}: HTTP ${status} is classified from protocol evidence`, async () => {
      const { provider, request } = fixture(name, { status, error: { message } });
      await assert.rejects(provider.complete(request), (error) => {
        assert(error instanceof ModelProviderError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert(error.message.includes(message), 'the provider explanation remains available');
        return true;
      });
    });

for (const name of ['openai', 'openai-codex', 'openrouter'])
  test(`${name}: explicit context overflow is independent of message wording`, async () => {
    const { provider, request } = fixture(name, {
      status: 400,
      error: {
        message: 'Request rejected',
        ...(name === 'openrouter'
          ? { metadata: { error_type: 'context_length_exceeded' } }
          : { code: 'context_length_exceeded' })
      }
    });
    await assert.rejects(
      provider.complete(request),
      (error) => error.code === 'context_overflow' && !error.retryable
    );
  });

for (const [status, message, metadata, code, retryable] of [
  [429, 'Token rate limit exceeded', {}, 'rate_limited', true],
  [400, 'Request rejected', { error_type: 'context_length_exceeded' }, 'context_overflow', false]
])
  test(`OpenRouter stream error preserves ${code}`, async () => {
    const { provider, request } = fixture('openrouter', {
      status,
      error: { code: status, message, metadata },
      stream: true
    });
    await assert.rejects(
      async () => {
        for await (const event of provider.stream(request)) void event;
      },
      (error) => error.code === code && error.retryable === retryable
    );
  });

for (const diagnostic of [
  { type: 'insufficient_quota' },
  { code: 'credit_balance_exhausted' },
  { code: 'organization_spend_limit_exceeded' },
  { code: 'project_spend_limit_exceeded' },
  { code: 'organization_usage_limit_exceeded' }
])
  test(`OpenAI HTTP 429 does not retry ${diagnostic.code ?? diagnostic.type}`, async () => {
    const { provider, request } = fixture('openai', {
      status: 429,
      error: {
        message: 'Account limit reached',
        ...diagnostic
      }
    });
    await assert.rejects(
      provider.complete(request),
      (error) => error.code === 'invalid_request' && !error.retryable
    );
  });

for (const name of ['openai', 'openai-codex', 'openrouter', 'ollama'])
  test(`${name}: malformed request rejection does not read transport fields from the invalid value`, async () => {
    const { provider } = fixture(name, {
      fail() {
        throw new Error('Must not dispatch');
      }
    });
    await assert.rejects(provider.complete(null), (error) => error.code === 'invalid_request');
    await assert.rejects(
      async () => {
        for await (const event of provider.stream(null)) void event;
      },
      (error) => error.code === 'invalid_request'
    );
  });

for (const name of ['openai', 'openai-codex', 'openrouter', 'claude', 'ollama'])
  for (const method of ['complete', 'stream'])
    for (const cancelled of [false, true])
      test(`${name} ${method}: ${cancelled ? 'requested cancellation preserves an arbitrary reason' : 'upstream abort prose is a transport failure'}`, async () => {
        const controller = new AbortController();
        const reason = Object.freeze(
          new Error(cancelled ? 'Stop requested' : 'Network transfer aborted by upstream')
        );
        const { provider, request } = fixture(name, {
          fail() {
            if (cancelled) controller.abort(reason);
            throw reason;
          }
        });
        await assert.rejects(
          async () => {
            const options = { signal: controller.signal };
            if (method === 'complete') await provider.complete(request, options);
            else for await (const event of provider.stream(request, options)) void event;
          },
          (error) => {
            assert(error instanceof ModelProviderError);
            assert.equal(error.code, cancelled ? 'aborted' : 'provider_unavailable');
            assert.equal(error.retryable, !cancelled);
            return true;
          }
        );
        assert.equal(reason.name, 'Error', 'cancellation must not mutate caller-owned errors');
      });
