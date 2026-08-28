import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { FileCredentialStore } from '@agent-core/auth';
import { ModelProviderError } from '@agent-core/model';
import { OpenAICodexProvider, loginOpenAICodexDeviceCode } from '@agent-core/provider-openai-codex';

test('OpenAICodexProvider describes the ChatGPT subscription Responses profile', async () => {
  const provider = new OpenAICodexProvider({ auth: bearerProvider(codexJwt()) });
  assert.deepEqual(provider.describe(), {
    id: 'openai-codex',
    displayName: 'OpenAI Codex ChatGPT subscription provider',
    defaultModel: 'gpt-5.6'
  });
  const profile = await provider.describeModel('gpt-5.6');
  assert.equal(profile.id, 'gpt-5.6');
  assert.equal(profile.provider, 'openai-codex');
  assert.equal(profile.capabilities.streaming, true);
  assert.equal(profile.capabilities.toolCalling, true);
  assert.deepEqual(profile.limits, { contextTokens: 1_050_000, maxInputTokens: 922_000, outputTokens: 128_000 });
  assert.equal(profile.supportedParameters.includes('maxOutputTokens'), false);
  assert.equal(profile.metadata.api, 'codex-responses');
  assert.equal(profile.metadata.auth, 'chatgpt-subscription');
  assert.equal('preferWebsockets' in profile.metadata, false);
  assert.equal(profile.metadata.defaultReasoningEffort, 'medium');
  assert.deepEqual(profile.capabilities.reasoning.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(profile.capabilities.reasoning.canDisable, false);
  assert.equal(profile.capabilities.reasoning.modes, undefined);
  assert.deepEqual(Object.keys(profile.metadata).sort(), ['api', 'auth', 'defaultReasoningEffort', 'modelTier']);
});

test('OpenAICodexProvider supports GPT-5.6 max effort but does not claim subscription Pro mode', async () => {
  let fetchCalls = 0;
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse({ id: 'unexpected', model: 'gpt-5.6', status: 'completed', output_text: 'unexpected' });
    }
  });
  await provider.complete({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'solve' }], reasoning: { strategy: 'effort', effort: 'max' } });
  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'solve' }], reasoning: { strategy: 'effort', effort: 'high', mode: 'pro' } }),
    error => error instanceof ModelProviderError && error.code === 'invalid_request'
  );
  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'solve' }], reasoning: { strategy: 'effort', effort: 'max' } }),
    error => error instanceof ModelProviderError && error.code === 'model_unavailable'
  );
  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'solve' }], reasoning: { strategy: 'disabled' } }),
    error => error instanceof ModelProviderError && error.code === 'invalid_request'
  );
  assert.equal(fetchCalls, 1);
});

test('OpenAICodexProvider serializes documented service tiers and rejects obsolete aliases', async () => {
  const calls = [];
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    fetch: async (_input, init) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse({ id: 'resp-priority', model: 'gpt-5.6', status: 'completed', output_text: 'done' });
    }
  });

  await provider.complete({
    model: 'gpt-5.6',
    messages: [{ role: 'user', content: 'solve' }],
    providerOptions: { provider: 'openai-codex', values: { serviceTier: 'priority' } }
  });
  assert.equal(calls[0].service_tier, 'priority');

  await assert.rejects(
    () => provider.complete({
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'solve' }],
      providerOptions: { provider: 'openai-codex', values: { serviceTier: 'fast' } }
    }),
    error => error instanceof ModelProviderError && error.code === 'invalid_request'
  );
  assert.equal(calls.length, 1);
});

