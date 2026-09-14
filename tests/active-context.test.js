import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  ContextService,
  HistoryReader,
  InferenceService,
  InMemoryInferenceRepository,
  InMemorySessionRepository,
  agentEventCodec,
  sourceRef,
  validateAgentRunLimits
} from '@agent-core/runtime';
import { defineTool } from '@agent-core/tools';
import {
  MemorySimulationProvider,
  simulationProfile
} from './fixtures/context-policies/simulation.mjs';

const call = (name, id) => ({
  content: '',
  terminationReason: 'tool_calls',
  toolCalls: [{ type: 'function', id, name, input: { kind: 'json', value: {} } }]
});
const result = (output) => ({
  kind: 'result',

  output,
  summary: 'Observed.',
  scope: { resources: ['fixture'], coverage: 'complete' }
});
class Provider extends MemorySimulationProvider {
  constructor(respond) {
    super();
    this.respond = respond;
  }
  async complete(request) {
    this.calls.push(request);
    return {
      provider: this.id,
      model: request.model,
      content: '',
      terminationReason: 'stop',
      ...(await this.respond(request, this.calls.length))
    };
  }
}

for (const strategy of ['sources', 'provider']) {
  test(`${strategy}: settled exchanges leave an active run's attention while history survives`, async () => {
    const sessions = new InMemorySessionRepository();
    const session = await sessions.create({
      binding: { schemaId: 'active-context', schemaVersion: 1, subject: {} }
    });
    const events = new InMemoryEventRepository(agentEventCodec);
    const artifacts = new InMemoryArtifactRepository();
    const history = new HistoryReader({ repository: sessions, session, events, artifacts });
    const provider = new Provider((_request, turn) =>
      turn === 1
        ? call('read_item', 'read')
        : turn === 2
          ? call('select_context', 'select')
          : { content: 'Finished.' }
    );
    const inference = new InferenceService({
      provider,
      repository: new InMemoryInferenceRepository(),
      artifacts
    });
    let runtime;
    let original;
    const tools = [
      defineTool({
        name: 'read_item',
        implementationId: 'read-item@1',
        description: 'Read an item.',
        schema: z.strictObject({}),
        outputSchema: z.record(z.string(), z.json()),
        canonicalizeInput: (input) => input,
        deriveEffects: () => ({
          accesses: [{ mode: 'read', scope: 'fixture' }],
          lockScopes: [],
          recovery: { kind: 'unknown' }
        }),
        effectEnvelope: { accesses: [{ mode: 'read', scope: 'fixture' }], lockScopes: [] },
        invoke: () => result({ value: 'ARCHIVED-DETAIL-739' })
      }),
      defineTool({
        name: 'select_context',
        implementationId: 'select-context@1',
        description: 'Select context.',
        schema: z.strictObject({}),
        outputSchema: z.record(z.string(), z.json()),
        canonicalizeInput: (input) => input,
        deriveEffects: () => ({
          accesses: [{ mode: 'write', scope: 'context' }],
          lockScopes: [],
          recovery: { kind: 'unknown' }
        }),
        effectEnvelope: { accesses: [{ mode: 'write', scope: 'context' }], lockScopes: [] },
        async invoke(_input, execution) {
          const view = await history.page({ limit: 1000, maxBytes: 4 * 1024 * 1024 });
          const exchange = view.entries.filter(
            (entry) => 'turnIndex' in entry && entry.turnIndex === 1
          );
          original = exchange.find((entry) => entry.type === 'observation');
          const retained =
            strategy === 'provider'
              ? view.entries
              : view.entries.filter((entry) => !exchange.includes(entry));
          await runtime.scheduleContextTransition({
            toolInvocation: Object.fromEntries(
              ['runId', 'turnId', 'requestAttempt', 'toolBatchId', 'callIndex', 'toolAttempt'].map(
                (key) => [key, execution.invocation[key]]
              )
            ),
            expectedWindowId: null,
            idempotencyKey: 'select',
            reason: 'Completed exchange is no longer needed.',
            selection: {
              strategy,
              retained: retained.map((entry) => sourceRef(session.id, entry)),
              notes: []
            }
          });
          return result({ scheduled: true });
        }
      })
    ];
    const context = new ContextService({
      repository: sessions,
      session,
      history,
      policy: {
        maxSourceBytes: 1_000_000,
        historyRead: { history, isAvailable: () => true }
      }
    });
    runtime = new AgentRuntime({
      provider,
      model: simulationProfile.id,
      inferenceService: inference,
      inferenceOwnerId: 'work',
      context,
      repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
      tools,
      toolPolicy: { allowedRisks: ['read', 'write'] },
      toolBoundary: { authorizationPolicyId: 'fixture', executionTargetId: 'fixture' }
    });
    const completed = await runtime.run({
      runId: 'work',
      task: 'Keep working after changing context.'
    }).result;
    assert.equal(
      completed.terminal?.executionStatus,
      'completed',
      JSON.stringify({ completed, events: await Array.fromAsync(events.read('work')) })
    );
    const records = [];
    for await (const record of events.read('work'))
      if (record.event.type === 'context.transition.rejected' || record.event.type === 'tool.ended')
        records.push(record.event);
    assert.ok((await context.inspect()).window, JSON.stringify(records));
    const next = provider.calls.at(-1);
    assert.ok(!JSON.stringify(next.messages).includes('ARCHIVED-DETAIL-739'));
    assert.equal(
      next.messages.filter((message) => message.content === 'Keep working after changing context.')
        .length,
      1
    );
    const archived = await history.read({
      source: sourceRef(session.id, original),
      maxBytes: 16_384
    });
    assert.equal(archived.status, 'available');
    assert.match(archived.item.text, /ARCHIVED-DETAIL-739/);
    if (strategy === 'provider')
      assert.equal(next.messages.filter((message) => message.role === 'protocol').length, 1);
    else
      assert.ok(
        next.messages.some((message) => message.role === 'tool' && message.toolCallId === 'select')
      );
  });
}

