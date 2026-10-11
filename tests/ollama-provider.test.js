import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProviderError } from '@agent-core/model';
import { OllamaProvider } from '@agent-core/provider-ollama';

class FakeOllamaTransport {
  constructor(partsOrError, showResponse) {
    this.partsOrError = partsOrError;
    this.showResponse = showResponse ?? {
      capabilities: ['completion', 'tools', 'thinking'],
      model_info: { 'test.context_length': 32768 },
      details: { family: 'test' }
    };
    this.requests = [];
    this.cancelCount = 0;
  }

  fetch = async (url, init) => {
    if (String(url).endsWith('/api/show')) return Response.json(this.showResponse);
    this.requests.push(JSON.parse(init.body));
    if (this.partsOrError instanceof Error) throw this.partsOrError;
    if (this.partsOrError instanceof Response) return this.partsOrError;
    const iterator = this.partsOrError[Symbol.iterator]();
    let cancelled = false;
    return new Response(
      new ReadableStream({
        pull: async (controller) => {
          let part = iterator.next();
          while (typeof part.value === 'number') {
            await new Promise((resolve) => setTimeout(resolve, part.value));
            part = iterator.next();
          }
          if (cancelled) return;
          if (part.done) controller.close();
          else controller.enqueue(new TextEncoder().encode(JSON.stringify(part.value) + '\n'));
        },
        cancel: () => {
          cancelled = true;
          this.cancelCount++;
        }
      }),
      { headers: { 'content-type': 'application/x-ndjson' } }
    );
  };
}

test('OllamaProvider maps the full chat surface and normalizes streamed responses', async () => {
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok']
  };
  const tool = {
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
  };
  const toolCall = {
    function: { name: 'read_files', arguments: { files: [{ path: 'package.json' }] } }
  };
  const client = new FakeOllamaTransport([
    { model: 'llama3.1', message: { role: 'assistant', content: '{"ok":' }, done: false },
    {
      model: 'llama3.1',
      message: { role: 'assistant', content: 'true', thinking: 'checking', tool_calls: [toolCall] },
      done: false
    },
    {
      model: 'llama3.1',
      message: { role: 'assistant', content: '}' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 11,
      eval_count: 7,
      total_duration: 100,
      load_duration: 10,
      prompt_eval_duration: 20,
      eval_duration: 70,
      logprobs: [{ token: '}', logprob: -0.1 }]
    }
  ]);
  const provider = new OllamaProvider({
    fetch: client.fetch,
    keepAlive: '5m',
    reasoning: { strategy: 'effort', effort: 'low' },
    generationOptions: { seed: 42 }
  });

  const response = await provider.complete({
    model: 'llama3.1',
    messages: [
      { role: 'system', content: 'return json' },
      { role: 'user', content: 'go' }
    ],
    responseFormat: { type: 'json_schema', schema },
    tools: [tool],
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 128,
    keepAlive: '30s',
    reasoning: { strategy: 'enabled' },
    logprobs: true,
    topLogprobs: 2,
    providerOptions: { provider: 'ollama', values: { repeat_penalty: 1.1 } }
  });

  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0].stream, true);
  assert.deepEqual(client.requests[0].format, schema);
  assert.deepEqual(client.requests[0].tools, [tool]);
  assert.equal(client.requests[0].keep_alive, '30s');
  assert.equal(client.requests[0].think, true);
  assert.equal(client.requests[0].logprobs, true);
  assert.equal(client.requests[0].top_logprobs, 2);
  assert.equal(client.requests[0].options.temperature, 0.2);
  assert.equal(client.requests[0].options.top_p, 0.9);
  assert.equal(client.requests[0].options.num_predict, 128);
  assert.equal(client.requests[0].options.seed, 42);
  assert.equal(client.requests[0].options.repeat_penalty, 1.1);

  assert.equal(response.content, '{"ok":true}');
  assert.equal(response.reasoning, 'checking');
  assert.deepEqual(response.toolCalls, [
    {
      type: 'function',
      name: 'read_files',
      input: { kind: 'json', value: { files: [{ path: 'package.json' }] } }
    }
  ]);
  assert.deepEqual(response.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  assert.equal(response.terminationReason, 'tool_calls');
  assert.equal(response.providerTerminationReason, 'stop');
  assert.equal(response.timings.totalDurationNs, 100);
  assert.ok(response.logprobs);
});

