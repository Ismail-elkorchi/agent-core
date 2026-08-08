import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProviderError } from '@agent-core/model';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';

test('OpenRouterProvider describes selected models from the model catalog', async () => {
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    fetch: fakeFetch([
      jsonResponse({
        data: [
          {
            id: 'openai/gpt-test',
            name: 'GPT Test',
            context_length: 131072,
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['text']
            },
            pricing: {
              prompt: '0.000001',
              completion: '0.000004',
              input_cache_read: '0.0000001'
            },
            top_provider: {
              context_length: 65536,
              max_completion_tokens: 8192
            },
            supported_parameters: [
              'include_reasoning',
              'logprobs',
              'max_tokens',
              'reasoning',
              'response_format',
              'structured_outputs',
              'temperature',
              'tools',
              'top_logprobs',
              'top_p'
            ],
            reasoning: {
              supported_efforts: ['high', 'medium', 'low'],
              supports_max_tokens: true
            }
          }
        ]
      })
    ])
  });

  assert.deepEqual(provider.describe(), {
    id: 'openrouter',
    displayName: 'OpenRouter model provider',
    defaultModel: 'openrouter/auto'
  });

  const profile = await provider.describeModel('openai/gpt-test');
  assert.equal(profile.id, 'openai/gpt-test');
  assert.equal(profile.provider, 'openrouter');
  assert.equal(profile.displayName, 'GPT Test');
  assert.equal(profile.capabilities.streaming, true);
  assert.equal(profile.capabilities.toolCalling, true);
  assert.equal(profile.capabilities.jsonMode, true);
  assert.equal(profile.capabilities.jsonSchema, true);
  assert.equal(profile.capabilities.reasoning.separateOutput, true);
  assert.deepEqual(profile.capabilities.reasoning.strategies, ['toggle', 'effort', 'budget']);
  assert.deepEqual(profile.capabilities.reasoning.efforts, ['high', 'medium', 'low']);
  assert.deepEqual(profile.modalities.input, ['text', 'image']);
  assert.deepEqual(profile.limits, { contextTokens: 65536, maxInputTokens: 57344, outputTokens: 8192 });
  assert.equal(profile.pricing.rates.input, 1);
  assert.equal(profile.pricing.rates.output, 4);
  assert.equal(profile.pricing.rates.cacheRead, 0.09999999999999999);
  assert.equal(profile.supportedParameters.includes('maxOutputTokens'), true);
  assert.equal(profile.supportedParameters.includes('topP'), true);
  assert.deepEqual(profile.metadata.wireSupportedParameters, [
    'include_reasoning', 'logprobs', 'max_tokens', 'reasoning', 'response_format', 'structured_outputs',
    'temperature', 'tools', 'top_logprobs', 'top_p'
  ]);
});

test('OpenRouterProvider derives structured output and reasoning controls from explicit catalog capabilities', async () => {
  const records = [
    {
      ...catalogRecord('catalog/response-format-only'),
      supported_parameters: ['reasoning', 'response_format'],
      reasoning: { supported_efforts: ['low'], mandatory: true }
    },
    {
      ...catalogRecord('catalog/all-efforts'),
      supported_parameters: ['reasoning', 'structured_outputs'],
      reasoning: { supported_efforts: null, supports_max_tokens: true }
    }
  ];
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    fetch: async () => jsonResponse({ data: records })
  });

  const responseFormatOnly = await provider.describeModel('catalog/response-format-only');
  assert.equal(responseFormatOnly.capabilities.jsonMode, true);
  assert.equal(responseFormatOnly.capabilities.jsonSchema, false);
  assert.deepEqual(responseFormatOnly.capabilities.reasoning.strategies, ['toggle', 'effort']);
  assert.equal(responseFormatOnly.capabilities.reasoning.canDisable, false);

  const allEfforts = await provider.describeModel('catalog/all-efforts');
  assert.equal(allEfforts.capabilities.jsonMode, false);
  assert.equal(allEfforts.capabilities.jsonSchema, true);
  assert.deepEqual(allEfforts.capabilities.reasoning.strategies, ['toggle', 'effort', 'budget']);
  assert.deepEqual(allEfforts.capabilities.reasoning.efforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('OpenRouterProvider uses reasoning.exclude and never emits the deprecated include_reasoning alias', async () => {
  const calls = [];
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    fetch: withModelCatalog('openai/gpt-test', async (_input, init) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse({
        id: 'gen-reasoning',
        model: 'openai/gpt-test',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }]
      });
    })
  });

  await provider.complete({
    model: 'openai/gpt-test',
    messages: [{ role: 'user', content: 'solve' }],
    reasoning: { strategy: 'effort', effort: 'high' },
    providerOptions: { provider: 'openrouter', values: { reasoningOutput: 'include' } }
  });

  assert.deepEqual(calls[0].reasoning, { effort: 'high', exclude: false });
  assert.equal('include_reasoning' in calls[0], false);
});

