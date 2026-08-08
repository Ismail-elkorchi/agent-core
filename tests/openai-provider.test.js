import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProviderError } from '@agent-core/model';
import { OpenAIProvider } from '@agent-core/provider-openai';

test('OpenAIProvider describes the GPT-5.6 Sol default model profile', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key' });
  assert.deepEqual(provider.describe(), {
    id: 'openai',
    displayName: 'OpenAI Responses API provider',
    defaultModel: 'gpt-5.6-sol'
  });
  const profile = await provider.describeModel('gpt-5.6-sol');
  assert.equal(profile.id, 'gpt-5.6-sol');
  assert.equal(profile.provider, 'openai');
  assert.equal(profile.capabilities.streaming, true);
  assert.equal(profile.capabilities.toolCalling, true);
  assert.equal(profile.capabilities.jsonSchema, true);
  assert.deepEqual(profile.capabilities.reasoning, {
    strategies: ['effort'],
    canDisable: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    modes: ['standard', 'pro'],
    summaries: ['auto', 'concise', 'detailed'],
    separateOutput: true
  });
  assert.deepEqual(profile.modalities.input, ['text', 'image']);
  assert.deepEqual(profile.limits, { contextTokens: 1_050_000, maxInputTokens: 922_000, outputTokens: 128_000 });
  assert.deepEqual(profile.pricing, {
    currency: 'USD',
    rates: { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
    inputTiers: [{ aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }]
  });
  assert.equal(profile.metadata.defaultReasoningEffort, 'medium');
  assert.equal(profile.metadata.defaultReasoningMode, 'standard');
  assert.equal(profile.metadata.api, 'responses');
});

test('OpenAIProvider serializes GPT-5.6 max effort and independent pro mode', async () => {
  const calls = [];
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async (_input, init) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse({ id: 'resp-sol', model: 'gpt-5.6-sol', status: 'completed', output_text: 'done' });
    }
  });

  await provider.complete({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'solve' }],
    reasoning: { strategy: 'effort', effort: 'max', mode: 'pro' }
  });
  assert.deepEqual(calls[0].reasoning, { effort: 'max', mode: 'pro' });

  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'solve' }], reasoning: { strategy: 'effort', effort: 'max' } }),
    error => error instanceof ModelProviderError && error.code === 'invalid_request' && /max/u.test(error.message)
  );
  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'solve' }], reasoning: { strategy: 'effort', effort: 'high', mode: 'pro' } }),
    error => error instanceof ModelProviderError && error.code === 'invalid_request' && /mode/u.test(error.message)
  );
  assert.equal(calls.length, 1, 'invalid capability combinations fail before network I/O');
});

test('OpenAIProvider rejects undocumented service tiers before network I/O', async () => {
  let fetchCalls = 0;
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse({ id: 'unexpected', model: 'gpt-5.6-sol', status: 'completed', output_text: 'unexpected' });
    }
  });

  await assert.rejects(
    () => provider.complete({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'solve' }],
      providerOptions: { provider: 'openai', values: { serviceTier: 'scale' } }
    }),
    error => error instanceof ModelProviderError && error.code === 'invalid_request'
  );
  assert.equal(fetchCalls, 0);
});

