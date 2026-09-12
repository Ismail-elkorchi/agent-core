import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import * as z from 'zod';
import {
  AgentRuntime,
  AgentSession,
  AgentRunCoordinator,
  InferenceService,
  InMemoryInferenceRepository,
  InMemorySessionRepository,
  HistoryReader,
  agentEventCodec
} from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { defineTool } from '@agent-core/tools';
import { MemorySimulationProvider, simulationProfile } from './fixtures/context-policies/simulation.mjs';

const binding = {
  schemaId: 'neutral-composition',
  schemaVersion: 1,
  subject: { application: 'neutral-tests' }
};
const toolBoundary = { authorizationPolicyId: 'neutral-read@1', executionTargetId: 'neutral-memory' };

class NeutralProvider extends MemorySimulationProvider {
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
      ...(await this.respond(request))
    };
  }
}

async function composition(provider, options = {}) {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ binding });
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  const runtime = (additional = {}) =>
    new AgentRuntime({
      provider,
      model: simulationProfile.id,
      toolBoundary,
      repositories: { artifacts, events, session: { repository, descriptor } },
      maxOutputTokens: 128,
      limits: { modelTurns: 4, totalToolCalls: 4 },
      ...options,
      ...additional
    });
  return { repository, descriptor, artifacts, events, runtime };
}

function assertNeutralCompletion(result) {
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'completed');
}

test('plain assistant retains complete user contributions across runs without a domain workflow', async () => {
  const provider = new NeutralProvider(() => ({ content: 'Acknowledged.' }));
  const system = 'You are a conversational assistant.';
  const developer = 'Use a friendly tone.';
  const app = await composition(provider, {
    instructions: [
      { id: 'purpose', role: 'system', content: system },
      { id: 'tone', role: 'developer', content: developer }
    ]
  });
  const original = `${'An ordinary detail. '.repeat(70)}My favorite bird is the kingfisher; remember its exact name.`;
  assertNeutralCompletion(await app.runtime().run({ task: original }).result);
  for (let i = 0; i < 9; i += 1)
    assertNeutralCompletion(
      await app.runtime().run({ task: `An unrelated conversational aside ${i}.` }).result
    );
  assertNeutralCompletion(await app.runtime().run({ task: 'What bird did I mention?' }).result);
  const request = provider.calls.at(-1);
  assert.equal(
    request.messages.filter((item) => item.role === 'user' && item.content.includes(original)).length,
    1
  );
  assert.deepEqual(
    provider.calls[0].messages
      .filter((item) => item.role === 'system' || item.role === 'developer')
      .map(({ role, content }) => ({ role, content })),
    [
      { role: 'system', content: system },
      { role: 'developer', content: developer }
    ]
  );
  assert.equal(request.tools?.length ?? 0, 0);
  const history = new HistoryReader({
    repository: app.repository,
    session: app.descriptor,
    events: app.events,
    artifacts: app.artifacts
  });
  const found = await history.search({
    query: 'kingfisher',
    filter: { role: 'user' },
    maxBytes: 8000,
    limit: 5
  });
  assert.equal(found.items.length, 1);
  const read = await history.read({ source: found.items[0].source, maxBytes: 8000 });
  assert.equal(read.status, 'available');
  assert.ok(read.item.text.includes(original));
  assert.equal((await app.repository.loadReplayState(app.descriptor)).runFinalizations.length, 11);
});

test('standalone governed classifier settles structured output with no natural-language answer or interactive run', async () => {
  const classification = { label: 'support', confidence: 0.9 };
  const call = {
    type: 'function',
    id: 'classification-1',
    name: 'classify',
    input: { kind: 'json', value: classification }
  };
  const provider = new NeutralProvider(() => ({
    content: '',
    toolCalls: [call],
    output: [{ type: 'tool_call', toolCall: call }],
    terminationReason: 'tool_calls'
  }));
  const repository = new InMemoryInferenceRepository();
  const service = new InferenceService({
    provider,
    repository,
    artifacts: new InMemoryArtifactRepository(),
    budget: { maxInvocations: 1, maxPromptTokens: 10000, maxCompletionTokens: 256 }
  });
  const input = {
    invocationId: 'classification-1',
    ownerId: 'inbox-1',
    purpose: 'message-classification',
    request: {
      model: simulationProfile.id,
      maxOutputTokens: 128,
      messages: [
        {
          role: 'developer',
          content: 'Classify the message using the classify structured result. No prose answer is required.'
        },
        { role: 'user', content: 'Please help restore my account access.' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'classify',
            description: 'Return the classification data.',
            parameters: {
              type: 'object',
              properties: { label: { type: 'string' }, confidence: { type: 'number' } },
              required: ['label', 'confidence'],
              additionalProperties: false
            }
          }
        }
      ]
    }
  };
  const first = await service.invoke(input);
  assert.equal(first.status, 'settled');
  assert.equal(first.response.content, '');
  assert.deepEqual(first.response.output[0].toolCall.input.value, classification);
  const replay = await service.invoke(input);
  assert.equal(replay.replayed, true);
  assert.equal(provider.calls.length, 1);
  const state = await repository.load(input.ownerId);
  assert.equal(state.invocations.size, 1);
  assert.ok(state.invocations.get(input.invocationId).settlement);
});