test('OpenAICodexProvider defaults to HTTP full replay transport', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'resp-http-default',
      model: 'gpt-5.6',
      status: 'completed',
      output_text: 'http ok',
      output: []
    }));
  });
  server.listen(0);
  await listening(server);
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-http')),
    baseUrl: `http://127.0.0.1:${String(address.port)}`
  });

  try {
    const response = await provider.complete({
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(response.content, 'http ok');
    assert.equal(response.transport.strategy, 'http_full_replay');
  } finally {
    await closeServer(server);
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/codex/responses');
  assert.equal(requests[0].headers.authorization, `Bearer ${codexJwt('acct-http')}`);
  assert.equal(requests[0].headers['chatgpt-account-id'], 'acct-http');
  assert.equal(requests[0].headers['openai-beta'], 'responses=experimental');
  assert.equal(requests[0].headers.originator, 'agent-core');
});

test('OpenAICodexProvider accepts nullable response fields in HTTP stream events', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    fetch: async () => sseResponse([
      {
        type: 'response.created',
        response: {
          id: 'resp-nullable',
          model: 'gpt-5.6',
          status: 'in_progress',
          output: [],
          usage: null,
          error: null,
          incomplete_details: null
        }
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp-nullable',
          model: 'gpt-5.6',
          status: 'completed',
          output_text: 'stream ok',
          output: [],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          error: null,
          incomplete_details: null
        }
      }
    ])
  });

  const events = [];
  for await (const event of provider.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] })) events.push(event);
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.response.content, 'stream ok');
  assert.deepEqual(done.response.usage, { promptTokens: 4, completionTokens: 2, totalTokens: 6 });
  assert.equal(done.response.raw.error, undefined);
  assert.equal(done.response.raw.incomplete_details, undefined);
});

test('OpenAICodexProvider summarizes failed stream events without error bodies', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    fetch: async () => sseResponse([
      {
        type: 'response.failed',
        response: {
          id: 'resp-failed',
          model: 'gpt-5.6',
          status: 'failed',
          incomplete_details: { reason: 'server_shutdown' }
        }
      }
    ])
  });

  await assert.rejects(
    async () => {
      for await (const _event of provider.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] })) {
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

test('OpenAICodexProvider treats generic HTTP error events as terminal provider failures', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    fetch: async () => sseResponse([{ type: 'error', error: { message: 'backend rejected the stream', code: 'backend_error' } }])
  });
  await assert.rejects(
    async () => { for await (const _event of provider.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] })) { /* consume */ } },
    error => error instanceof ModelProviderError && error.code === 'provider_unavailable' && error.diagnostic.eventType === 'error'
  );
});

test('OpenAICodexProvider bounds post-header stream idleness', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    statusIntervalMs: 2,
    streamIdleTimeoutMs: 12,
    fetch: async () => stalledSseResponse()
  });
  await assert.rejects(
    async () => { for await (const _event of provider.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] })) { /* consume */ } },
    error => error instanceof ModelProviderError && error.code === 'provider_unavailable' && /idle/iu.test(error.message)
  );
});

test('OpenAICodexProvider rejects malformed nested Responses fields', async () => {
  const provider = new OpenAICodexProvider({ auth: bearerProvider(codexJwt()), fetch: async () => jsonResponse({ id: 'bad', model: 'gpt-5.6', status: 'completed', output_text: 'x', usage: { input_tokens: 'one' } }) });
  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] }),
    error => error instanceof ModelProviderError && error.code === 'malformed_response' && /input_tokens/u.test(error.message)
  );
});

test('OpenAICodexProvider labels HTTP request failures as http_sse transport', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    fetch: async () => new Response(JSON.stringify({
      error: {
        message: 'temporarily unavailable'
      }
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })
  });

  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error instanceof ModelProviderError, true);
      assert.match(error.message, /HTTP 503/);
      assert.equal(error.diagnostic.transport, 'http_sse');
      assert.equal(error.diagnostic.causeSummary.status, 503);
      return true;
    }
  );
});