test('OpenRouterProvider sends chat requests through the real OpenRouter surface', async () => {
  const calls = [];
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    appUrl: 'https://agent-core.test',
    appTitle: 'Agent Core Test',
    fetch: withModelCatalog('openai/gpt-test', async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({
        id: 'gen-1',
        model: 'openai/gpt-test',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              reasoning: 'I need the file.',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'read_files',
                    arguments: '{"files":[{"path":"package.json"}]}'
                  }
                }
              ]
            }
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14
        }
      });
    })
  });

  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const response = await provider.complete({
    model: 'openai/gpt-test',
    messages: [
      { role: 'system', content: 'Return JSON.' },
      {
        role: 'user',
        content: 'Describe this image.',
        images: [{ type: 'base64', data: 'aW1hZ2U=', mediaType: 'image/jpeg' }]
      },
      {
        role: 'assistant',
        content: '',
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
          description: 'Read a file',
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
    reasoning: { strategy: 'budget', maxTokens: 256 },
    logprobs: true,
    topLogprobs: 2,
    metadata: { runId: 'run-1' },
    providerOptions: { provider: 'openrouter', values: { provider: { order: ['openai'], require_parameters: true }, reasoningOutput: 'omit' } }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].init.headers['HTTP-Referer'], 'https://agent-core.test');
  assert.equal(calls[0].init.headers['X-OpenRouter-Title'], 'Agent Core Test');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'openai/gpt-test');
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.max_tokens, 128);
  assert.deepEqual(body.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'agent_core_response',
      strict: true,
      schema
    }
  });
  assert.equal(body.messages[1].content[0].type, 'text');
  assert.equal(body.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,aW1hZ2U=');
  assert.equal(body.messages[2].content, null);
  assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"files":[{"path":"README.md"}]}');
  assert.equal(body.messages[3].tool_call_id, 'previous-call');
  assert.equal(body.messages[3].name, 'read_files');
  assert.equal(body.tools[0].function.name, 'read_files');
  assert.deepEqual(body.reasoning, { max_tokens: 256, exclude: true });
  assert.deepEqual(body.metadata, { runId: 'run-1' });
  assert.deepEqual(body.provider, { order: ['openai'], require_parameters: true });

  assert.equal(response.content, '');
  assert.equal(response.reasoning, 'I need the file.');
  assert.deepEqual(response.toolCalls, [
    {
      id: 'call-1',
      type: 'function',
      name: 'read_files',
      input: { kind: 'json', value: { files: [{ path: 'package.json' }] } }
    }
  ]);
  assert.deepEqual(response.usage, { promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  assert.equal(response.terminationReason, 'tool_calls');
});

test('OpenRouterProvider streams content, reasoning, tool calls, and final usage', async () => {
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    fetch: withModelCatalog('openai/gpt-test', async () => sseResponse([
      {
        id: 'gen-2',
        model: 'openai/gpt-test',
        choices: [
          {
            delta: {
              reasoning: 'plan ',
              content: 'hel'
            }
          }
        ]
      },
      {
        id: 'gen-2',
        model: 'openai/gpt-test',
        choices: [
          {
            delta: {
              content: 'lo',
              tool_calls: [
                { index: 0, id: 'call-2', type: 'function', function: { name: 'list_directory', arguments: '{"path":' } }
              ]
            }
          }
        ]
      },
      {
        id: 'gen-2',
        model: 'openai/gpt-test',
        choices: [
          {
            finish_reason: 'tool_calls',
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"."}' } }
              ]
            }
          }
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5
        }
      }
    ]))
  });

  const events = [];
  for await (const event of provider.stream({ model: 'openai/gpt-test', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(event);
  }

  assert.deepEqual(events.filter((event) => event.type === 'content').map((event) => event.content), ['hel', 'lo']);
  assert.deepEqual(events.filter((event) => event.type === 'reasoning').map((event) => event.reasoning), ['plan ']);
  assert.equal(events.some((event) => event.type === 'status' && /OPENROUTER PROCESSING/.test(event.message)), true);
  assert.deepEqual(events.filter((event) => event.type === 'tool_call').map((event) => event.toolCall.name), ['list_directory']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.response.content, 'hello');
  assert.equal(done.response.reasoning, 'plan ');
  assert.deepEqual(done.response.toolCalls, [
    {
      id: 'call-2',
      type: 'function',
      name: 'list_directory',
      input: { kind: 'json', value: { path: '.' } }
    }
  ]);
  assert.deepEqual(done.response.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.equal(done.response.terminationReason, 'tool_calls');
});

test('OpenRouterProvider emits status events while waiting for response headers', async () => {
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    statusIntervalMs: 1,
    fetch: withModelCatalog('openai/gpt-test', async () => {
      await new Promise((resolve) => setTimeout(resolve, 8));
      return sseResponse([
        {
          id: 'gen-wait',
          model: 'openai/gpt-test',
          choices: [
            {
              finish_reason: 'stop',
              delta: {
                content: 'ok'
              }
            }
          ]
        }
      ]);
    })
  });

  const events = [];
  for await (const event of provider.stream({ model: 'openai/gpt-test', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(event);
  }

  assert.equal(events.some((event) => event.type === 'status' && /Waiting for OpenRouter stream response/.test(event.message)), true);
  assert.equal(events.at(-1).response.content, 'ok');
});

test('OpenRouterProvider requires an API key for chat requests', async () => {
  const provider = new OpenRouterProvider({ apiKey: '', fetch: fakeFetch([]) });

  await assert.rejects(
    () => provider.complete({ model: 'openrouter/auto', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error instanceof ModelProviderError && error.code === 'invalid_request' && /API key is required/.test(error.message)
  );
});

test('OpenRouterProvider rejects catalog capability contradictions before chat I/O', async () => {
  let chatRequests = 0;
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    fetch: async (input) => {
      if (String(input).endsWith('/models')) {
        return jsonResponse({ data: [{
          id: 'openai/text-only',
          context_length: 16_000,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          top_provider: { context_length: 16_000, max_completion_tokens: 2_000 },
          supported_parameters: ['max_tokens']
        }] });
      }
      chatRequests += 1;
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'unexpected' } }] });
    }
  });
  await assert.rejects(
    () => provider.complete({
      model: 'openai/text-only',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ type: 'function', function: { name: 'read_files' } }]
    }),
    error => error instanceof ModelProviderError && error.code === 'invalid_request' && /tools|tool calling/.test(error.message)
  );
  assert.equal(chatRequests, 0);
});

