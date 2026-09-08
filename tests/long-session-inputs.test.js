import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, InMemorySessionRepository, agentEventCodec } from '@agent-core/runtime';

test(
  '1,000 completed inputs retain exact conversation until an explicit context change',
  { timeout: 180_000 },
  async (context) => {
    const sessions = new InMemorySessionRepository();
    const session = await sessions.create({
      binding: { schemaId: 'tests/long-conversation', schemaVersion: 1, subject: {} }
    });
    const accepted = [];
    const inspected = [];
    const boundaries = new Set([1, 10, 100, 1_000]);
    const profile = {
      id: 'conversation-fixture',
      provider: 'conversation-fixture',
      capabilities: {
        streaming: false,
        toolCalling: false,
        supportedToolInputs: [],
        jsonMode: false,
        jsonSchema: false,
        logprobs: false,
        temperature: false,
        topP: false
      },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 1_000_000, outputTokens: 128 },
      supportedParameters: ['maxOutputTokens']
    };
    const provider = {
      id: profile.provider,
      implementationId: 'tests/long-conversation@1',
      describe: () => ({
        id: profile.provider,
        displayName: 'Deterministic conversation fixture',
        defaultModel: profile.id
      }),
      describeModel: async () => profile,
      async complete(request) {
        const count = accepted.length;
        if (boundaries.has(count)) {
          const originalInputs = request.messages
            .filter((item) => item.role === 'user')
            .map((item) => item.content);
          for (const input of accepted) {
            assert.equal(
              originalInputs.filter((content) => content === input).length,
              1,
              `Original input must appear exactly once at conversation boundary ${String(count)}.`
            );
          }
          const replies = request.messages
            .filter((item) => item.role === 'assistant')
            .map((item) => item.content);
          for (let index = 1; index < count; index++) {
            assert.equal(
              replies.filter((content) => content === `acknowledged:${String(index)}`).length,
              1
            );
          }
          inspected.push(count);
        }
        return {
          provider: profile.provider,
          model: profile.id,
          content: `acknowledged:${String(count)}`,
          terminationReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
        };
      }
    };
    const runtime = new AgentRuntime({
      provider,
      model: profile.id,
      maxOutputTokens: 64,
      toolBoundary: { authorizationPolicyId: 'tests/none', executionTargetId: 'tests/conversation' },
      repositories: {
        events: new InMemoryEventRepository(agentEventCodec),
        artifacts: new InMemoryArtifactRepository(),
        session: { repository: sessions, descriptor: session }
      }
    });
    for (let index = 1; index <= 1_000; index++) {
      context.signal.throwIfAborted();
      const task =
        index === 1
          ? `${'Detailed background. '.repeat(80)}Continuing requirement: retain identifier AMBER-731.`
          : index === 501
            ? 'Correction: the continuing identifier is INDIGO-842. This supersedes AMBER-731.'
            : `Conversation contribution ${String(index)}.`;
      accepted.push(task);
      const result = await runtime.run({ task, signal: context.signal }).result;
      assert.equal(result.state, 'ended', `Contribution ${String(index)} did not end.`);
      assert.equal(result.terminal.executionStatus, 'completed');
      if (index % 250 === 0) context.diagnostic(`Retained ${String(index)} complete inputs and replies.`);
    }
    assert.deepEqual(inspected, [1, 10, 100, 1_000]);
  }
);