test(
  'work budgets are explicit and failed tool observations do not impose a stopping policy',
  { timeout: 30_000 },
  async (t) => {
    const defaults = validateAgentRunLimits();
    for (const field of [
      'modelTurns',
      'totalToolCalls',
      'elapsedMs',
      'promptTokens',
      'completionTokens',
      'knownCost'
    ])
      assert.equal(defaults[field], undefined);
    const tool = defineTool({
      name: 'inspect_item',
      implementationId: 'inspect-item@1',
      description: 'Inspect an item.',
      schema: z.strictObject({}),
      outputSchema: z.record(z.string(), z.json()),
      canonicalizeInput: (input) => input,
      deriveEffects: () => ({
        accesses: [{ mode: 'read', scope: 'fixture' }],
        lockScopes: [],
        recovery: { kind: 'unknown' }
      }),
      effectEnvelope: { accesses: [{ mode: 'read', scope: 'fixture' }], lockScopes: [] },
      invoke: () => result({ available: false })
    });
    for (const limits of [undefined, { modelTurns: 3 }]) {
      const provider = new Provider((_request, turn) =>
        turn <= 7 ? call('inspect_item', `inspect-${turn}`) : { content: 'Finished.' }
      );
      const runtime = new AgentRuntime({
        provider,
        model: simulationProfile.id,
        tools: [tool],
        limits,
        repositories: {
          events: new InMemoryEventRepository(agentEventCodec),
          artifacts: new InMemoryArtifactRepository()
        },
        toolPolicy: { allowedRisks: ['read'] },
        toolBoundary: { authorizationPolicyId: 'fixture', executionTargetId: 'fixture' }
      });
      const completed = await runtime.run({
        task: 'Inspect the requested items.',
        signal: t.signal
      }).result;
      assert.equal(completed.terminal.executionStatus, limits ? 'failed' : 'completed');
      assert.equal(completed.terminal.budget.modelTurns, limits ? 3 : 8);
      if (limits) assert.equal(completed.terminal.exhaustedLimit, 'model_turns');
    }
  }
);
