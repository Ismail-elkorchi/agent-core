import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '@agent-core/provider-ollama';

class FakeOllamaClient {
  constructor(partsOrError, showResponse) {
    this.partsOrError = partsOrError;
    this.showResponse = showResponse ?? {
      capabilities: ['completion', 'tools', 'thinking'],
      model_info: { 'test.context_length': 32768 },
      details: { family: 'test' }
    };
    this.requests = [];
    this.abortCount = 0;
  }

  async show() {
    return this.showResponse;
  }

  async chat(request) {
    this.requests.push(request);
    if (this.partsOrError instanceof Error) {
      throw this.partsOrError;
    }
    const parts = this.partsOrError;
    return (async function* streamParts() {
      for (const part of parts) {
        if (typeof part === 'number') {
          await new Promise((resolve) => setTimeout(resolve, part));
        } else {
          yield part;
        }
      }
    })();
  }

  abort() {
    this.abortCount += 1;
  }
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
  const toolCall = { function: { name: 'read_files', arguments: { files: [{ path: 'package.json' }] } } };
  const client = new FakeOllamaClient([
    { model: 'llama3.1', message: { role: 'assistant', content: '{"ok":' }, done: false },
    { model: 'llama3.1', message: { role: 'assistant', content: 'true', thinking: 'checking', tool_calls: [toolCall] }, done: false },
    {
      model: 'llama3.1',
      message: { role: 'assistant', content: '}', tool_calls: [toolCall] },
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
    clientFactory: () => client,
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
  const client = new FakeOllamaClient([], {
    capabilities: ['completion', 'tools', 'thinking', 'vision'],
    model_info: { 'qwen.context_length': 131072 },
    parameters: 'num_predict 4096'
  });
  const provider = new OllamaProvider({ model: 'qwen3.5:0.8b', clientFactory: () => client });
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
  const client = new FakeOllamaClient([
    { model: 'llama3.1', message: { role: 'assistant', content: '', thinking: 'plan' }, done: false },
    { model: 'llama3.1', message: { role: 'assistant', content: 'ok' }, done: true }
  ]);
  const provider = new OllamaProvider({ clientFactory: () => client });

  const events = [];
  for await (const event of provider.stream({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(event);
  }

  assert.deepEqual(events.filter((event) => event.type === 'reasoning').map((event) => event.reasoning), ['plan']);
  assert.equal(events.at(-1).response.reasoning, 'plan');
});

test('OllamaProvider stream emits content deltas and final response', async () => {
  const client = new FakeOllamaClient([
    { model: 'llama3.1', message: { role: 'assistant', content: 'hel' }, done: false },
    { model: 'llama3.1', message: { role: 'assistant', content: 'lo' }, done: false },
    { model: 'llama3.1', message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 1, eval_count: 2 }
  ]);
  const provider = new OllamaProvider({ clientFactory: () => client });

  const events = [];
  for await (const event of provider.stream({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }], responseFormat: 'json' })) {
    events.push(event);
  }

  assert.deepEqual(events.filter((event) => event.type === 'content').map((event) => event.content), ['hel', 'lo']);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).response.content, 'hello');
  assert.equal(client.requests[0].format, 'json');
});

