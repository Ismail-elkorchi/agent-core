import assert from 'node:assert/strict';

/** A deterministic provider adapter. The production AgentRuntime owns every model/tool turn. */
export function collaborationProvider(steps = []) {
  const requests = [];
  const profile = {
    id: 'collaboration-fixture',
    provider: 'collaboration-fixture',
    capabilities: {
      streaming: false,
      toolCalling: true,
      supportedToolInputs: [{ kind: 'json' }],
      jsonMode: false,
      jsonSchema: false,
      logprobs: false,
      temperature: false,
      topP: false
    },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 32_000, outputTokens: 256 },
    supportedParameters: ['maxOutputTokens']
  };
  const provider = {
    id: profile.provider,
    implementationId: 'tests/collaboration-provider@1',
    describe: () => ({
      id: profile.provider,
      displayName: 'Deterministic collaboration fixture',
      defaultModel: profile.id
    }),
    describeModel: async () => profile,
    async complete(request) {
      const index = requests.length;
      requests.push(request);
      const step = steps[index];
      assert.ok(step, `Unexpected provider dispatch ${index + 1}.`);
      const output = typeof step === 'function' ? await step(request, index) : step;
      return {
        provider: profile.provider,
        model: profile.id,
        content: 'Complete.',
        terminationReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        ...output
      };
    }
  };
  return { provider, profile, requests };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
