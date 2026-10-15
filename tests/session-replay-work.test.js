import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, HistoryReader, InMemorySessionRepository, agentEventCodec } from '@agent-core/runtime';

// Count the authority boundary, rather than setting a machine-dependent timing budget.
test('compatibility validation and replay consume one captured selected history per input', async t => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'tests/replay-work', schemaVersion: 1, subject: {} }
  });
  const counts = { captures: 0, orders: 0 };
  const capture = HistoryReader.prototype.capture;
  const orderEntries = HistoryReader.prototype.orderEntries;
  t.mock.method(HistoryReader.prototype, 'capture', function (...args) {
    counts.captures++;
    return capture.apply(this, args);
  });
  t.mock.method(HistoryReader.prototype, 'orderEntries', function (...args) {
    counts.orders++;
    return orderEntries.apply(this, args);
  });
  const profile = {
    id: 'replay-work', provider: 'replay-work',
    capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [],
      jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 1_000_000, outputTokens: 128 },
    supportedParameters: ['maxOutputTokens']
  };
  const inputs = [];
  const provider = {
    id: profile.provider, implementationId: 'tests/replay-work@1',
    describe: () => ({ id: profile.provider, displayName: 'Replay work fixture', defaultModel: profile.id }),
    describeModel: async () => profile,
    async complete(request) {
      assert.deepEqual(request.messages.filter(item => item.role === 'user').map(item => item.content), inputs);
      return { provider: profile.provider, model: profile.id, content: `reply:${inputs.length}`,
        terminationReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  };
  const runtime = new AgentRuntime({
    provider, model: profile.id, maxOutputTokens: 64,
    toolBoundary: { authorizationPolicyId: 'tests/none', executionTargetId: 'tests/replay-work' },
    repositories: { events: new InMemoryEventRepository(agentEventCodec), artifacts: new InMemoryArtifactRepository(),
      session: { repository: sessions, descriptor: session } }
  });
  for (let index = 0; index < 10; index++) {
    const task = index === 5 ? 'Correction: INDIGO-842 supersedes AMBER-731.' : `Original input ${index}: AMBER-731`;
    inputs.push(task);
    const result = await runtime.run({ task }).result;
    assert.equal(result.state, 'ended');
    assert.equal(result.terminal.executionStatus, 'completed');
    assert.deepEqual(counts, { captures: index + 1, orders: index + 1 },
      'Each input must validate and replay the same selected source cut exactly once.');
  }
});