test('OpenAICodexProvider default WebSocket factory sends Codex headers', async () => {
  const server = new WebSocketServer({ port: 0 });
  const requests = [];
  const messages = [];
  server.on('connection', (socket, request) => {
    requests.push(request);
    socket.on('message', (data) => {
      messages.push(JSON.parse(String(data)));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp-ws-real',
          model: 'gpt-5.6',
          status: 'completed',
          output_text: 'ws ok',
          output: []
        }
      }));
    });
  });
  await listening(server);
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-ws')),
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    transport: 'websocket'
  });
  const session = provider.createSession();
  const events = [];
  try {
    for await (const event of session.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
  } finally {
    await session.close();
    await closeServer(server);
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, `Bearer ${codexJwt('acct-ws')}`);
  assert.equal(requests[0].headers['chatgpt-account-id'], 'acct-ws');
  assert.equal(requests[0].headers['openai-beta'], 'responses_websockets=2026-02-06');
  assert.equal(requests[0].headers.originator, 'agent-core');
  assert.equal(messages[0].type, 'response.create');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).response.content, 'ws ok');
  assert.equal(events.at(-1).response.transport.strategy, 'websocket_full_replay');
});

test('OpenAICodexProvider sends Codex Responses requests with ChatGPT account headers and tools', async () => {
  const calls = [];
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-123')),
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({
        id: 'resp-1',
        model: 'gpt-5.6',
        status: 'completed',
        output_text: 'hello',
        output: [
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'read_files',
            arguments: '{"files":[{"path":"README.md"}]}'
          }
        ],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
      });
    }
  });

  const response = await provider.complete({
    model: 'gpt-5.6',
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Read this.' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_files',
          description: 'Read text files',
          parameters: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] }
        }
      }
    ],
    reasoning: { strategy: 'effort', effort: 'high' }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${codexJwt('acct-123')}`);
  assert.equal(calls[0].init.headers['chatgpt-account-id'], 'acct-123');
  assert.equal(calls[0].init.headers['OpenAI-Beta'], 'responses=experimental');
  assert.equal(calls[0].init.headers.originator, 'agent-core');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'gpt-5.6');
  assert.equal(body.stream, false);
  assert.equal(body.store, false);
  assert.equal(body.instructions, 'Be concise.');
  assert.equal('previous_response_id' in body, false);
  assert.equal('max_output_tokens' in body, false);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, true);
  assert.equal('include' in body, false, 'encrypted reasoning is returned by default for stateless Responses requests');
  assert.equal(body.tools[0].name, 'read_files');
  assert.equal(response.content, 'hello');
  assert.deepEqual(response.toolCalls, [
    {
      id: 'call-1',
      type: 'function',
      name: 'read_files',
      input: { kind: 'json', value: { files: [{ path: 'README.md' }] } }
    }
  ]);
  assert.deepEqual(response.transport, {
    provider: 'openai-codex',
    strategy: 'http_full_replay',
    responseId: 'resp-1'
  });
});

test('OpenAICodexProvider HTTP transport replays full projected history without previous_response_id', async () => {
  const calls = [];
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-123')),
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({ id: 'resp-2', model: 'gpt-5.6', status: 'completed', output_text: 'done' });
    }
  });

  await provider.complete({
    model: 'gpt-5.6',
    messages: toolTranscriptMessages()
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal('previous_response_id' in body, false);
  assert.deepEqual(body.input.map((item) => item.type ?? item.role), [
    'user',
    'function_call',
    'function_call_output',
    'function_call',
    'function_call_output'
  ]);
  assert.equal(body.input[1].call_id, 'call-shell-1');
  assert.equal(body.input[2].call_id, 'call-shell-1');
  assert.equal(body.input[3].call_id, 'call-shell-2');
  assert.equal(body.input[4].call_id, 'call-shell-2');
});

test('OpenAICodexProvider HTTP sessions replay the full transcript without persistent continuation state', async () => {
  const calls = [];
  const responses = [
    { id: 'resp-http-1', model: 'gpt-5.6', status: 'completed', output_text: 'ready', output: [] },
    { id: 'resp-http-2', model: 'gpt-5.6', status: 'completed', output_text: 'continued', output: [] }
  ];
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-123')),
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse(responses.shift());
    }
  });
  const session = provider.createSession();

  const first = await session.complete({
    model: 'gpt-5.6',
    messages: [{ role: 'user', content: 'Start long shell work.' }]
  });
  const second = await session.complete({
    model: 'gpt-5.6',
    messages: longMixedShellTranscriptMessages(18)
  });

  const firstBody = JSON.parse(calls[0].init.body);
  const secondBody = JSON.parse(calls[1].init.body);
  assert.equal('previous_response_id' in firstBody, false);
  assert.equal('previous_response_id' in secondBody, false);
  assert.equal(JSON.stringify(secondBody.input).includes('chunk-18'), true);
  assert.equal(second.transport.strategy, 'http_full_replay');
  assert.equal(first.providerState, undefined);
  assert.equal(second.providerState, undefined);
});

test('OpenAICodexProvider WebSocket session continues with only incremental input when history matches', async () => {
  const sockets = [];
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-123')),
    transport: 'websocket',
    webSocketFactory: () => {
      const socket = new FakeCodexWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  const session = provider.createSession();

  const firstEvents = [];
  const firstStream = session.stream({
    model: 'gpt-5.6',
    messages: [{ role: 'user', content: 'Run pwd.' }]
  });
  for await (const event of firstStream) {
    firstEvents.push(event);
  }
  assert.equal(firstEvents.at(-1).response.transport.strategy, 'websocket_full_replay');

  const secondEvents = [];
  const secondStream = session.stream({
    model: 'gpt-5.6',
    messages: [
      { role: 'user', content: 'Run pwd.' },
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
        content: '{"ok":true}'
      }
    ]
  });
  for await (const event of secondStream) {
    secondEvents.push(event);
  }

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].sent.length, 2);
  const firstBody = JSON.parse(sockets[0].sent[0]);
  const secondBody = JSON.parse(sockets[0].sent[1]);
  assert.equal(firstBody.type, 'response.create');
  assert.equal(secondBody.type, 'response.create');
  assert.equal('previous_response_id' in firstBody, false);
  assert.equal(secondBody.previous_response_id, 'resp-ws-1');
  assert.deepEqual(secondBody.input.map((item) => item.type ?? item.role), ['function_call_output']);
  assert.equal(secondBody.input[0].call_id, 'call-shell-1');
  assert.equal(secondEvents.at(-1).response.transport.strategy, 'websocket_delta');

  const thirdEvents = [];
  const thirdStream = session.stream({
    model: 'gpt-5.6',
    messages: [
      { role: 'user', content: 'Run pwd.' },
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
        content: '{"ok":true}'
      }
    ]
  });
  for await (const event of thirdStream) {
    thirdEvents.push(event);
  }

  assert.equal(sockets[0].sent.length, 3);
  const thirdBody = JSON.parse(sockets[0].sent[2]);
  assert.equal('previous_response_id' in thirdBody, false);
  assert.deepEqual(thirdBody.input.map((item) => item.type ?? item.role), [
    'user',
    'function_call',
    'function_call_output'
  ]);
  assert.equal(thirdEvents.at(-1).response.transport.strategy, 'websocket_full_replay');
});

test('OpenAICodexProvider WebSocket continuation rejection reports previous response state', async () => {
  const sockets = [];
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-123')),
    transport: 'websocket',
    webSocketFactory: () => {
      const socket = new ContinuationFailingCodexWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  const session = provider.createSession();

  const firstEvents = [];
  for await (const event of session.stream({
    model: 'gpt-5.6',
    messages: [{ role: 'user', content: 'Run pwd.' }]
  })) {
    firstEvents.push(event);
  }
  assert.equal(firstEvents.at(-1).response.providerState, undefined);

  await assert.rejects(
    async () => {
      for await (const _event of session.stream({
        model: 'gpt-5.6',
        messages: [
          { role: 'user', content: 'Run pwd.' },
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
            content: '{"ok":true}'
          }
        ]
      })) {
        // Consume stream.
      }
    },
    (error) => {
      assert.equal(error instanceof ModelProviderError, true);
      assert.equal(error.diagnostic.transport, 'websocket');
      assert.equal(error.diagnostic.eventType, 'response.failed');
      assert.equal(error.diagnostic.causeSummary.previousResponseId, 'resp-ws-1');
      assert.equal(error.diagnostic.causeSummary.reusedContinuation, true);
      assert.equal(error.diagnostic.causeSummary.continuationStrategy, 'websocket_delta');
      assert.equal(error.diagnostic.causeSummary.incompleteReason, 'previous_response_rejected');
      return true;
    }
  );

  assert.equal(sockets[0].sent.length, 2);
  const secondBody = JSON.parse(sockets[0].sent[1]);
  assert.equal(secondBody.previous_response_id, 'resp-ws-1');
});

test('OpenAICodexProvider WebSocket continuation remains live-session state only', async () => {
  const sockets = [];
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-123')),
    transport: 'websocket',
    webSocketFactory: () => {
      const socket = new FakeCodexWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  const session = provider.createSession();

  const firstEvents = [];
  for await (const event of session.stream({
    model: 'gpt-5.6',
    messages: [{ role: 'user', content: 'Run pwd.' }]
  })) {
    firstEvents.push(event);
  }
  const firstState = firstEvents.at(-1).response.providerState;

  const secondEvents = [];
  for await (const event of session.stream({
    model: 'gpt-5.6',
    messages: [
      { role: 'user', content: 'Run pwd.' },
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
        content: '{"ok":true}'
      }
    ]
  })) {
    secondEvents.push(event);
  }
  const secondState = secondEvents.at(-1).response.providerState;

  assert.equal(firstState, undefined);
  assert.equal(secondState, undefined);
  assert.equal(JSON.parse(sockets[0].sent[1]).previous_response_id, 'resp-ws-1');
});

test('OpenAICodexProvider does not share continuation state across WebSocket sessions', async () => {
  const sockets = [];
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-123')),
    transport: 'websocket',
    webSocketFactory: () => {
      const socket = new FakeCodexWebSocket();
      sockets.push(socket);
      return socket;
    }
  });

  const firstSession = provider.createSession();
  const firstEvents = [];
  for await (const event of firstSession.stream({
    model: 'gpt-5.6',
    messages: [{ role: 'user', content: 'Run pwd.' }]
  })) {
    firstEvents.push(event);
  }
  const restoredState = firstEvents.at(-1).response.providerState;
  assert.equal(restoredState, undefined);

  const resumedSession = provider.createSession();
  const resumedEvents = [];
  for await (const event of resumedSession.stream({
    model: 'gpt-5.6',
    messages: [
      { role: 'user', content: 'Run pwd.' },
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
        content: '{"ok":true}'
      }
    ]
  })) {
    resumedEvents.push(event);
  }

  assert.equal(sockets.length, 2);
  const resumedBody = JSON.parse(sockets[1].sent[0]);
  assert.equal('previous_response_id' in resumedBody, false);
  assert.deepEqual(resumedBody.input.map((item) => item.type ?? item.role), ['user', 'function_call', 'function_call_output']);
  assert.equal(resumedEvents.at(-1).response.transport.strategy, 'websocket_full_replay');
  assert.equal(resumedEvents.at(-1).response.providerState, undefined);
});

test('OpenAICodexProvider WebSocket continuation accounts for output_text-only responses', async () => {
  const sockets = [];
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt('acct-123')),
    transport: 'websocket',
    webSocketFactory: () => {
      const socket = new FakeCodexWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  const session = provider.createSession();
  const toolTranscript = [
    { role: 'user', content: 'Run pwd.' },
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
      content: '{"ok":true}'
    }
  ];

  for await (const _event of session.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'Run pwd.' }] })) {
    // Drain.
  }
  for await (const _event of session.stream({ model: 'gpt-5.6', messages: toolTranscript })) {
    // Drain output_text-only continuation response.
  }
  for await (const _event of session.stream({
    model: 'gpt-5.6',
    messages: [
      ...toolTranscript,
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'What next?' }
    ]
  })) {
    // Drain follow-up.
  }

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].sent.length, 3);
  const followUpBody = JSON.parse(sockets[0].sent[2]);
  assert.equal(followUpBody.previous_response_id, 'resp-ws-2');
  assert.deepEqual(followUpBody.input, [{ role: 'user', content: 'What next?' }]);
});

test('OpenAICodexProvider reports useful WebSocket fallback diagnostics', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    transport: 'websocket',
    webSocketFactory: () => new FailingCodexWebSocket({
      type: 'error',
      message: 'TLS handshake failed',
      error: new Error('proxy refused CONNECT')
    }),
    fetch: async () => sseResponse([
      {
        type: 'response.completed',
        response: {
          id: 'resp-http-fallback',
          model: 'gpt-5.6',
          status: 'completed',
          output_text: 'fallback ok'
        }
      }
    ])
  });

  const session = provider.createSession();
  const events = [];
  for await (const event of session.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(event);
  }

  assert.equal(events[0].type, 'status');
  assert.match(events[0].message, /type=error/);
  assert.match(events[0].message, /message=TLS handshake failed/);
  assert.match(events[0].message, /error=proxy refused CONNECT/);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).response.content, 'fallback ok');

  const secondEvents = [];
  for await (const event of session.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'again' }] })) {
    secondEvents.push(event);
  }

  assert.equal(secondEvents.some((event) => event.type === 'status' && event.message.includes('WebSocket unavailable')), false);
  assert.equal(secondEvents.at(-1).type, 'done');
  assert.equal(secondEvents.at(-1).response.content, 'fallback ok');
});

test('OpenAICodexProvider reports WebSocket close diagnostics after streaming starts', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    transport: 'websocket',
    fetch: async () => {
      throw new Error('HTTP fallback should not be used after WebSocket content.');
    },
    webSocketFactory: () => new ClosingAfterContentCodexWebSocket()
  });
  const events = [];

  await assert.rejects(
    async () => {
      for await (const event of provider.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(event);
      }
    },
    (error) => {
      assert.equal(error instanceof ModelProviderError, true);
      assert.match(error.message, /WebSocket transport failed/);
      assert.equal(error.diagnostic.transport, 'websocket');
      assert.equal(error.diagnostic.causeSummary.phase, 'after_model_event');
      assert.equal(error.diagnostic.causeSummary.webSocketPhase, 'stream');
      assert.equal(error.diagnostic.causeSummary.webSocketEvent, 'close');
      assert.equal(error.diagnostic.causeSummary.closeCode, 1006);
      assert.equal(error.diagnostic.causeSummary.closeReason, 'keepalive timeout');
      return true;
    }
  );

  assert.equal(events.some((event) => event.type === 'content' && event.content === 'partial'), true);
});

test('OpenAICodexProvider streams content, reasoning, tool calls, and final metadata', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    fetch: async () => sseResponse([
      { type: 'response.reasoning_summary_text.delta', delta: 'plan ' },
      { type: 'response.output_text.delta', delta: 'hi' },
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
          model: 'gpt-5.6',
          status: 'completed',
          output_text: 'hi',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }
      }
    ])
  });

  const events = [];
  for await (const event of provider.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(event);
  }

  assert.deepEqual(events.filter((event) => event.type === 'reasoning').map((event) => event.reasoning), ['plan ']);
  assert.deepEqual(events.filter((event) => event.type === 'reasoning').map((event) => event.channel), ['summary']);
  assert.deepEqual(events.filter((event) => event.type === 'content').map((event) => event.content), ['hi']);
  assert.deepEqual(events.filter((event) => event.type === 'tool_call').map((event) => event.toolCall.name), ['list_directory']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.response.reasoningSummary, 'plan ');
  assert.deepEqual(done.response.transport, {
    provider: 'openai-codex',
    strategy: 'http_full_replay',
    responseId: 'resp-2'
  });
});

test('OpenAICodexProvider preserves accumulated streamed content when completed payload has no visible text', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    fetch: async () => sseResponse([
      { type: 'response.output_text.delta', delta: 'visible ' },
      { type: 'response.output_text.delta', delta: 'text' },
      {
        type: 'response.completed',
        response: {
          id: 'resp-empty',
          model: 'gpt-5.6',
          status: 'completed',
          output: []
        }
      }
    ])
  });

  const events = [];
  for await (const event of provider.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(event);
  }

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.response.content, 'visible text');
});

test('OpenAICodexProvider refreshes stored credentials before request', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-core-codex-auth-'));
  const store = new FileCredentialStore({ rootDir });
  await store.write('openai-codex', {
    token: codexJwt('old-acct'),
    refreshToken: 'refresh-old',
    expiresAt: Date.now() - 10_000
  });
  const calls = [];
  const provider = new OpenAICodexProvider({
    credentialStore: store,
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      if (String(input).endsWith('/oauth/token')) {
        return jsonResponse({
          access_token: codexJwt('new-acct'),
          refresh_token: 'refresh-new',
          expires_in: 3600,
          token_type: 'Bearer'
        });
      }
      return jsonResponse({ id: 'resp-3', model: 'gpt-5.6', status: 'completed', output_text: 'ok' });
    }
  });

  const response = await provider.complete({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.content, 'ok');
  assert.equal(calls[0].input, 'https://auth.openai.com/oauth/token');
  assert.equal(calls[1].init.headers['chatgpt-account-id'], 'new-acct');
  assert.equal((await store.read('openai-codex')).refreshToken, 'refresh-new');
});

test('OpenAICodexProvider fails before fetch when stored credentials are missing', async () => {
  let calls = 0;
  const provider = new OpenAICodexProvider({
    credentialStore: new FileCredentialStore({ rootDir: await mkdtemp(path.join(tmpdir(), 'agent-core-codex-auth-')) }),
    fetch: async () => {
      calls += 1;
      return jsonResponse({});
    }
  });

  await assert.rejects(
    () => provider.complete({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error instanceof ModelProviderError && error.code === 'invalid_request' && /credentials/.test(error.message)
  );
  assert.equal(calls, 0);
});

test('loginOpenAICodexDeviceCode stores device-code OAuth credentials', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-core-codex-auth-'));
  const store = new FileCredentialStore({ rootDir });
  const devicePrompts = [];
  const fetchCalls = [];
  const credentials = await loginOpenAICodexDeviceCode({
    store,
    key: 'openai-codex',
    onDeviceCode(info) {
      devicePrompts.push(info);
    },
    fetch: async (input, init) => {
      fetchCalls.push({ input: String(input), init });
      if (String(input).endsWith('/api/accounts/deviceauth/usercode')) {
        return jsonResponse({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 0 });
      }
      if (String(input).endsWith('/api/accounts/deviceauth/token')) {
        return jsonResponse({ authorization_code: 'auth-code', code_verifier: 'verifier' });
      }
      if (String(input).endsWith('/oauth/token')) {
        return jsonResponse({
          access_token: codexJwt('acct-login'),
          refresh_token: 'refresh-login',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid profile'
        });
      }
      throw new Error(`unexpected URL ${String(input)}`);
    }
  });

  assert.equal(devicePrompts[0].userCode, 'ABCD-EFGH');
  assert.equal(credentials.metadata.accountId, 'acct-login');
  assert.equal((await store.read('openai-codex')).refreshToken, 'refresh-login');
  const tokenExchangeBody = fetchCalls.at(-1).init.body;
  assert.equal(tokenExchangeBody.get('grant_type'), 'authorization_code');
  assert.equal(tokenExchangeBody.get('code_verifier'), 'verifier');
});

function bearerProvider(token) {
  return {
    type: 'bearer',
    tokenProvider: {
      describe() {
        return { type: 'oauth', label: 'test Codex token', provider: 'openai-codex' };
      },
      async getBearerToken() {
        return { token };
      }
    }
  };
}

function listening(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

class FakeCodexWebSocket {
  readyState = 0;
  sent = [];
  listeners = new Map();

  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  send(data) {
    this.sent.push(data);
    const request = JSON.parse(data);
    const isContinuation = typeof request.previous_response_id === 'string';
    queueMicrotask(() => {
      if (isContinuation) {
        this.emitJson({
          type: 'response.completed',
          response: {
            id: 'resp-ws-2',
            model: 'gpt-5.6',
            status: 'completed',
            output_text: 'done',
            output: []
          }
        });
      } else {
        const callItem = {
          type: 'function_call',
          call_id: 'call-shell-1',
          name: 'exec_command',
          arguments: '{"command":"pwd"}'
        };
        this.emitJson({
          type: 'response.output_item.done',
          item: callItem
        });
        this.emitJson({
          type: 'response.completed',
          response: {
            id: 'resp-ws-1',
            model: 'gpt-5.6',
            status: 'completed',
            output: [callItem]
          }
        });
      }
    });
  }

  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'test close' });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emitJson(value) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class ContinuationFailingCodexWebSocket {
  readyState = 0;
  sent = [];
  listeners = new Map();

  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  send(data) {
    this.sent.push(data);
    const request = JSON.parse(data);
    const isContinuation = typeof request.previous_response_id === 'string';
    queueMicrotask(() => {
      if (isContinuation) {
        this.emitJson({
          type: 'response.failed',
          response: {
            id: 'resp-ws-failed',
            model: 'gpt-5.6',
            status: 'failed',
            incomplete_details: { reason: 'previous_response_rejected' }
          }
        });
        return;
      }
      const callItem = {
        type: 'function_call',
        call_id: 'call-shell-1',
        name: 'exec_command',
        arguments: '{"command":"pwd"}'
      };
      this.emitJson({
        type: 'response.output_item.done',
        item: callItem
      });
      this.emitJson({
        type: 'response.completed',
        response: {
          id: 'resp-ws-1',
          model: 'gpt-5.6',
          status: 'completed',
          output: [callItem]
        }
      });
    });
  }

  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'test close' });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emitJson(value) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FailingCodexWebSocket {
  readyState = 0;
  listeners = new Map();

  constructor(event) {
    queueMicrotask(() => {
      this.emit('error', event);
    });
  }

  send() {
    throw new Error('send should not be called on a failed test WebSocket');
  }

  close() {
    this.readyState = 3;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class ClosingAfterContentCodexWebSocket {
  readyState = 0;
  listeners = new Map();

  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  send() {
    queueMicrotask(() => {
      this.emitJson({
        type: 'response.output_text.delta',
        delta: 'partial'
      });
      setTimeout(() => {
        this.readyState = 3;
        this.emit('close', { code: 1006, reason: 'keepalive timeout' });
      }, 0);
    });
  }

  close() {
    this.readyState = 3;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emitJson(value) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function codexJwt(accountId = 'acct-test') {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId
    }
  }));
  return `${header}.${payload}.signature`;
}

function base64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('OpenAICodexProvider preserves visible output from an incomplete response', async () => {
  const provider = new OpenAICodexProvider({
    auth: bearerProvider(codexJwt()),
    fetch: async () => sseResponse([
      { type: 'response.output_text.delta', delta: 'partial codex answer' },
      { type: 'response.incomplete', response: { id: 'resp-partial', model: 'gpt-5.6', status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } } }
    ])
  });
  const events = [];
  for await (const event of provider.stream({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'answer' }] })) events.push(event);
  assert.equal(events.at(-1).response.content, 'partial codex answer');
  assert.equal(events.at(-1).response.terminationReason, 'output_limit');
  assert.equal(events.at(-1).response.providerTerminationReason, 'max_output_tokens');
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
    ': CODEX PROCESSING',
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`),
    'data: [DONE]'
  ].join('\n\n');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' }
  });
}

function stalledSseResponse() {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(': CONNECTED\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
}