test('OpenAIProvider sends Responses API requests with bearer auth, tools, text.format, and item-aware input', async () => {
  const calls = [];
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({
        id: 'resp-1',
        model: 'gpt-5.6-sol',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Need a file.' }]
          },
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'read_files',
            arguments: '{"files":[{"path":"package.json"}]}'
          }
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18
        }
      });
    }
  });

  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const response = await provider.complete({
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'system', content: 'Return JSON.' },
      {
        role: 'user',
        content: 'Describe this image.',
        images: [{ type: 'base64', data: 'aW1hZ2U=', mediaType: 'image/jpeg', detail: 'original' }]
      },
      {
        role: 'assistant',
        content: 'I will inspect the file.',
        toolCalls: [
          {
            id: 'previous-call',
            type: 'function',
            name: 'read_files',
            input: { kind: 'json', value: { files: [{ path: 'README.md' }] } }
          }
        ]
      },
      {
        role: 'tool',
        toolCallId: 'previous-call',
        toolName: 'read_files',
        toolCallType: 'function',
        content: '{"ok":true}'
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_files',
          description: 'Read text files',
          parameters: {
            type: 'object',
            properties: { files: { type: 'array', items: { type: 'object' } } },
            required: ['files']
          }
        }
      }
    ],
    responseFormat: { type: 'json_schema', schema },
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 128,
    reasoning: { strategy: 'effort', effort: 'low', summary: 'concise' },
    logprobs: true,
    topLogprobs: 2,
    metadata: { runId: 'run-1' },
    providerOptions: { provider: 'openai', values: { serviceTier: 'flex', promptCacheKey: 'run-1', promptCacheOptions: { mode: 'implicit', ttl: '30m' }, reasoningContext: 'all_turns' } }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'gpt-5.6-sol');
  assert.equal(body.stream, false);
  assert.equal(body.store, true);
  assert.equal(body.instructions, 'Return JSON.');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.max_output_tokens, 128);
  assert.deepEqual(body.text, {
    format: {
      type: 'json_schema',
      name: 'agent_core_response',
      strict: true,
      schema
    }
  });
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.equal(body.input[0].content[1].type, 'input_image');
  assert.equal(body.input[0].content[1].detail, 'original');
  assert.equal(body.input[1].role, 'assistant');
  assert.deepEqual(body.input[2], {
    type: 'function_call',
    call_id: 'previous-call',
    name: 'read_files',
    arguments: '{"files":[{"path":"README.md"}]}'
  });
  assert.deepEqual(body.input[3], {
    type: 'function_call_output',
    call_id: 'previous-call',
    output: '{"ok":true}'
  });
  assert.deepEqual(body.tools[0], {
    type: 'function',
    name: 'read_files',
    description: 'Read text files',
    parameters: {
      type: 'object',
      properties: { files: { type: 'array', items: { type: 'object' } } },
      required: ['files']
    }
  });
  assert.deepEqual(body.reasoning, { effort: 'low', summary: 'concise', context: 'all_turns' });
  assert.deepEqual(body.include, ['message.output_text.logprobs']);
  assert.equal(body.top_logprobs, 2);
  assert.deepEqual(body.metadata, { runId: 'run-1' });
  assert.equal('previous_response_id' in body, false);
  assert.equal(body.service_tier, 'flex');
  assert.equal(body.prompt_cache_key, 'run-1');
  assert.deepEqual(body.prompt_cache_options, { mode: 'implicit', ttl: '30m' });

  assert.equal(response.content, '');
  assert.equal(response.reasoningSummary, 'Need a file.');
  assert.deepEqual(response.toolCalls, [
    {
      id: 'call-1',
      type: 'function',
      name: 'read_files',
      input: { kind: 'json', value: { files: [{ path: 'package.json' }] } }
    }
  ]);
  assert.deepEqual(response.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  assert.deepEqual(response.transport, {
    provider: 'openai',
    strategy: 'stored_response',
    responseId: 'resp-1',
    reusedContinuation: false
  });
});

test('OpenAIProvider sessions send only incremental tool output when continuing stored Responses state', async () => {
  const calls = [];
  const responses = [
    { id: 'resp-prev', model: 'gpt-5.5', status: 'completed', output_text: 'ready' },
    { id: 'resp-2', model: 'gpt-5.5', status: 'completed', output_text: 'done' }
  ];
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse(responses.shift());
    }
  });
  const session = provider.createSession();

  const first = await session.complete({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'Start the stored response chain.' }]
  });
  const second = await session.complete({
    model: 'gpt-5.5',
    messages: toolTranscriptMessages()
  });

  assert.equal(calls.length, 2);
  assert.equal(first.transport.responseId, 'resp-prev');
  assert.equal(first.transport.reusedContinuation, false);
  assert.equal(second.transport.responseId, 'resp-2');
  assert.equal(second.transport.reusedContinuation, true);
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.previous_response_id, 'resp-prev');
  assert.equal(body.store, true);
  assert.deepEqual(body.input.map((item) => item.type ?? item.role), [
    'function_call_output'
  ]);
  assert.equal(body.input[0].call_id, 'call-shell-2');
});

