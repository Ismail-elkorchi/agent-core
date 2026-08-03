import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProviderError, parseModelProfile, parseModelResponse, parseModelStreamEvent } from '@agent-core/model';
import { OllamaProvider } from '@agent-core/provider-ollama';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenAICodexProvider } from '@agent-core/provider-openai-codex';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';

const request = { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] };

for (const adapter of [ollamaAdapter(), openAIAdapter(), openAICodexAdapter(), openRouterAdapter()]) {
  test(`${adapter.name} passes the shared provider conformance kit`, async () => {
    const provider = adapter.create();
    const profile = parseModelProfile(await provider.describeModel(adapter.model));
    assert.equal(profile.provider, provider.id);

    const complete = parseModelResponse(await provider.complete({ ...request, model: adapter.model }));
    assert.equal(complete.content, 'hello');
    assert.equal(complete.terminationReason, 'stop');
    assertUsage(complete.usage);

    const events = [];
    for await (const raw of provider.stream({ ...request, model: adapter.model })) events.push(parseModelStreamEvent(raw));
    assert.equal(events.filter(event => event.type === 'done').length, 1, 'stream has exactly one terminal event');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).response.content, complete.content, 'streamed and non-streamed visible content normalizes equivalently');
    assertUsage(events.at(-1).response.usage);
    assert.ok(events.filter(event => event.type === 'content').map(event => event.content).join('').length > 0, 'visible content is accumulated');

    const session = provider.createSession?.();
    if (session) {
      const disposition = session.retryDisposition(new Error('conformance failure'));
      assert.ok(['reusable', 'reset_required', 'unknown'].includes(disposition), 'session declares a valid retry disposition');
      assert.equal(disposition, adapter.sessionRetryDisposition, 'adapter exposes its conservative continuation policy');
      session.resetContinuation?.('conformance reset');
      await session.close?.();
    } else {
      assert.equal(adapter.sessionRetryDisposition, undefined, 'stateless adapter does not claim continuation reuse');
    }

    const controller = new AbortController();
    controller.abort('conformance abort');
    await assert.rejects(async () => {
      for await (const _event of provider.stream({ ...request, model: adapter.model, signal: controller.signal })) { /* consume */ }
    }, error => error instanceof ModelProviderError && error.code === 'aborted');

    await assert.rejects(
      () => adapter.createMalformed().complete({ ...request, model: adapter.model }),
      error => error instanceof ModelProviderError && error.code === 'malformed_response',
      'malformed tool arguments never cross the provider boundary'
    );

    await assert.rejects(
      () => adapter.createMalformedUsage().complete({ ...request, model: adapter.model }),
      error => error instanceof ModelProviderError && error.code === 'malformed_response',
      'invalid usage never crosses the provider boundary'
    );
  });
}

function ollamaAdapter() {
  return {
    name: 'OllamaProvider', model: 'llama-test', sessionRetryDisposition: undefined,
    create() {
      return new OllamaProvider({ clientFactory: () => ({
        async chat(input) {
          if (input.signal?.aborted) throw new Error('aborted');
          return (async function* () {
            yield { model: input.model, message: { role: 'assistant', content: 'hel' }, done: false };
            yield { model: input.model, message: { role: 'assistant', content: 'lo' }, done: true, done_reason: 'stop', prompt_eval_count: 2, eval_count: 1 };
          })();
        },
        async show() { return { capabilities: ['completion'], model_info: { 'test.context_length': 16000 } }; },
        abort() {}
      }) });
    },
    createMalformed() {
      return new OllamaProvider({ clientFactory: () => ({
        async chat() { return (async function* () { yield { model: 'llama-test', message: { content: '', tool_calls: [{ function: { name: 'bad', arguments: 'not-an-object' } }] }, done: true }; })(); },
        async show() { return { capabilities: ['completion', 'tools'], model_info: { 'test.context_length': 16000 } }; },
        abort() {}
      }) });
    },
    createMalformedUsage() {
      return new OllamaProvider({ clientFactory: () => ({
        async chat() { return (async function* () { yield { model: 'llama-test', message: { content: 'hello' }, done: true, done_reason: 'stop', prompt_eval_count: -1, eval_count: 1 }; })(); },
        async show() { return { capabilities: ['completion'], model_info: { 'test.context_length': 16000 } }; },
        abort() {}
      }) });
    }
  };
}

function openAIAdapter() {
  return {
    name: 'OpenAIProvider', model: 'gpt-test', sessionRetryDisposition: 'reset_required',
    create() {
      return new OpenAIProvider({ apiKey: 'test', modelProfiles: { 'gpt-test': testModelProfile() }, fetch: async (_url, init) => {
        if (init.signal?.aborted) throw new Error('aborted');
        const body = JSON.parse(init.body);
        const final = openAIFinal('gpt-test');
        return body.stream ? sse([
          { type: 'response.created', response: { id: 'resp', model: 'gpt-test', status: 'in_progress', output: [] } },
          { type: 'response.output_text.delta', delta: 'hello' },
          { type: 'response.completed', response: final }
        ]) : json(final);
      } });
    },
    createMalformed() {
      return new OpenAIProvider({ apiKey: 'test', modelProfiles: { 'gpt-test': testModelProfile() }, fetch: async () => json({ id: 'bad', model: 'gpt-test', status: 'completed', output: [{ type: 'function_call', name: 'bad', arguments: '{' }] }) });
    },
    createMalformedUsage() {
      return new OpenAIProvider({ apiKey: 'test', modelProfiles: { 'gpt-test': testModelProfile() }, fetch: async () => json({ ...openAIFinal('gpt-test'), usage: { input_tokens: -1, output_tokens: 1, total_tokens: 0 } }) });
    }
  };
}