test('read-only monitor becomes idle until a real external contribution resumes its session', async () => {
  let externalStatus = 'waiting_for_external_input';
  let reads = 0;
  const access = { accesses: [{ mode: 'read', scope: 'external-status' }], lockScopes: [] };
  const readStatus = defineTool({
    name: 'read_status',
    implementationId: 'neutral-status@1',
    description: 'Read the current external status.',
    schema: z.strictObject({}),
    outputSchema: z.strictObject({ status: z.string() }),
    effectEnvelope: access,
    canonicalizeInput: (input) => input,
    deriveEffects: () => ({ ...access, recovery: { kind: 'unknown' } }),
    invoke: async () => {
      reads += 1;
      return {
        kind: 'result',
        ok: true,
        output: { status: externalStatus },
        summary: externalStatus,
        scope: { resources: ['external-status'], coverage: 'complete' }
      };
    }
  });
  const provider = new NeutralProvider((request) => {
    if (request.messages.at(-1).role === 'tool')
      return { content: JSON.stringify({ state: externalStatus }) };
    return {
      toolCalls: [
        {
          type: 'function',
          id: `read-${reads + 1}`,
          name: 'read_status',
          input: { kind: 'json', value: {} }
        }
      ],
      terminationReason: 'tool_calls'
    };
  });
  const app = await composition(provider, { tools: [readStatus], toolPolicy: { allowedRisks: ['read'] } });
  const session = new AgentSession({
    descriptor: app.descriptor,
    expectedBinding: binding,
    repository: app.repository,
    runs: new AgentRunCoordinator(app.events),
    configuration: { provider: provider.id, model: simulationProfile.id },
    createRuntime: (_configuration, onProgress) => app.runtime({ onProgress })
  });
  const first = await session.submit({
    task: 'Read the status once. When there is no new input, wait for an external contribution.'
  });
  assert.equal(first.kind, 'started');
  const waiting = await first.completion;
  assertNeutralCompletion(waiting);
  assert.equal(JSON.parse(waiting.terminal.modelOutput.message).state, 'waiting_for_external_input');
  assert.equal(session.state().phase, 'idle');
  const callsWhileWaiting = provider.calls.length;
  await setImmediate();
  assert.equal(provider.calls.length, callsWhileWaiting);
  assert.equal(reads, 1);
  externalStatus = 'ready';
  const next = await session.submit({
    task: 'An external contribution has arrived. Read the updated status once.'
  });
  assert.equal(next.kind, 'started');
  const ready = await next.completion;
  assertNeutralCompletion(ready);
  assert.equal(JSON.parse(ready.terminal.modelOutput.message).state, 'ready');
  assert.equal(session.state().phase, 'idle');
  assert.equal(reads, 2);
  for (const runId of [waiting.terminal.runId, ready.terminal.runId]) {
    const entries = [];
    for await (const { event } of app.events.read(runId)) entries.push(event);
    assert.equal(entries.filter((event) => event.type === 'run.ended').length, 1);
    assert.equal(entries.filter((event) => event.type === 'tool.started').length, 1);
    assert.ok(
      entries
        .filter((event) => event.type === 'tool.started')
        .every((event) => event.effects.accesses.every((access) => access.mode === 'read'))
    );
    assert.equal(entries.filter((event) => event.type === 'check.started').length, 0);
    for (const event of entries.filter((event) => event.type === 'run.disposition.decided'))
      assert.deepEqual(event.decision, { kind: 'accept' });
  }
});