test('OpenAIProvider sessions continue after output_text-only assistant turns without replaying assistant text', async () => {
  const calls = [];
  const responses = [
    { id: 'resp-text', model: 'gpt-5.5', status: 'completed', output_text: 'ready' },
    { id: 'resp-followup', model: 'gpt-5.5', status: 'completed', output_text: 'ok' }
  ];
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse(responses.shift());
    }
  });
  const session = provider.createSession();

  const first = await session.complete({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'Summarize status.' }]
  });
  const second = await session.complete({
    model: 'gpt-5.5',
    messages: [
      { role: 'user', content: 'Summarize status.' },
      { role: 'assistant', content: 'ready' },
      { role: 'user', content: 'What next?' }
    ]
  });

  assert.equal(calls.length, 2);
  assert.equal(first.transport.responseId, 'resp-text');
  assert.equal(first.transport.reusedContinuation, false);
  assert.equal(second.transport.responseId, 'resp-followup');
  assert.equal(second.transport.reusedContinuation, true);
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.previous_response_id, 'resp-text');
  assert.deepEqual(body.input, [{ role: 'user', content: 'What next?' }]);
  assert.equal(JSON.stringify(body.input).includes('ready'), false);
  assert.deepEqual(second.providerState, {
    provider: 'openai',
    model: 'gpt-5.5',
    kind: 'openai.responses.stored_response',
    data: { responseId: 'resp-followup' }
  });
});

test('OpenAIProvider sessions restore stored response continuation state', async () => {
  const calls = [];
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({ id: 'resp-after-restore', model: 'gpt-5.5', status: 'completed', output_text: 'done' });
    }
  });
  const session = provider.createSession();
  session.restoreProviderState({
    provider: 'openai',
    model: 'gpt-5.5',
    kind: 'openai.responses.stored_response',
    data: { responseId: 'resp-restored' }
  });

  const response = await session.complete({
    model: 'gpt-5.5',
    messages: toolTranscriptMessages()
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.previous_response_id, 'resp-restored');
  assert.deepEqual(body.input.map((item) => item.type ?? item.role), ['function_call_output']);
  assert.equal(response.transport.reusedContinuation, true);
  assert.deepEqual(response.providerState, {
    provider: 'openai',
    model: 'gpt-5.5',
    kind: 'openai.responses.stored_response',
    data: { responseId: 'resp-after-restore' }
  });
});

test('OpenAIProvider stored continuation omits older long mixed shell transcript', async () => {
  const calls = [];
  const responses = [
    { id: 'resp-long-1', model: 'gpt-5.5', status: 'completed', output_text: 'ready' },
    { id: 'resp-long-2', model: 'gpt-5.5', status: 'completed', output_text: 'continued' }
  ];
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse(responses.shift());
    }
  });
  const session = provider.createSession();

  await session.complete({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'Start long shell work.' }]
  });
  const response = await session.complete({
    model: 'gpt-5.5',
    messages: longMixedShellTranscriptMessages(30)
  });

  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.previous_response_id, 'resp-long-1');
  assert.deepEqual(body.input, [{ role: 'user', content: 'Continue after many shell observations.' }]);
  assert.equal(JSON.stringify(body.input).includes('chunk-30'), false);
  assert.equal(response.transport.reusedContinuation, true);
  assert.deepEqual(response.providerState, {
    provider: 'openai',
    model: 'gpt-5.5',
    kind: 'openai.responses.stored_response',
    data: { responseId: 'resp-long-2' }
  });
});

test('OpenAIProvider continuation rejection reports reused stored response id', async () => {
  const calls = [];
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async (_input, init) => {
      calls.push({ init });
      return calls.length === 1
        ? jsonResponse({ id: 'resp-stale', model: 'gpt-5.5', status: 'completed', output_text: 'ready' })
        : jsonResponse({ error: { message: 'previous response was rejected' } }, { status: 400 });
    }
  });
  const session = provider.createSession();

  await session.complete({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'Start.' }]
  });

  await assert.rejects(
    () => session.complete({ model: 'gpt-5.5', messages: longMixedShellTranscriptMessages(4) }),
    (error) => {
      assert.equal(error instanceof ModelProviderError, true);
      assert.equal(error.code, 'invalid_request');
      assert.equal(error.diagnostic.transport, 'http');
      assert.equal(error.diagnostic.causeSummary.status, 400);
      assert.equal(error.diagnostic.causeSummary.errorMessage, 'previous response was rejected');
      assert.equal(error.diagnostic.causeSummary.previousResponseId, 'resp-stale');
      assert.equal(error.diagnostic.causeSummary.reusedContinuation, true);
      assert.equal(error.diagnostic.causeSummary.continuationStrategy, 'stored_response');
      return true;
    }
  );
});