test('OllamaProvider discovers selected model capabilities through show()', async () => {
  const client = new FakeOllamaTransport([], {
    capabilities: ['completion', 'tools', 'thinking', 'vision'],
    model_info: { 'qwen.context_length': 131072 },
    parameters: 'num_predict 4096'
  });
  const provider = new OllamaProvider({ model: 'qwen3.5:0.8b', fetch: client.fetch });
  const info = provider.describe();
  const profile = await provider.describeModel('qwen3.5:0.8b');

  assert.deepEqual(info, {
    id: 'ollama',
    displayName: 'Ollama local model provider',
    defaultModel: 'qwen3.5:0.8b'
  });
  assert.equal(profile.provider, 'ollama');
  assert.equal(profile.id, 'qwen3.5:0.8b');
  assert.equal(profile.capabilities.toolCalling, true);
  assert.equal(profile.capabilities.reasoning.separateOutput, true);
  assert.deepEqual(profile.capabilities.reasoning.strategies, ['toggle']);
  assert.deepEqual(profile.modalities.input, ['text', 'image']);
  assert.deepEqual(profile.limits, { contextTokens: 131072, outputTokens: 4096 });
  assert.equal(profile.supportedParameters.includes('reasoning'), true);
});

test('OllamaProvider stream emits reasoning deltas when the wire response has thinking', async () => {
  const client = new FakeOllamaTransport([
    {
      model: 'llama3.1',
      message: { role: 'assistant', content: '', thinking: 'plan' },
      done: false
    },
    { model: 'llama3.1', message: { role: 'assistant', content: 'ok' }, done: true }
  ]);
  const provider = new OllamaProvider({ fetch: client.fetch });

  const events = [];
  for await (const event of provider.stream({
    model: 'llama3.1',
    messages: [{ role: 'user', content: 'hi' }]
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.filter((event) => event.type === 'reasoning').map((event) => event.reasoning),
    ['plan']
  );
  assert.equal(events.at(-1).response.reasoning, 'plan');
});

test('OllamaProvider stream emits content deltas and final response', async () => {
  const client = new FakeOllamaTransport([
    { model: 'llama3.1', message: { role: 'assistant', content: 'hel' }, done: false },
    { model: 'llama3.1', message: { role: 'assistant', content: 'lo' }, done: false },
    {
      model: 'llama3.1',
      message: { role: 'assistant', content: '' },
      done: true,
      prompt_eval_count: 1,
      eval_count: 2
    }
  ]);
  const provider = new OllamaProvider({ fetch: client.fetch });

  const events = [];
  for await (const event of provider.stream({
    model: 'llama3.1',
    messages: [{ role: 'user', content: 'hi' }],
    responseFormat: 'json'
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.filter((event) => event.type === 'content').map((event) => event.content),
    ['hel', 'lo']
  );
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).response.content, 'hello');
  assert.equal(client.requests[0].format, 'json');
});

test('OllamaProvider aborts active streamed requests when signal aborts', async () => {
  const client = new FakeOllamaTransport([
    { model: 'llama3.1', message: { role: 'assistant', content: 'start' }, done: false },
    20,
    { model: 'llama3.1', message: { role: 'assistant', content: 'late' }, done: false }
  ]);
  const provider = new OllamaProvider({ fetch: client.fetch });
  const controller = new AbortController();
  const iterator = provider
    .stream({
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal
    })
    [Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.value.type, 'content');
  controller.abort('stop now');

  await assert.rejects(
    () => iterator.next(),
    (error) => error.code === 'aborted' && /stop now/.test(error.message)
  );
  assert.equal(client.cancelCount, 1);
});

test('OllamaProvider keeps concurrent response cancellation independent', async () => {
  const clients = [
    new FakeOllamaTransport([
      { model: 'llama3.1', message: { role: 'assistant', content: 'a' }, done: false },
      20,
      { model: 'llama3.1', message: { role: 'assistant', content: 'late-a' }, done: false }
    ]),
    new FakeOllamaTransport([
      { model: 'llama3.1', message: { role: 'assistant', content: 'b' }, done: false },
      { model: 'llama3.1', message: { role: 'assistant', content: '' }, done: true }
    ])
  ];
  let nextChat = 0;
  const provider = new OllamaProvider({
    fetch: (url, init) => {
      if (String(url).endsWith('/api/show')) return clients[0].fetch(url, init);
      return clients[nextChat++].fetch(url, init);
    }
  });
  const controller = new AbortController();

  const firstIterator = provider
    .stream({
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'first' }],
      signal: controller.signal
    })
    [Symbol.asyncIterator]();
  const secondIterator = provider
    .stream({ model: 'llama3.1', messages: [{ role: 'user', content: 'second' }] })
    [Symbol.asyncIterator]();

  const first = await firstIterator.next();
  assert.equal(first.value.type, 'content');
  const second = await secondIterator.next();
  assert.equal(second.value.type, 'content');
  controller.abort('stop first');

  await assert.rejects(
    () => firstIterator.next(),
    (error) => error.code === 'aborted'
  );
  const secondDone = await secondIterator.next();

  assert.equal(clients[0].cancelCount, 1);
  assert.equal(clients[1].cancelCount, 0);
  assert.equal(secondDone.value.type, 'done');
  assert.equal(nextChat, 2);
  await secondIterator.return();
});