test('OllamaProvider aborts active streamed requests when signal aborts', async () => {
  const client = new FakeOllamaClient([
    { model: 'llama3.1', message: { role: 'assistant', content: 'start' }, done: false },
    20,
    { model: 'llama3.1', message: { role: 'assistant', content: 'late' }, done: false }
  ]);
  const provider = new OllamaProvider({ clientFactory: () => client });
  const controller = new AbortController();
  const iterator = provider.stream({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.value.type, 'content');
  controller.abort('stop now');

  await assert.rejects(() => iterator.next(), (error) => error.code === 'aborted' && /stop now/.test(error.message));
  assert.equal(client.abortCount, 1);
});

test('OllamaProvider uses request-scoped clients for concurrent stream aborts', async () => {
  const clients = [
    new FakeOllamaClient([]),
    new FakeOllamaClient([
      { model: 'llama3.1', message: { role: 'assistant', content: 'a' }, done: false },
      20,
      { model: 'llama3.1', message: { role: 'assistant', content: 'late-a' }, done: false }
    ]),
    new FakeOllamaClient([
      { model: 'llama3.1', message: { role: 'assistant', content: 'b' }, done: false },
      { model: 'llama3.1', message: { role: 'assistant', content: '' }, done: true }
    ])
  ];
  let nextClient = 0;
  const provider = new OllamaProvider({ clientFactory: () => clients[nextClient++] });
  const controller = new AbortController();

  const firstIterator = provider.stream({ model: 'llama3.1', messages: [{ role: 'user', content: 'first' }], signal: controller.signal })[
    Symbol.asyncIterator
  ]();
  const secondIterator = provider.stream({ model: 'llama3.1', messages: [{ role: 'user', content: 'second' }] })[Symbol.asyncIterator]();

  const first = await firstIterator.next();
  assert.equal(first.value.type, 'content');
  const second = await secondIterator.next();
  assert.equal(second.value.type, 'content');
  controller.abort('stop first');

  await assert.rejects(() => firstIterator.next(), (error) => error.code === 'aborted');
  const secondDone = await secondIterator.next();

  assert.equal(clients[1].abortCount, 1);
  assert.equal(clients[2].abortCount, 0);
  assert.equal(secondDone.value.type, 'done');
  assert.equal(nextClient, 3);
});

test('OllamaProvider normalizes typed image parts without narrowing casts', async () => {
  const client = new FakeOllamaClient(
    [{ model: 'llama3.1', message: { role: 'assistant', content: 'ok' }, done: true }],
    { capabilities: ['completion', 'vision'], model_info: { 'test.context_length': 32768 } }
  );
  const provider = new OllamaProvider({ clientFactory: () => client });

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
  const notFound = new Error('model not found');
  notFound.name = 'ResponseError';
  notFound.status_code = 404;
  const provider = new OllamaProvider({ clientFactory: () => new FakeOllamaClient(notFound) });

  await assert.rejects(
    () => provider.complete({ model: 'missing', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error.code === 'model_unavailable' && error.retryable === false
  );
});

test('OllamaProvider treats unsupported tool models as invalid requests', async () => {
  const unsupported = new Error('registry.ollama.ai/library/gemma3:270m does not support tools');
  const provider = new OllamaProvider({ clientFactory: () => new FakeOllamaClient(unsupported) });

  await assert.rejects(
    () => provider.complete({ model: 'gemma3:270m', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'read_files' } }] }),
    (error) => error.code === 'invalid_request' && error.retryable === false
  );
});

test('OllamaProvider default client does not inject an unbounded timeout dispatcher', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push(init);
    if (String(input).includes('/api/show')) {
      return new Response(JSON.stringify({ capabilities: ['completion'], model_info: { 'test.context_length': 32768 } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(`${JSON.stringify({ model: 'llama3.1', message: { role: 'assistant', content: 'ok' }, done: true })}\n`, {
      headers: { 'content-type': 'application/x-ndjson' }
    });
  };

  try {
    const provider = new OllamaProvider();
    const events = [];
    for await (const event of provider.stream({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }

    assert.equal(events.at(-1).response.content, 'ok');
    assert.equal(requests.every((request) => request?.dispatcher === undefined), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaProvider distinguishes cloud structured-output availability', async () => {
  const client = new FakeOllamaClient([{ model: 'llama3.1', message: { content: 'ok' }, done: true }]);
  const provider = new OllamaProvider({ deployment: 'cloud', clientFactory: () => client });
  const profile = await provider.describeModel('llama3.1');
  assert.equal(profile.capabilities.jsonMode, false);
  assert.equal(profile.capabilities.jsonSchema, false);
  assert.equal(profile.supportedParameters.includes('responseFormat'), false);
  await assert.rejects(
    () => provider.complete({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }], responseFormat: 'json' }),
    error => error.code === 'invalid_request' && /not declared|not supported/.test(error.message)
  );
  assert.equal(client.requests.length, 0);
});

test('OllamaProvider declares GPT-OSS effort semantics without a disable path', async () => {
  const client = new FakeOllamaClient([{ model: 'gpt-oss:20b', message: { content: 'ok' }, done: true }], {
    capabilities: ['completion', 'thinking'],
    model_info: { 'gptoss.context_length': 131072 }
  });
  const provider = new OllamaProvider({ model: 'gpt-oss:20b', clientFactory: () => client });
  const profile = await provider.describeModel('gpt-oss:20b');
  assert.deepEqual(profile.capabilities.reasoning, { strategies: ['effort'], canDisable: false, efforts: ['low', 'medium', 'high'], separateOutput: true });
  await assert.rejects(
    () => provider.complete({ model: 'gpt-oss:20b', messages: [{ role: 'user', content: 'hi' }], reasoning: { strategy: 'disabled' } }),
    error => error.code === 'invalid_request' && /cannot be disabled/.test(error.message)
  );
});
