import { ClaudeProvider } from '@agent-core/provider-claude';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProviderError, parseModelProfile, parseModelResponse, parseModelStreamEvent } from '@agent-core/model';
import { OllamaProvider } from '@agent-core/provider-ollama';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenAICodexProvider } from '@agent-core/provider-openai-codex';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';


for (const adapter of [ollamaAdapter(), openAIAdapter(), openAICodexAdapter(), openRouterAdapter(), claudeAdapter()]) {
  test(`${adapter.name} passes the shared provider conformance kit`, async () => {
    const provider = adapter.create();
    const profile = parseModelProfile(await provider.describeModel(adapter.model));
    assert.equal(profile.provider, provider.id);
    const allowance = profile.supportedParameters.includes('maxOutputTokens') ? { maxOutputTokens: 64 } : {};
    const request = { model: adapter.model, messages: [{ role: 'user', content: 'hello' }], ...allowance };

    const complete = parseModelResponse(await provider.complete({ ...request, model: adapter.model }));
    assert.equal(complete.content, 'hello');
    assert.equal(complete.terminationReason, 'stop');
    assertUsage(complete.usage);

    const compiled = await provider.compileRequest({ ...request, model: adapter.model });
    const originalBody = compiled.body;
    const cancelledTransport = new AbortController();
    cancelledTransport.abort();
    await assert.rejects(() => provider.completeCompiled(compiled, { signal: cancelledTransport.signal }), error => error instanceof ModelProviderError && error.code === 'aborted');
    await assert.rejects(async () => {
      for await (const event of provider.streamCompiled(compiled, { signal: cancelledTransport.signal })) void event;
    }, error => error instanceof ModelProviderError && error.code === 'aborted');
    const compiledSession = provider.createSession?.();
    if (compiledSession?.completeCompiled) {
      await assert.rejects(() => compiledSession.completeCompiled(compiled, { signal: cancelledTransport.signal }), error => error instanceof ModelProviderError && error.code === 'aborted');
      await compiledSession.close?.();
    }
    assert.equal((await provider.completeCompiled(compiled)).content, 'hello', 'transport cancellation does not invalidate immutable admission');
    assert.equal(compiled.body, originalBody);
    assert(Object.isFrozen(compiled));
    await assert.rejects(async () => provider.completeCompiled({ ...compiled }), /compiled|admitted|Unrecognized/iu);

    const imageResult = parseModelResponse(await provider.complete({ ...toolImageRequest(adapter.model), ...allowance }));
    assert.equal(imageResult.terminationReason, 'stop', 'a view_image tool result may carry its image into the next provider request');

    const events = [];
    for await (const raw of provider.stream({ ...request, model: adapter.model })) events.push(parseModelStreamEvent(raw));
    assert.equal(events.filter(event => event.type === 'done').length, 1, 'stream has exactly one terminal event');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).response.content, complete.content, 'streamed and non-streamed visible content normalizes equivalently');
    assertUsage(events.at(-1).response.usage);
    assert.ok(events.filter(event => event.type === 'content').map(event => event.content).join('').length > 0, 'visible content is accumulated');

    const session = provider.createSession?.();
    if (session) {
      session.resetContinuation?.('conformance reset');
      await session.close?.();
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

test('provider request decoding owns input before asynchronous profile validation', async () => {
  let sent;
  const provider = new OpenAIProvider({
    apiKey: 'test',
    modelProfiles: { 'gpt-test': testModelProfile() },
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return json(openAIFinal('gpt-test'));
    }
  });
  const request = { model: 'gpt-test', messages: [{ role: 'user', content: 'before' }] };
  const completion = provider.complete(request);
  request.messages[0].content = 'after';
  await completion;
  assert.match(JSON.stringify(sent.input), /before/u);
  assert.doesNotMatch(JSON.stringify(sent.input), /after/u);
});

function ollamaAdapter() {
  return {
    name: 'OllamaProvider', model: 'llama-test',
    create() {
      return new OllamaProvider({ clientFactory: () => ({
        async chat(input) {
          if (input.signal?.aborted) throw new Error('aborted');
          return (async function* () {
            yield { model: input.model, message: { role: 'assistant', content: 'hel' }, done: false };
            yield { model: input.model, message: { role: 'assistant', content: 'lo' }, done: true, done_reason: 'stop', prompt_eval_count: 2, eval_count: 1 };
          })();
        },
        async show() { return { capabilities: ['completion', 'tools', 'vision'], model_info: { 'test.context_length': 16000 } }; },
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
    name: 'OpenAIProvider', model: 'gpt-test',
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
    name: 'OpenAICodexProvider', model: 'gpt-test',
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
          assert.equal(JSON.parse(init.body).stream, true);
          return sse(chunks);
        }
      });
    },
    createMalformed() {
      return new OpenAICodexProvider({
        modelProfiles: { 'gpt-test': testModelProfile() },
        auth: { describe() { return { type: 'bearer', label: 'test' }; }, async getBearerToken() { return { token: codexToken() }; }, async invalidate() {} },
        fetch: async () => sse([{ type: 'response.completed', response: { id: 'bad', model: 'gpt-test', status: 'completed', output: [{ type: 'function_call', name: 'bad', arguments: '{' }] } }])
      });
    },
    createMalformedUsage() {
      return new OpenAICodexProvider({
        modelProfiles: { 'gpt-test': testModelProfile() },
        auth: { describe() { return { type: 'bearer', label: 'test' }; }, async getBearerToken() { return { token: codexToken() }; }, async invalidate() {} },
        fetch: async () => sse([{ type: 'response.completed', response: { ...openAIFinal('gpt-test'), usage: { input_tokens: -1, output_tokens: 1, total_tokens: 0 } } }])
      });
    }
  };
}

function openRouterAdapter() {
  return {
    name: 'OpenRouterProvider', model: 'openai/test',
    create() {
      return new OpenRouterProvider({ apiKey: 'test', fetch: async (_url, init) => {
        if (!init?.body) return json({ data: [{ id: 'openai/test', name: 'Test', context_length: 16_000, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, top_provider: { context_length: 16_000, max_completion_tokens: 2_000 }, supported_parameters: ['tools', 'max_tokens'] }] });
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
    modalities: { input: ['text', 'image'], output: ['text'] },
    limits: { contextTokens: 16_000, maxInputTokens: 14_000, outputTokens: 2_000 },
    supportedParameters: ['responseFormat', 'tools', 'metadata', 'providerOptions'],
    metadata: { source: 'provider-conformance-test' }
  };
}
function toolImageRequest(model) {
  return {
    model,
    messages: [
      { role: 'user', content: 'Inspect the image.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'image-call', name: 'view_image', type: 'function', input: { kind: 'json', value: { path: 'image.png' } } }] },
      { role: 'tool', content: 'Loaded image image.png.', toolName: 'view_image', toolCallId: 'image-call', toolCallType: 'function', images: [{ type: 'base64', data: 'iVBORw0KGgo=', mediaType: 'image/png', detail: 'original' }] }
    ]
  };
}
function assertUsage(usage) { assert.ok(usage); for (const value of Object.values(usage)) assert.ok(Number.isFinite(value) && value >= 0); }
function json(body) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); }
function sse(chunks) { return new Response([...chunks.map(chunk => `data: ${JSON.stringify(chunk)}`), 'data: [DONE]'].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } }); }
function codexToken() { return `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.signature`; }

function claudeAdapter() {
  const message = { id: 'msg-conformance', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 2, output_tokens: 1 } };
  return {
    name: 'ClaudeProvider', model: 'claude-sonnet-4-6',
    create() { return new ClaudeProvider({ apiKey: 'test', fetch: async (_url, init) => JSON.parse(init.body).stream ? sse([
      { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' }
    ]) : json(message) }); },
    createMalformed() { return new ClaudeProvider({ apiKey: 'test', fetch: async () => json({ ...message, content: [{ type: 'tool_use', id: 'bad', name: 'bad', input: 'not-json-object' }] }) }); },
    createMalformedUsage() { return new ClaudeProvider({ apiKey: 'test', fetch: async () => json({ ...message, usage: { input_tokens: -1, output_tokens: 1 } }) }); }
  };
}
