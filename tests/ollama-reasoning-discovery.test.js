import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaProvider } from '@agent-core/provider-ollama';

function fixture(thinking, model = 'custom/reasoner') {
  const sent = [];
  const provider = new OllamaProvider({
    fetch: async (url, init) => {
      if (String(url).endsWith('/api/show'))
        return Response.json({
          capabilities: ['completion', 'thinking'],
          model_info: { 'fixture.context_length': 32768 },
          ...(thinking === undefined ? {} : { thinking })
        });
      sent.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          model,
          done: true,
          done_reason: 'stop',
          message: { content: 'Answer', thinking: 'Reasoning retained' }
        }) + '\n'
      );
    }
  });
  return { provider, sent, request: { model, messages: [{ role: 'user', content: 'Hello' }] } };
}

for (const model of ['gpt-oss:20b', 'custom/reasoner'])
  test(`Ollama uses exact advertised effort values for ${model}`, async () => {
    const thinking = { values: ['brief', 'thorough', 'none'], default: 'brief' };
    const { provider, request, sent } = fixture(thinking, model);
    const profile = await provider.describeModel(model);
    assert.deepEqual(profile.capabilities.reasoning, {
      strategies: ['effort'],
      canDisable: false,
      efforts: thinking.values,
      separateOutput: true
    });
    assert.deepEqual(profile.metadata.thinking, thinking);
    for (const effort of thinking.values) {
      const result = await provider.complete({
        ...request,
        reasoning: { strategy: 'effort', effort }
      });
      assert.equal(result.reasoning, 'Reasoning retained');
      assert.equal(sent.at(-1).think, effort);
    }
    await assert.rejects(
      provider.complete({ ...request, reasoning: { strategy: 'effort', effort: 'high' } }),
      (error) => error.code === 'invalid_request'
    );
    await assert.rejects(
      provider.complete({ ...request, reasoning: { strategy: 'disabled' } }),
      (error) => error.code === 'invalid_request'
    );
    assert.equal(sent.length, thinking.values.length);
  });

for (const values of [[true], [true, false], [false, true, 'deep']])
  test(`Ollama derives toggle and disable controls from ${JSON.stringify(values)}`, async () => {
    const { provider, request, sent } = fixture({ values, default: true });
    const profile = await provider.describeModel(request.model);
    assert.equal(profile.capabilities.reasoning.canDisable, values.includes(false));
    assert(profile.capabilities.reasoning.strategies.includes('toggle'));
    await provider.complete({ ...request, reasoning: { strategy: 'enabled' } });
    assert.equal(sent.at(-1).think, true);
    if (values.includes(false)) {
      await provider.complete({ ...request, reasoning: { strategy: 'disabled' } });
      assert.equal(sent.at(-1).think, false);
    } else
      await assert.rejects(provider.complete({ ...request, reasoning: { strategy: 'disabled' } }));
    if (values.includes('deep')) {
      await provider.complete({ ...request, reasoning: { strategy: 'effort', effort: 'deep' } });
      assert.equal(sent.at(-1).think, 'deep');
    }
  });

for (const thinking of [undefined, { values: [false], default: false }])
  test(`Ollama does not infer reasoning controls from a capability label or model name: ${JSON.stringify(thinking)}`, async () => {
    const { provider, request, sent } = fixture(thinking, 'gpt-oss:20b');
    const profile = await provider.describeModel(request.model);
    assert.equal(profile.capabilities.reasoning, undefined);
    assert(!profile.supportedParameters.includes('reasoning'));
    const result = await provider.complete(request);
    assert.equal(sent[0].think, undefined);
    assert.equal(result.reasoning, 'Reasoning retained');
    await assert.rejects(
      provider.compileRequest({ ...request, reasoning: { strategy: 'enabled' } })
    );
  });

for (const thinking of [
  null,
  {},
  { values: [], default: true },
  { values: [true, true], default: true },
  { values: ['high'], default: 'low' },
  { values: [3], default: 3 },
  { values: [''], default: '' }
])
  test(`Ollama rejects malformed thinking metadata: ${JSON.stringify(thinking)}`, async () => {
    const { provider, request, sent } = fixture(thinking);
    await assert.rejects(
      provider.describeModel(request.model),
      (error) => error.code === 'malformed_response'
    );
    assert.equal(sent.length, 0);
  });