test('OllamaProvider normalizes typed image parts without narrowing casts', async () => {
  const client = new FakeOllamaTransport(
    [{ model: 'llama3.1', message: { role: 'assistant', content: 'ok' }, done: true }],
    { capabilities: ['completion', 'vision'], model_info: { 'test.context_length': 32768 } }
  );
  const provider = new OllamaProvider({ fetch: client.fetch });

  await provider.complete({
    model: 'llava',
    messages: [
      {
        role: 'user',
        content: 'describe',
        images: [
          { type: 'base64', data: 'YWxwaGE=', mediaType: 'image/png' },
          { type: 'bytes', data: new Uint8Array([98, 101, 116, 97]), mediaType: 'image/jpeg' }
        ]
      }
    ]
  });

  assert.deepEqual(client.requests[0].messages[0].images, ['YWxwaGE=', 'YmV0YQ==']);
});

test('OllamaProvider classifies response errors', async () => {
  const transport = new FakeOllamaTransport(
    Response.json({ error: 'model not found' }, { status: 404 })
  );
  const provider = new OllamaProvider({ fetch: transport.fetch });

  await assert.rejects(
    () => provider.complete({ model: 'missing', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error.code === 'model_unavailable' && error.retryable === false
  );
});

test('OllamaProvider decodes wire output before trusting nested fields', async () => {
  const provider = new OllamaProvider({
    fetch: new FakeOllamaTransport([{ model: 'llama3.1', message: { content: 42 }, done: true }])
      .fetch
  });
  await assert.rejects(
    () => provider.complete({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] }),
    (error) =>
      error instanceof ModelProviderError &&
      error.code === 'malformed_response' &&
      /message\.content/u.test(error.message)
  );
});

test('OllamaProvider treats unsupported tool models as invalid requests', async () => {
  const transport = new FakeOllamaTransport(
    Response.json(
      { error: 'registry.ollama.ai/library/gemma3:270m does not support tools' },
      { status: 400 }
    )
  );
  const provider = new OllamaProvider({ fetch: transport.fetch });

  await assert.rejects(
    () =>
      provider.complete({
        model: 'gemma3:270m',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'read_files' } }]
      }),
    (error) => error.code === 'invalid_request' && error.retryable === false
  );
});

test('OllamaProvider transport does not inject an unbounded timeout dispatcher', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push(init);
    if (String(input).includes('/api/show')) {
      return new Response(
        JSON.stringify({
          capabilities: ['completion'],
          model_info: { 'test.context_length': 32768 }
        }),
        {
          headers: { 'content-type': 'application/json' }
        }
      );
    }
    return new Response(
      `${JSON.stringify({ model: 'llama3.1', message: { role: 'assistant', content: 'ok' }, done: true })}\n`,
      {
        headers: { 'content-type': 'application/x-ndjson' }
      }
    );
  };

  try {
    const provider = new OllamaProvider();
    const events = [];
    for await (const event of provider.stream({
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'hi' }]
    })) {
      events.push(event);
    }

    assert.equal(events.at(-1).response.content, 'ok');
    assert.equal(
      requests.every((request) => request?.dispatcher === undefined),
      true
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaProvider distinguishes cloud structured-output availability', async () => {
  const client = new FakeOllamaTransport([
    { model: 'llama3.1', message: { content: 'ok' }, done: true }
  ]);
  const provider = new OllamaProvider({ deployment: 'cloud', fetch: client.fetch });
  const profile = await provider.describeModel('llama3.1');
  assert.equal(profile.capabilities.jsonMode, false);
  assert.equal(profile.capabilities.jsonSchema, false);
  assert.equal(profile.supportedParameters.includes('responseFormat'), false);
  await assert.rejects(
    () =>
      provider.complete({
        model: 'llama3.1',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: 'json'
      }),
    (error) => error.code === 'invalid_request' && /not declared|not supported/.test(error.message)
  );
  assert.equal(client.requests.length, 0);
});

