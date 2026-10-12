import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRunCoordinator, AgentRuntime, AgentSession, ContextService, HistoryReader,
  InMemorySessionRepository, agentEventCodec, createHistoryTools
} from '@agent-core/runtime';

for (const nextResponse of ['tool', 'stop'])
  test(`active selection delivers its terminal rejection when the in-flight response is ${nextResponse}`, async () => {
    const repository = new InMemorySessionRepository();
    const binding = { schemaId: 'tests/context-selection-delivery', schemaVersion: 1, subject: {} };
    const descriptor = await repository.create({ binding });
    const events = new InMemoryEventRepository(agentEventCodec);
    const artifacts = new InMemoryArtifactRepository();
    const history = new HistoryReader({ repository, session: descriptor, events, artifacts });
    const context = new ContextService({ repository, session: descriptor, history, artifacts,
      policy: { maxSourceBytes: 4 * 1024 * 1024, historyRead: { history, isAvailable: () => true } } });
    let release, entered, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const provider = {
      id: 'fixture', implementationId: 'fixture@1',
      describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'fixture' }),
      describeModel: async () => ({
        id: 'fixture', provider: 'fixture',
        capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }],
          jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
        modalities: { input: ['text'], output: ['text'] },
        limits: { contextTokens: 60000, outputTokens: 256 },
        supportedParameters: ['maxOutputTokens', 'tools']
      }),
      complete: async () => {
        if (++calls === 1) {
          entered();
          await gate;
          if (nextResponse === 'tool') return {
            provider: 'fixture', model: 'fixture', content: '', terminationReason: 'tool_calls',
            toolCalls: [{ type: 'function', id: 'inspect', name: 'context_inspect',
              input: { kind: 'json', value: { limit: 10, maxBytes: 8192 } } }]
          };
        }
        return { provider: 'fixture', model: 'fixture', content: 'Finished.', terminationReason: 'stop' };
      }
    };
    const runtimeOptions = {
      provider, model: 'fixture', context, maxOutputTokens: 128,
      tools: [...createHistoryTools({ history }), ...context.toolDefinitions()],
      repositories: { events, artifacts, session: { repository, descriptor } },
      toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
      toolPolicy: { allowedRisks: ['read', 'write'] }
    };
    const session = new AgentSession({
      descriptor, expectedBinding: binding, repository, context,
      runs: new AgentRunCoordinator(events, artifacts),
      configuration: { provider: provider.id, model: 'fixture' },
      createRuntime: (_configuration, onProgress) => new AgentRuntime({ ...runtimeOptions, onProgress })
    });
    const delivered = [];
    session.subscribe(event => { delivered.push(event); }, error => { throw error; });
    const submission = await session.submit({ task: 'Current accepted request.' });
    try {
      await started;
      const inspected = await context.inspect();
      const request = {
        expectedWindowId: inspected.window?.windowId ?? null,
        expectedSourceRevision: inspected.cut.sourceRevision,
        idempotencyKey: `selection-${nextResponse}`, reason: 'Apply the inspected originals.',
        selection: inspected.activeSelection.selection
      };
      const scheduled = await session.transitionContext(request);
      assert.equal(scheduled.kind, 'scheduled');
      release();
      const result = await submission.completion;
      assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
      assert.equal((await context.inspect()).window, null, 'rejected selections must not change the committed window');
      const rejections = delivered.filter(event => event.type === 'context.transition.rejected');
      assert.equal(rejections.length, 1, JSON.stringify(delivered.map(event => event.type)));
      assert.equal(rejections[0].requestId, scheduled.requestId);
      assert.equal(rejections[0].idempotencyKey, request.idempotencyKey);
      assert.match(rejections[0].message, nextResponse === 'tool' ? /source revision is stale/ : /ended|terminal|completed/i);
      const recorded = await events.readRange(submission.runId, {
        afterSequence: -1, through: await events.tail(submission.runId),
        types: ['context.transition.rejected', 'context.transition.completed']
      });
      assert.deepEqual(recorded.records.map(record => record.event.type), ['context.transition.rejected']);
      assert.equal(delivered.some(event => event.type === 'run.progress' && event.event.type === 'context.transition.rejected'), true);
      const callsBeforeRestart = calls;
      const resumed = await new AgentRuntime(runtimeOptions).resume(submission.runId).result;
      assert.deepEqual(resumed.terminal, result.terminal);
      assert.equal(calls, callsBeforeRestart, 'terminal replay does not reopen model work or selection');
      const replayed = await events.readRange(submission.runId, {
        afterSequence: -1, through: await events.tail(submission.runId),
        types: ['context.transition.rejected', 'context.transition.completed']
      });
      assert.deepEqual(replayed.records.map(record => record.event.type), ['context.transition.rejected']);
    } finally {
      release();
      await session.close();
    }
  });