test('OpenAIProvider streams typed content, reasoning, tool calls, and final response metadata', async () => {
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async () => sseResponse([
      { type: 'response.reasoning_summary_text.delta', delta: 'plan ' },
      { type: 'response.output_text.delta', delta: 'hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call-2',
          name: 'list_directory',
          arguments: '{"path":"."}'
        }
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp-2',
          model: 'gpt-5.5',
          status: 'completed',
          output_text: 'hello',
          output: [
            {
              type: 'function_call',
              call_id: 'call-2',
              name: 'list_directory',
              arguments: '{"path":"."}'
            }
          ],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
        }
      }
    ])
  });

  const events = [];
  for await (const event of provider.stream({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(event);
  }

  assert.deepEqual(events.filter((event) => event.type === 'content').map((event) => event.content), ['hel', 'lo']);
  assert.deepEqual(events.filter((event) => event.type === 'reasoning').map((event) => event.reasoning), ['plan ']);
  assert.deepEqual(events.filter((event) => event.type === 'reasoning').map((event) => event.channel), ['summary']);
  assert.deepEqual(events.filter((event) => event.type === 'tool_call').map((event) => event.toolCall.name), ['list_directory']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.response.content, 'hello');
  assert.equal(done.response.reasoningSummary, 'plan ');
  assert.deepEqual(done.response.toolCalls, [
    {
      id: 'call-2',
      type: 'function',
      name: 'list_directory',
      input: { kind: 'json', value: { path: '.' } }
    }
  ]);
  assert.deepEqual(done.response.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.deepEqual(done.response.transport, {
    provider: 'openai',
    strategy: 'stored_response',
    responseId: 'resp-2',
    reusedContinuation: false
  });
});

test('OpenAIProvider summarizes failed stream events without error bodies', async () => {
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async () => sseResponse([
      {
        type: 'response.failed',
        response: {
          id: 'resp-failed',
          model: 'gpt-5.5',
          status: 'failed',
          incomplete_details: { reason: 'server_shutdown' }
        }
      }
    ])
  });

  await assert.rejects(
    async () => {
      for await (const _event of provider.stream({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })) {
        // Consume stream.
      }
    },
    (error) => {
      assert.equal(error instanceof ModelProviderError, true);
      assert.match(error.message, /event=response.failed/);
      assert.equal(error.diagnostic.transport, 'http_sse');
      assert.equal(error.diagnostic.eventType, 'response.failed');
      assert.equal(error.diagnostic.causeSummary.responseId, 'resp-failed');
      assert.equal(error.diagnostic.causeSummary.incompleteReason, 'server_shutdown');
      return true;
    }
  );
});

test('OpenAIProvider preserves accumulated streamed content when completed payload has no visible text', async () => {
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async () => sseResponse([
      { type: 'response.output_text.delta', delta: 'visible ' },
      { type: 'response.output_text.delta', delta: 'text' },
      {
        type: 'response.completed',
        response: {
          id: 'resp-empty',
          model: 'gpt-5.5',
          status: 'completed',
          output: []
        }
      }
    ])
  });

  const events = [];
  for await (const event of provider.stream({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(event);
  }

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.response.content, 'visible text');
});

test('OpenAIProvider fails before fetch when API credentials are missing', async () => {
  let calls = 0;
  const provider = new OpenAIProvider({
    auth: { type: 'api_key', envVar: 'OPENAI_API_KEY', value: '' },
    fetch: async () => {
      calls += 1;
      return jsonResponse({});
    }
  });

  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error instanceof ModelProviderError && error.code === 'invalid_request' && /credentials/.test(error.message)
  );
  assert.equal(calls, 0);
});

test('OpenAIProvider invalidates cached credentials after 401 responses', async () => {
  let invalidated = false;
  const provider = new OpenAIProvider({
    auth: {
      type: 'bearer',
      tokenProvider: {
        describe() {
          return { type: 'bearer', label: 'test bearer' };
        },
        async getBearerToken() {
          return { token: 'bad-token' };
        },
        async invalidate() {
          invalidated = true;
        }
      }
    },
    fetch: async () => jsonResponse({ error: { message: 'unauthorized' } }, { status: 401 })
  });

  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error instanceof ModelProviderError && error.code === 'invalid_request'
  );
  assert.equal(invalidated, true);
});