test('OllamaProvider declares GPT-OSS effort semantics without a disable path', async () => {
  const client = new FakeOllamaTransport(
    [{ model: 'gpt-oss:20b', message: { content: 'ok' }, done: true }],
    {
      capabilities: ['completion', 'thinking'],
      model_info: { 'gptoss.context_length': 131072 }
    }
  );
  const provider = new OllamaProvider({ model: 'gpt-oss:20b', fetch: client.fetch });
  const profile = await provider.describeModel('gpt-oss:20b');
  assert.deepEqual(profile.capabilities.reasoning, {
    strategies: ['effort'],
    canDisable: false,
    efforts: ['low', 'medium', 'high'],
    separateOutput: true
  });
  await assert.rejects(
    () =>
      provider.complete({
        model: 'gpt-oss:20b',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { strategy: 'disabled' }
      }),
    (error) => error.code === 'invalid_request' && /cannot be disabled/.test(error.message)
  );
});

test('OllamaProvider validates configured reasoning against the discovered exact profile', async () => {
  const client = new FakeOllamaTransport([]);
  const provider = new OllamaProvider({
    fetch: client.fetch,
    reasoning: { strategy: 'effort', effort: 'low' }
  });
  await assert.rejects(
    () => provider.complete({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error.code === 'invalid_request' && /reasoning/.test(error.message)
  );
  assert.equal(client.requests.length, 0);
  const unknown = await provider.describeModel('custom/gpt-oss-invented');
  assert.deepEqual(unknown.capabilities.reasoning.strategies, ['toggle']);
});

test('OllamaProvider sends the admitted default reasoning and body unchanged', async () => {
  const client = new FakeOllamaTransport([
    { model: 'gpt-oss:20b', message: { content: 'ok' }, done: true }
  ]);
  const reasoning = { strategy: 'effort', effort: 'low' };
  const provider = new OllamaProvider({ fetch: client.fetch, reasoning });
  const original = {
    model: 'gpt-oss:20b',
    messages: [{ role: 'user', content: 'original' }],
    maxOutputTokens: 100
  };
  const compiled = await provider.compileRequest(original);
  reasoning.effort = 'high';
  original.messages[0].content = 'changed';
  assert.equal(await provider.compileRequest(compiled.logicalRequest), compiled);
  await provider.completeCompiled(compiled);
  const { stream, ...body } = client.requests[0];
  assert.equal(stream, true);
  assert.equal(body.think, 'low');
  assert.deepEqual(body, compiled.body);
});

test('Ollama declares developer-only lowering while preserving logical authority and user attribution', async () => {
  const client = new FakeOllamaTransport([
    { model: 'llama3.1', message: { content: 'ok' }, done: true }
  ]);
  const provider = new OllamaProvider({ fetch: client.fetch });
  const messages = [
    { role: 'developer', content: 'Application policy' },
    { role: 'user', content: 'Untrusted retrieved guidance' }
  ];
  const compiled = await provider.compileRequest({
    model: 'llama3.1',
    messages,
    maxOutputTokens: 100
  });
  assert.equal(
    (await provider.describeModel('llama3.1')).capabilities.protocol.developerRole,
    'system_if_no_system'
  );
  assert.deepEqual(
    compiled.logicalRequest.messages.map((item) => item.role),
    ['developer', 'user']
  );
  assert.deepEqual(compiled.body.messages, [
    { role: 'system', content: 'Application policy' },
    messages[1]
  ]);
  await provider.completeCompiled(compiled);
  await assert.rejects(
    () =>
      provider.compileRequest({
        model: 'llama3.1',
        messages: [{ role: 'system', content: 'Higher priority policy' }, ...messages]
      }),
    /mixed system and developer/u
  );
  assert.equal(client.requests.length, 1);
});

test('Ollama cancellation aborts the transport before response headers arrive', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let transportSignal;
  const provider = new OllamaProvider({
    fetch: async (input, init) => {
      if (String(input).includes('/api/show'))
        return Response.json({
          capabilities: ['completion'],
          model_info: { 'test.context_length': 32768 }
        });
      transportSignal = init.signal;
      entered();
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
  });
  const controller = new AbortController();
  const completion = provider.complete({
    model: 'llama3.1',
    messages: [{ role: 'user', content: 'Cancel before headers.' }],
    signal: controller.signal
  });
  await started;
  controller.abort('stop');
  assert.equal(transportSignal.aborted, true);
  await assert.rejects(completion, (error) => error.code === 'aborted');
});