test('OpenRouterProvider classifies HTTP errors', async () => {
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    fetch: withModelCatalog('missing/model', fakeFetch([
      jsonResponse({ error: { message: 'model does not exist' } }, { status: 404 })
    ]))
  });

  await assert.rejects(
    () => provider.complete({ model: 'missing/model', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error instanceof ModelProviderError && error.code === 'model_unavailable' && error.retryable === false
  );
});

test('OpenRouterProvider classifies malformed stream events', async () => {
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    fetch: withModelCatalog('openrouter/auto', async () => new Response('data: {bad json}\r\n\r\n', {
      headers: { 'content-type': 'text/event-stream' }
    }))
  });

  await assert.rejects(
    async () => {
      for await (const _event of provider.stream({ model: 'openrouter/auto', messages: [{ role: 'user', content: 'hi' }] })) {
        // Exhaust the stream.
      }
    },
    (error) => error instanceof ModelProviderError && error.code === 'malformed_response'
  );
});

test('OpenRouterProvider does not retry a stream error after visible content', async () => {
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    fetch: withModelCatalog('openai/test', async () => sseResponse([
      { id: 'gen', model: 'openai/test', choices: [{ finish_reason: null, delta: { content: 'partial' } }] },
      { error: { code: 503, message: 'upstream interrupted' }, choices: [{ finish_reason: 'error', delta: {} }] }
    ]))
  });
  await assert.rejects(
    async () => { for await (const _event of provider.stream({ model: 'openai/test', messages: [{ role: 'user', content: 'hi' }] })) { /* consume */ } },
    error => error instanceof ModelProviderError && error.code === 'provider_unavailable' && error.retryable === false && error.diagnostic.causeSummary.partialContent === true
  );
});

test('OpenRouterProvider preserves Retry-After as a structured diagnostic', async () => {
  const provider = new OpenRouterProvider({
    apiKey: 'test-key',
    fetch: withModelCatalog('openai/test', async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' } }))
  });
  await assert.rejects(
    () => provider.complete({ model: 'openai/test', messages: [{ role: 'user', content: 'hi' }] }),
    error => error instanceof ModelProviderError && error.code === 'rate_limited' && error.diagnostic.causeSummary.retryAfterMs === 2000
  );
});

function fakeFetch(responses) {
  let index = 0;
  return async () => {
    const response = responses[index];
    index += 1;
    if (!response) {
      throw new Error('No fake response left');
    }
    return response;
  };
}

function withModelCatalog(model, chatFetch) {
  return async (input, init) => String(input).endsWith('/models')
    ? jsonResponse({ data: [catalogRecord(model)] })
    : chatFetch(input, init);
}

function catalogRecord(id) {
  return {
    id,
    context_length: 131072,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    top_provider: { context_length: 131072, max_completion_tokens: 16384 },
    supported_parameters: [
      'include_reasoning', 'logprobs', 'max_tokens', 'metadata', 'reasoning', 'response_format',
      'structured_outputs', 'temperature', 'tools', 'top_logprobs', 'top_p'
    ],
    reasoning: { supported_efforts: ['low', 'medium', 'high'], supports_max_tokens: true }
  };
}

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json' }
  });
}

function sseResponse(chunks) {
  const body = [
    ': OPENROUTER PROCESSING',
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`),
    'data: [DONE]'
  ].join('\n\n');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' }
  });
}