test('OpenAIProvider rejects malformed tool call arguments', async () => {
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async () => jsonResponse({
      id: 'resp-bad',
      model: 'gpt-5.5',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call-bad',
          name: 'read_files',
          arguments: '{bad json}'
        }
      ]
    })
  });

  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error instanceof ModelProviderError && error.code === 'malformed_response'
  );
});

test('OpenAIProvider classifies HTTP errors', async () => {
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async () => jsonResponse({ error: { message: 'rate limit' } }, { status: 429 })
  });

  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error instanceof ModelProviderError && error.code === 'rate_limited' && error.retryable === true
  );
});

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('OpenAIProvider preserves visible output from an incomplete response as output-limit content', async () => {
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    fetch: async () => sseResponse([
      { type: 'response.output_text.delta', delta: 'partial answer' },
      { type: 'response.incomplete', response: { id: 'resp-partial', model: 'gpt-5.6-sol', status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } } }
    ])
  });
  const events = [];
  for await (const event of provider.stream({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'answer' }] })) events.push(event);
  assert.equal(events.at(-1).response.content, 'partial answer');
  assert.equal(events.at(-1).response.terminationReason, 'output_limit');
  assert.equal(events.at(-1).response.providerTerminationReason, 'max_output_tokens');
});

test('OpenAIProvider rejects request/profile contradictions before network I/O', async () => {
  let fetchCalls = 0;
  const provider = new OpenAIProvider({ apiKey: 'test-key', fetch: async () => { fetchCalls += 1; return jsonResponse({}); } });
  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'answer' }], reasoning: { strategy: 'effort', effort: 'minimal' } }),
    error => error instanceof ModelProviderError && error.code === 'invalid_request'
  );
  assert.equal(fetchCalls, 0);
});

function toolTranscriptMessages() {
  return [
    { role: 'system', content: 'Use tools.' },
    { role: 'user', content: 'Inspect the workspace.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-shell-1',
          type: 'function',
          name: 'exec_command',
          input: { kind: 'json', value: { command: 'pwd' } }
        }
      ]
    },
    {
      role: 'tool',
      toolCallType: 'function',
      toolCallId: 'call-shell-1',
      toolName: 'exec_command',
      content: '{"ok":true,"results":{"stdout":{"text":"/tmp/project\\n"}}}'
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-shell-2',
          type: 'function',
          name: 'exec_command',
          input: { kind: 'json', value: { command: 'ls' } }
        }
      ]
    },
    {
      role: 'tool',
      toolCallType: 'function',
      toolCallId: 'call-shell-2',
      toolName: 'exec_command',
      content: '{"ok":true,"results":{"stdout":{"text":"README.md\\n"}}}'
    }
  ];
}

function longMixedShellTranscriptMessages(turns) {
  const messages = [
    { role: 'system', content: 'Use tools.' },
    { role: 'user', content: 'Inspect with many shell commands.' }
  ];
  for (let index = 1; index <= turns; index += 1) {
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: `call-shell-${String(index)}`,
          type: 'function',
          name: 'exec_command',
          input: { kind: 'json', value: { command: `printf chunk-${String(index)}` } }
        }
      ]
    });
    messages.push({
      role: 'tool',
      toolCallType: 'function',
      toolCallId: `call-shell-${String(index)}`,
      toolName: 'exec_command',
      content: JSON.stringify({
        ok: true,
        results: {
          command: `printf chunk-${String(index)}`,
          stdout: { text: `chunk-${String(index)}\n${'x'.repeat(600)}` },
          stderr: { text: '' },
          status: { exitCode: 0 }
        }
      })
    });
    messages.push({
      role: 'assistant',
      content: `Observed shell chunk ${String(index)}.`
    });
  }
  messages.push({ role: 'user', content: 'Continue after many shell observations.' });
  return messages;
}

function sseResponse(chunks) {
  const body = [
    ': OPENAI PROCESSING',
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`),
    'data: [DONE]'
  ].join('\n\n');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' }
  });
}
