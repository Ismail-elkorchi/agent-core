import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaProvider } from '@agent-core/provider-ollama';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenAICodexProvider } from '@agent-core/provider-openai-codex';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';

const model = 'usage-fixture';
const request = { model, messages: [{ role: 'user', content: 'Hello' }] };
const profile = {
  capabilities: {
    streaming: true,
    toolCalling: false,
    supportedToolInputs: [],
    jsonMode: false,
    jsonSchema: false,
    logprobs: false,
    temperature: false,
    topP: false
  },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 32768, outputTokens: 4096 },
  supportedParameters: []
};
const names = ['openai', 'openai-codex', 'openrouter', 'ollama'];
function fixture(name, counts, precedingUsage) {
  const usage = {
    ...(counts.input === undefined
      ? {}
      : { [name === 'openrouter' ? 'prompt_tokens' : 'input_tokens']: counts.input }),
    ...(counts.output === undefined
      ? {}
      : { [name === 'openrouter' ? 'completion_tokens' : 'output_tokens']: counts.output }),
    ...(counts.total === undefined ? {} : { total_tokens: counts.total })
  };
  const fetch = async (_url, init) => {
    if (!init?.body)
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
    const stream = JSON.parse(init.body).stream;
    if (name === 'ollama')
      return new Response(
        JSON.stringify({
          model,
          message: { role: 'assistant', content: 'Answer' },
          done: true,
          done_reason: 'stop',
          ...(counts.input === undefined ? {} : { prompt_eval_count: counts.input }),
          ...(counts.output === undefined ? {} : { eval_count: counts.output }),
          ...(counts.cache === undefined ? {} : { prompt_eval_cached_count: counts.cache })
        }) + '\n'
      );
    const final =
      name === 'openrouter'
        ? {
            id: 'result',
            model,
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Answer' } }],
            usage
          }
        : {
            id: 'result',
            model,
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Answer' }]
              }
            ],
            usage
          };
    if (!stream) return Response.json(final);
    const records =
      name === 'openrouter'
        ? [...(precedingUsage ? [{ choices: [], usage: precedingUsage }] : []), final]
        : [{ type: 'response.completed', response: final }];
    return new Response(
      records.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
    );
  };
  const options = { fetch, modelProfiles: { [model]: profile } };
  if (name === 'ollama') return new OllamaProvider(options);
  if (name === 'openrouter') return new OpenRouterProvider({ ...options, apiKey: 'fixture' });
  if (name === 'openai') return new OpenAIProvider({ ...options, apiKey: 'fixture' });
  return new OpenAICodexProvider({
    ...options,
    auth: {
      describe: () => ({ type: 'bearer', label: 'fixture' }),
      getBearerToken: async () => ({ token: 'fixture', metadata: { accountId: 'fixture' } })
    }
  });
}
async function respond(provider, stream) {
  if (!stream) return provider.complete(request);
  let final;
  for await (const event of provider.stream(request))
    if (event.type === 'done') final = event.response;
  assert(final);
  return final;
}
for (const name of names)
  for (const stream of [false, true]) {
    for (const counts of [{}, { input: 17 }, { output: 4 }, { total: 21 }])
      test(`${name} ${stream ? 'stream' : 'complete'} does not fabricate missing usage from ${JSON.stringify(counts)}`, async () => {
        const response = await respond(fixture(name, counts), stream);
        assert.equal(response.content, 'Answer');
        assert.equal(response.usage, undefined);
      });
    test(`${name} ${stream ? 'stream' : 'complete'} preserves explicit zero usage`, async () => {
      const response = await respond(fixture(name, { input: 0, output: 0 }), stream);
      assert.deepEqual(response.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });
  }

test('OpenRouter does not retain an obsolete complete usage snapshot after a partial update', async () => {
  const response = await respond(
    fixture(
      'openrouter',
      { input: 20 },
      { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 }
    ),
    true
  );
  assert.equal(response.usage, undefined);
});
for (const cache of [0, 3])
  test(`Ollama preserves its reported cache read count of ${cache}`, async () => {
    const response = await fixture('ollama', { input: 12, output: 4, cache }).complete(request);
    assert.deepEqual(response.usage, {
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      cacheReadTokens: cache
    });
  });