function openAICodexAdapter() {
  return {
    name: 'OpenAICodexProvider', model: 'gpt-test', sessionRetryDisposition: 'reset_required',
    create() {
      return new OpenAICodexProvider({
        modelProfiles: { 'gpt-test': testModelProfile() },
        auth: { describe() { return { type: 'bearer', label: 'test' }; }, async getBearerToken() { return { token: codexToken() }; }, async invalidate() {} },
        fetch: async (_url, init) => {
          if (init.signal?.aborted) throw new Error('aborted');
          const chunks = [
            { type: 'response.created', response: { id: 'resp', model: 'gpt-test', status: 'in_progress', output: [] } },
            { type: 'response.output_text.delta', delta: 'hello' },
            { type: 'response.completed', response: openAIFinal('gpt-test') }
          ];
          return JSON.parse(init.body).stream ? sse(chunks) : json(openAIFinal('gpt-test'));
        }
      });
    },
    createMalformed() {
      return new OpenAICodexProvider({
        modelProfiles: { 'gpt-test': testModelProfile() },
        auth: { describe() { return { type: 'bearer', label: 'test' }; }, async getBearerToken() { return { token: codexToken() }; }, async invalidate() {} },
        fetch: async () => json({ id: 'bad', model: 'gpt-test', status: 'completed', output: [{ type: 'function_call', name: 'bad', arguments: '{' }] })
      });
    },
    createMalformedUsage() {
      return new OpenAICodexProvider({
        modelProfiles: { 'gpt-test': testModelProfile() },
        auth: { describe() { return { type: 'bearer', label: 'test' }; }, async getBearerToken() { return { token: codexToken() }; }, async invalidate() {} },
        fetch: async () => json({ ...openAIFinal('gpt-test'), usage: { input_tokens: -1, output_tokens: 1, total_tokens: 0 } })
      });
    }
  };
}

function openRouterAdapter() {
  return {
    name: 'OpenRouterProvider', model: 'openai/test', sessionRetryDisposition: undefined,
    create() {
      return new OpenRouterProvider({ apiKey: 'test', fetch: async (_url, init) => {
        if (!init?.body) return json({ data: [{ id: 'openai/test', name: 'Test', context_length: 16_000, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, top_provider: { context_length: 16_000, max_completion_tokens: 2_000 }, supported_parameters: ['tools', 'max_tokens'] }] });
        if (init.signal?.aborted) throw new Error('aborted');
        const body = JSON.parse(init.body);
        const final = { id: 'gen', model: 'openai/test', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
        return body.stream ? sse([
          { id: 'gen', model: 'openai/test', choices: [{ finish_reason: null, delta: { content: 'hello' } }] },
          { id: 'gen', model: 'openai/test', choices: [{ finish_reason: 'stop', delta: {} }], usage: final.usage }
        ]) : json(final);
      } });
    },
    createMalformed() {
      return new OpenRouterProvider({ apiKey: 'test', fetch: async (_url, init) => !init?.body
        ? json({ data: [{ id: 'openai/test', name: 'Test', context_length: 16_000, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, top_provider: { context_length: 16_000, max_completion_tokens: 2_000 }, supported_parameters: ['tools', 'max_tokens'] }] })
        : json({ id: 'bad', model: 'openai/test', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'bad', arguments: '{' } }] } }] }) });
    },
    createMalformedUsage() {
      return new OpenRouterProvider({ apiKey: 'test', fetch: async (_url, init) => !init?.body
        ? json({ data: [{ id: 'openai/test', name: 'Test', context_length: 16_000, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, top_provider: { context_length: 16_000, max_completion_tokens: 2_000 }, supported_parameters: ['max_tokens'] }] })
        : json({ id: 'bad-usage', model: 'openai/test', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 } }) });
    }
  };
}

function openAIFinal(model) {
  return { id: 'resp', model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
}
function testModelProfile() {
  return {
    displayName: 'Conformance test model',
    capabilities: {
      streaming: true,
      toolCalling: true,
      supportedToolInputs: [{ kind: 'json' }, { kind: 'text' }, { kind: 'grammar', syntax: 'lark' }],
      jsonMode: true,
      jsonSchema: true,
      logprobs: false,
      temperature: false,
      topP: false
    },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 16_000, maxInputTokens: 14_000, outputTokens: 2_000 },
    supportedParameters: ['responseFormat', 'tools', 'metadata', 'providerOptions'],
    metadata: { source: 'provider-conformance-test' }
  };
}
function assertUsage(usage) { assert.ok(usage); for (const value of Object.values(usage)) assert.ok(Number.isFinite(value) && value >= 0); }
function json(body) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); }
function sse(chunks) { return new Response([...chunks.map(chunk => `data: ${JSON.stringify(chunk)}`), 'data: [DONE]'].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } }); }
function codexToken() { return `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.signature`; }
