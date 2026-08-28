import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AgentRuntime,
  AgentFinalizationError,
  AgentRunFinalizer,
  agentEventCodec,
  decodeAgentEvent,
  readCommittedTerminal
} from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/evidence';
import { ModelProviderError } from '@agent-core/model';
import * as z from 'zod';
import {
  deriveAgentVerificationStatus,
  decodeAgentTerminalSnapshot
} from '@agent-core/runtime';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { adoptToolDefinition, parseToolObservation } from '@agent-core/tools';

const capabilities = {
  streaming: false,
  toolCalling: true,
  supportedToolInputs: [{ kind: 'json' }],
  jsonMode: false,
  jsonSchema: false,
  logprobs: false,
  temperature: true,
  topP: true,
  reasoning: undefined
};
const toolBoundary = { authorizationPolicyId: 'tests/agent-core-policy@1', executionTargetId: 'tests/agent-core-target' };
const emptyOutputSchema = z.strictObject({});
const readEnvelope = { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] };
const readEffects = { ...readEnvelope, recovery: { kind: 'unknown' } };
const completeScope = { resources: ['memory'], coverage: 'complete' };

function ended(result) {
  assert.equal(result.state, 'ended');
  return { ...result.terminal, deliveryDiagnostics: result.deliveryDiagnostics };
}

function profile(model = 'scripted', overrides = {}) {
  return {
    id: model,
    provider: 'scripted',
    capabilities: { ...capabilities, ...(overrides.capabilities ?? {}) },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 16_000, outputTokens: 2_000 },
    supportedParameters: ['temperature', 'maxOutputTokens'],
    ...overrides
  };
}

function response(terminationReason = 'stop', content = 'done', extra = {}) {
  return { content, model: 'scripted', provider: 'scripted', terminationReason, ...extra };
}

class ScriptedProvider {
  id = 'scripted';
  calls = [];
  constructor(script, options = {}) { this.script = [...script]; this.options = options; }
  describe() { return { id: this.id, displayName: 'Scripted', defaultModel: 'scripted' }; }
  async describeModel(model) { return profile(model, typeof this.options.profile === 'function' ? this.options.profile(model) : this.options.profile ?? {}); }
  async complete(request) {
    this.calls.push(request);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(request);
    return { ...next, model: request.model };
  }
}

async function harness(options = {}) {
  const events = options.events ?? new InMemoryEventRepository(agentEventCodec);
  const sessions = options.sessions ?? new InMemorySessionRepository();
  const session = options.withoutSession ? undefined : await sessions.create({ provider: 'scripted', model: 'scripted' });
  const artifacts = options.artifacts ?? new InMemoryArtifactRepository();
  const provider = options.provider ?? new ScriptedProvider(options.script ?? [response()]);
  const agent = new AgentRuntime({
    provider,
    model: options.model ?? 'scripted',
    toolBoundary: options.toolBoundary ?? toolBoundary,
    repositories: {
      events,
      ...(session ? { session: { repository: sessions, sessionId: session.id } } : {}),
      artifacts
    },
    ...(options.checks ? { checks: options.checks } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.tools ? { tools: options.tools.map(adoptToolDefinition) } : {}),
    ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
    ...(options.toolAuthorizer ? { toolAuthorizer: options.toolAuthorizer } : {}),
    ...(options.toolContext ? { toolContext: options.toolContext } : {}),
    ...(options.contextItems ? { contextItems: options.contextItems } : {}),
    ...(options.contextProvider ? { contextProvider: options.contextProvider } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
    ...(options.clock ? { clock: options.clock } : {})
  });
  return { agent, provider, events, sessions, session, artifacts };
}

test('runtime exposes artifact and image tools only with the required repository and model modality', async () => {
  const conditionalTool = (name) => ({
    name,
    implementationId: `tests/${name}@1`,
    description: name,
    jsonSchema: { type: 'object' },
    outputSchema: emptyOutputSchema,
    requirements: name === 'view_image' ? { services: ['artifactRepository'], modelInputModalities: ['image'] } : { services: ['artifactRepository'] },
    effectEnvelope: readEnvelope,
    decodeInput() { return { ok: true, input: {} }; },
    canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; },
    deriveEffects() { return readEffects; },
    async invoke() { return { kind: 'result', ok: true, output: {}, summary: 'ok', scope: completeScope }; }
  });
  const tools = [conditionalTool('read_artifact'), conditionalTool('view_image')].map(adoptToolDefinition);

  const textProvider = new ScriptedProvider([response()]);
  const textAgent = new AgentRuntime({
    provider: textProvider,
    model: 'scripted',
    toolBoundary,
    repositories: { events: new InMemoryEventRepository(agentEventCodec) },
    tools,
    toolPolicy: { allowedRisks: ['read'] }
  });
  await textAgent.run({ task: 'text only' }).result;
  assert.deepEqual((textProvider.calls[0].tools ?? []).map(modelToolName), []);

  const imageProvider = new ScriptedProvider([response()], { profile: { modalities: { input: ['text', 'image'], output: ['text'] } } });
  const imageArtifacts = new InMemoryArtifactRepository();
  const imageAgent = new AgentRuntime({
    provider: imageProvider,
    model: 'scripted',
    toolBoundary,
    repositories: { events: new InMemoryEventRepository(agentEventCodec), artifacts: imageArtifacts },
    tools,
    toolPolicy: { allowedRisks: ['read'] }
  });
  await imageAgent.run({ task: 'image capable' }).result;
  assert.deepEqual((imageProvider.calls[0].tools ?? []).map(modelToolName), ['read_artifact', 'view_image']);
});

function modelToolName(tool) {
  return tool.type === 'function' ? tool.function.name : tool.name;
}

test('tool progress from preparation and invocation remains separate from the final observation', async () => {
  const progress = [];
  const tool = adoptToolDefinition({
    name: 'progress_tool', implementationId: 'tests/progress-tool@1', description: 'progress', jsonSchema: { type: 'object' }, outputSchema: emptyOutputSchema, effectEnvelope: readEnvelope,
    decodeInput() { return { ok: true, input: {} }; },
    async canonicalizeInput(input, context) { await context.emitProgress?.({ type: 'status', stage: 'canonicalize' }); return input; }, snapshotInput(input) { return input; },
    deriveEffects() { return readEffects; },
    async invoke(_input, context) { await context.emitProgress?.({ type: 'status', stage: 'invoke' }); return { kind: 'result', ok: true, output: {}, summary: 'done', scope: completeScope }; }
  });
  const { agent, events } = await harness({
    tools: [tool],
    script: [response('tool_calls', '', { toolCalls: [{ id: 'progress', type: 'function', name: tool.name, input: { kind: 'json', value: {} } }] }), response()],
    onProgress(event) { if (event.type === 'tool.updated' && event.progress.type === 'status') progress.push(event.progress.stage); }
  });
  const result = ended(await agent.run({ task: 'report progress' }).result);
  assert.deepEqual(progress.filter((stage) => stage === 'canonicalize' || stage === 'invoke'), ['canonicalize', 'invoke']);
  const persisted = await eventsFor(events, result.runId);
  assert.deepEqual(persisted.filter((event) => event.type === 'tool.updated' && event.progress.type === 'status').map((event) => event.progress.stage).filter((stage) => stage === 'canonicalize' || stage === 'invoke'), []);
  assert.equal(persisted.filter((event) => event.type === 'tool.ended').length, 1);
});

test('oversized tool observations keep domain output intact in an artifact', async () => {
  const items = Array.from({ length: 2_000 }, (_unused, index) => ({ id: index, value: `item-${String(index)}-${'x'.repeat(20)}` }));
  const tool = adoptToolDefinition({
    name: 'large_result', implementationId: 'tests/large-result@1', description: 'large result', jsonSchema: { type: 'object' },
    outputSchema: z.strictObject({ items: z.array(z.strictObject({ id: z.int(), value: z.string() })) }), effectEnvelope: readEnvelope,
    decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return readEffects; },
    async invoke() { return { kind: 'result', ok: true, output: { items }, summary: 'large result complete', scope: completeScope }; }
  });
  const { agent, events, artifacts } = await harness({
    tools: [tool],
    script: [response('tool_calls', '', { toolCalls: [{ id: 'large', type: 'function', name: tool.name, input: { kind: 'json', value: {} } }] }), response()]
  });
  const result = ended(await agent.run({ task: 'preserve output' }).result);
  const persistedEvents = await eventsFor(events, result.runId);
  const observationEvent = persistedEvents.find((event) => event.type === 'observation.record.created');
  assert.ok(observationEvent, JSON.stringify({ types: persistedEvents.map((event) => event.type), terminal: result }));
  assert.equal(observationEvent.immediatePresentation.summary, 'large result complete');
  assert.equal(observationEvent.immediatePresentation.truncated, true);
  const artifactId = observationEvent.immediatePresentation.results.artifact.artifactId;
  const artifact = await artifacts.resolve(artifactId);
  const stored = JSON.parse(new TextDecoder().decode(await artifacts.readVerified(artifact)));
  assert.equal(stored.output.items.length, items.length);
});

test('artifact-store failure after a completed tool effect still persists tool.ended and a degraded diagnostic', async () => {
  class FailingArtifacts extends InMemoryArtifactRepository { async store() { throw new Error('artifact store failed'); } }
  let effects = 0;
  const tool = {
    name: 'degraded_result', implementationId: 'tests/degraded-result@1', description: 'degraded result', jsonSchema: { type: 'object' },
    outputSchema: z.strictObject({ payload: z.string() }), effectEnvelope: { accesses: [{ mode: 'write', scope: 'memory' }], lockScopes: ['memory'] },
    decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; },
    deriveEffects() { return { accesses: [{ mode: 'write', scope: 'memory' }], lockScopes: ['memory'], recovery: { kind: 'unknown' } }; },
    async invoke() { effects += 1; return { kind: 'result', ok: true, output: { payload: 'x'.repeat(400_000) }, summary: 'effect completed', scope: completeScope }; }
  };
  const { agent, events } = await harness({
    artifacts: new FailingArtifacts(), tools: [tool], toolPolicy: { allowedRisks: ['read', 'write'] },
    script: [response('tool_calls', '', { toolCalls: [{ id: 'degraded', type: 'function', name: tool.name, input: { kind: 'json', value: {} } }] }), response()]
  });
  const result = ended(await agent.run({ task: 'complete despite degraded artifact storage' }).result);
  assert.equal(result.executionStatus, 'completed');
  assert.equal(effects, 1);
  const persisted = await eventsFor(events, result.runId);
  assert.equal(persisted.filter(event => event.type === 'tool.started').length, 1);
  assert.equal(persisted.filter(event => event.type === 'tool.ended').length, 1);
  const diagnostic = persisted.find(event => event.type === 'observation.record.created').durableStorageDegraded;
  assert.match(diagnostic.message, /artifact store failed/u);
  assert.equal(persisted.find(event => event.type === 'tool.ended').observation.metadata.durableStorage.status, 'degraded');
});

test('image and presenter projection failures happen after durable tool truth and preserve protocol pairing', async () => {
  const missingImage = {
    visibility: 'public', artifactId: 'missing-image', sha256: '0'.repeat(64), size: 4, mediaType: 'image/png'
  };
  class IntegrityFailingArtifacts extends InMemoryArtifactRepository {
    async readVerified(ref) { throw new Error(`Artifact SHA-256 integrity failure for ${ref.artifactId}`); }
  }
  const integrityArtifacts = new IntegrityFailingArtifacts();
  const integrityImage = await integrityArtifacts.store({ label: 'integrity-image', content: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png' });
  const cases = [
    {
      name: 'missing_image_projection', profile: { modalities: { input: ['text', 'image'], output: ['text'] } }, expected: /Unknown artifact/u,
      observation: { kind: 'result', ok: true, summary: 'image effect completed', scope: completeScope, content: [{ type: 'image', artifact: missingImage, detail: 'original' }], output: { artifact: missingImage } }
    },
    {
      name: 'image_integrity_projection', profile: { modalities: { input: ['text', 'image'], output: ['text'] } }, expected: /integrity failure/u,
      artifacts: integrityArtifacts,
      observation: { kind: 'result', ok: true, summary: 'image effect completed', scope: completeScope, content: [{ type: 'image', artifact: integrityImage, detail: 'original' }], output: { artifact: integrityImage } }
    },
    {
      name: 'presenter_projection', expected: /presenter exploded/u,
      presentObservation() { throw new Error('presenter exploded'); },
      observation: { kind: 'result', ok: true, summary: 'presenter effect completed', scope: completeScope, output: { changed: true } }
    }
  ];
  for (const scenario of cases) {
    let effects = 0;
    const tool = {
      name: scenario.name, implementationId: `tests/${scenario.name}@1`, description: scenario.name, jsonSchema: { type: 'object' }, outputSchema: z.unknown(), effectEnvelope: { accesses: [{ mode: 'write', scope: 'memory' }], lockScopes: ['memory'] },
      ...(scenario.profile ? { requirements: { modelInputModalities: ['image'] } } : {}),
      ...(scenario.presentObservation ? { presentObservation: scenario.presentObservation } : {}),
      decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; },
      deriveEffects() { return { accesses: [{ mode: 'write', scope: 'memory' }], lockScopes: ['memory'], recovery: { kind: 'unknown' } }; },
      async invoke() { effects += 1; return scenario.observation; }
    };
    const provider = new ScriptedProvider([
      response('tool_calls', '', { toolCalls: [{ id: `${scenario.name}-call`, type: 'function', name: scenario.name, input: { kind: 'json', value: {} } }] }),
      request => {
        const result = request.messages.find(message => message.role === 'tool' && message.toolName === scenario.name);
        assert.ok(result);
        assert.match(result.content, /durable tool result was committed/iu);
        return response('stop', 'continued after projection failure');
      }
    ], { ...(scenario.profile ? { profile: scenario.profile } : {}) });
    const { agent, events } = await harness({ provider, tools: [tool], toolPolicy: { allowedRisks: ['read', 'write'] }, withoutSession: true, ...(scenario.artifacts ? { artifacts: scenario.artifacts } : {}) });
    const result = ended(await agent.run({ task: scenario.name }).result);
    assert.equal(result.executionStatus, 'completed', JSON.stringify({ scenario: scenario.name, result }));
    assert.equal(effects, 1);
    const persisted = await eventsFor(events, result.runId);
    const endedIndex = persisted.findIndex(event => event.type === 'tool.ended');
    const failedIndex = persisted.findIndex(event => event.type === 'observation.projection.failed');
    assert.ok(endedIndex >= 0 && failedIndex > endedIndex);
    assert.match(persisted[failedIndex].message, scenario.expected);
    assert.equal(persisted.some(event => event.type === 'observation.record.created'), false);
  }
});

test('session and observation-record projection failures do not reclassify a completed effect', async () => {
  class FailingSessionRepository extends InMemorySessionRepository {
    async appendObservation() { throw new Error('session projection failed'); }
  }
  class FailingObservationEventRepository extends InMemoryEventRepository {
    failed = false;
    async append(runId, event, options) {
      if (event.type === 'observation.record.created' && !this.failed) { this.failed = true; throw new Error('observation event projection failed'); }
      return super.append(runId, event, options);
    }
  }
  const cases = [
    { sessions: new FailingSessionRepository(), expected: /session projection failed/u },
    { events: new FailingObservationEventRepository(agentEventCodec), expected: /observation event projection failed/u }
  ];
  for (const scenario of cases) {
    let effects = 0;
    const tool = {
      name: 'projection_effect', implementationId: 'tests/projection-effect@1', description: 'projection effect', jsonSchema: { type: 'object' }, outputSchema: z.unknown(),
      effectEnvelope: { accesses: [{ mode: 'write', scope: 'memory' }], lockScopes: ['memory'] },
      decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return { accesses: [{ mode: 'write', scope: 'memory' }], lockScopes: ['memory'], recovery: { kind: 'unknown' } }; },
      async invoke() { effects += 1; return { kind: 'result', ok: true, summary: 'effect committed', scope: completeScope, output: { done: true } }; }
    };
    const run = await harness({ ...scenario, tools: [tool], toolPolicy: { allowedRisks: ['read', 'write'] }, script: [response('tool_calls', '', { toolCalls: [{ id: 'projection', type: 'function', name: tool.name, input: { kind: 'json', value: {} } }] }), response()] });
    const result = ended(await run.agent.run({ task: 'projection failure' }).result);
    assert.equal(result.executionStatus, 'completed');
    assert.equal(effects, 1);
    const persisted = await eventsFor(run.events, result.runId);
    assert.equal(persisted.filter(event => event.type === 'tool.ended').length, 1);
    assert.match(persisted.find(event => event.type === 'observation.projection.failed').message, scenario.expected);
  }
});

async function eventsFor(repository, runId) {
  const output = [];
  for await (const record of repository.read(runId)) output.push(record.event);
  return output;
}

function toolStageKey(runId, identity, stage) {
  return `${runId}:tool:${identity.turnId}:${identity.toolBatchId}:${identity.callIndex}:attempt:${identity.toolAttempt}:${stage}`;
}

test('candidate mappings preserve execution, completeness, source, and verification independently', async () => {
  const cases = [
    [response('stop', 'complete'), 'completed', 'complete', 'content', 'model_completed'],
    [response('output_limit', 'partial'), 'completed', 'partial', 'content', 'model_output_limit'],
    [response('content_filter', 'filtered'), 'completed', 'partial', 'content', 'content_filtered'],
    [response('unknown', 'uncertain'), 'completed', 'indeterminate', 'content', 'unknown_model_termination'],
    [response('stop', '', { reasoningSummary: 'visible summary' }), 'completed', 'complete', 'reasoning_summary', 'model_completed'],
    [response('stop', '', { reasoning: 'private only' }), 'failed', 'absent', undefined, 'empty_response'],
    [response('tool_calls', ''), 'failed', 'absent', undefined, 'malformed_response']
  ];
  for (const [modelResponse, execution, status, source, termination] of cases) {
    const { agent, events } = await harness({ script: [modelResponse], withoutSession: true });
    const result = ended(await agent.run({ task: 'map candidate' }).result);    assert.equal(result.executionStatus, execution);
    assert.equal(result.candidate.status, status);
    if (source) assert.equal(result.candidate.source, source);
    assert.equal(result.terminationReason, termination);
    const assistant = (await eventsFor(events, result.runId)).find((event) => event.type === 'assistant.ended');
    assert.equal(assistant.candidate.status, status);
    if (source) assert.equal(assistant.candidate.source, source);
  }
});

test('stream interruption preserves a partial stream-recovery candidate and never verifies it', async () => {
  const provider = new ScriptedProvider([], { profile: { capabilities: { ...capabilities, streaming: true } } });
  provider.createSession = () => ({
    async complete() { throw new Error('not used'); },
    async *stream() { yield { type: 'content', content: 'part', accumulated: 'part' }; throw new Error('socket closed'); }
  });
  const { agent, events } = await harness({ provider, withoutSession: true });
  const result = ended(await agent.run({ task: 'stream' }).result);  assert.equal(result.executionStatus, 'failed');
  assert.deepEqual(result.candidate, { status: 'partial', message: 'part', source: 'stream_recovery', turnIndex: 1 });
  assert.equal(result.verificationStatus, 'not_run');
  const interrupted = (await eventsFor(events, result.runId)).find((event) => event.type === 'assistant.interrupted');
  assert.equal(interrupted.candidate.source, 'stream_recovery');
});

test('abort during verification produces aborted/not_run and preserves a partial candidate', async () => {
  const controller = new AbortController();
  const check = { id: 'wait', requirement: 'required', async run({ signal }) {
    setTimeout(() => controller.abort('stop verification'), 5);
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return { verdict: 'passed', summary: 'impossible' };
  } };
  const { agent } = await harness({ checks: [check] });
  const result = ended(await agent.run({ task: 'abort verification', signal: controller.signal }).result);  assert.equal(result.executionStatus, 'aborted');
  assert.equal(result.verificationStatus, 'not_run');
  assert.equal(result.candidate.status, 'partial');
  assert.equal(result.candidate.message, 'done');
});

test('abort requested while delivering the final check cannot commit completed verification', async () => {
  const controller = new AbortController();
  const { agent, events } = await harness({
    checks: [{ id: 'last', requirement: 'required', async run() { return { verdict: 'passed', summary: 'valid before cancellation' }; } }],
    onProgress(event) { if (event.type === 'check.ended') controller.abort('cancel at final check delivery'); }
  });
  const result = ended(await agent.run({ task: 'cancel at verification boundary', signal: controller.signal }).result);  assert.equal(result.executionStatus, 'aborted');
  assert.equal(result.verificationStatus, 'not_run');
  assert.equal(result.candidate.status, 'partial');
  const records = await eventsFor(events, result.runId);
  assert.equal(records.filter((event) => event.type === 'run.ended').length, 1);
  assert.equal(records.find((event) => event.type === 'run.ended').terminal.executionStatus, 'aborted');
});

test('abort at the finalization boundary wins before terminal preparation', async () => {
  const controller = new AbortController();
  const { agent, events } = await harness({
    onProgress(event) {
      if (event.type === 'run.phase.changed' && event.phase === 'finalizing') controller.abort('cancel before terminal preparation');
    }
  });
  const result = ended(await agent.run({ task: 'cancel at finalization boundary', signal: controller.signal }).result);  assert.equal(result.executionStatus, 'aborted');
  assert.equal(result.verificationStatus, 'not_run');
  assert.equal(result.candidate.status, 'partial');
  const records = await eventsFor(events, result.runId);
  const prepared = records.find((event) => event.type === 'finalization.prepared');
  const committed = records.find((event) => event.type === 'run.ended');
  assert.equal(prepared.terminal.executionStatus, 'aborted');
  assert.deepEqual(prepared.terminal, committed.terminal);
});

test('throwing check progress observer is a delivery diagnostic and cannot alter verification truth', async () => {
  const { agent, events } = await harness({
    checks: [{ id: 'sound', requirement: 'required', async run() { return { verdict: 'passed', summary: 'sound' }; } }],
    onProgress(event) { if (event.type === 'check.ended') throw new Error('check renderer broke'); }
  });
  const result = ended(await agent.run({ task: 'observer-independent verification' }).result);  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.verificationStatus, 'passed');
  assert.equal(result.candidate.status, 'complete');
  assert.equal(result.deliveryDiagnostics.some((item) => item.eventType === 'check.ended'), true);
  const records = await eventsFor(events, result.runId);
  assert.equal(records.filter((event) => event.type === 'run.ended').length, 1);
  assert.equal(records.filter((event) => event.type === 'delivery.failed' && event.diagnostic.eventType === 'check.ended').length, 1);
});

test('check timeouts and malformed verdicts become unknown instead of passing', async () => {
  const checks = [
    { id: 'timeout', requirement: 'required', timeoutMs: 10, async run() { return new Promise(() => {}); } },
    { id: 'bad', requirement: 'advisory', async run() { return { verdict: 'excellent', summary: 'not legal' }; } }
  ];
  const { agent } = await harness({ checks });
  const result = ended(await agent.run({ task: 'verify' }).result);  assert.equal(result.verificationStatus, 'inconclusive');
  assert.equal(result.checkResults[0].verdict, 'unknown');
  assert.equal(result.checkResults[0].diagnostic.kind, 'timeout');
  assert.equal(result.checkResults[1].verdict, 'unknown');
  assert.equal(result.checkResults[1].diagnostic.kind, 'invalid_result');
});

test('duplicate check IDs are rejected before model execution and missing required results are inconclusive', async () => {
  const provider = new ScriptedProvider([response()]);
  assert.throws(() => new AgentRuntime({ provider, model: 'scripted', toolBoundary, repositories: { events: new InMemoryEventRepository(agentEventCodec) }, checks: [
    { id: 'same', requirement: 'required', async run() { return { verdict: 'passed', summary: 'ok' }; } },
    { id: 'same', requirement: 'advisory', async run() { return { verdict: 'passed', summary: 'ok' }; } }
  ] }), /Duplicate check id/);
  assert.equal(provider.calls.length, 0);
  assert.equal(deriveAgentVerificationStatus([{ id: 'missing', requirement: 'required' }], []), 'inconclusive');
});

test('cyclic and oversized check output is bounded without losing the candidate', async () => {
  const cyclic = { huge: 'x'.repeat(100_000), values: Array.from({ length: 500 }, (_, index) => index) };
  cyclic.self = cyclic;
  const { agent } = await harness({ checks: [{ id: 'safe', requirement: 'required', async run() { return { verdict: 'passed', summary: 'ok', output: cyclic }; } }] });
  const result = ended(await agent.run({ task: 'normalize' }).result);  assert.equal(result.candidate.message, 'done');
  assert.equal(result.verificationStatus, 'passed');
  assert.ok(result.checkResults[0].outputNormalization.length > 0);
  assert.ok(JSON.stringify(result.checkResults[0].output).length < 40_000);
});

test('application, run, and steering instructions reach checks with provenance', async () => {
  let received;
  let agent;
  let runControl;
  const noop = { name: 'noop', implementationId: 'tests/noop-instructions@1', description: 'noop', jsonSchema: { type: 'object' }, outputSchema: emptyOutputSchema, effectEnvelope: readEnvelope,
    decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return readEffects; }, async invoke() { return { kind: 'result', ok: true, output: {}, summary: 'ok', scope: completeScope }; } };
  ({ agent } = await harness({
    script: [response('tool_calls', '', { toolCalls: [{ id: '1', type: 'function', name: 'noop', input: { kind: 'json', value: {} } }] }), response()],
    tools: [noop],
    instructions: [{ id: 'standing', content: 'application rule' }],
    checks: [{ id: 'context', requirement: 'required', async run(context) { received = context.instructions; return { verdict: 'passed', summary: 'ok' }; } }],
    onProgress(event) { if (event.type === 'assistant.started') runControl.injectSteering({ instruction: 'steering rule' }); }
  }));
  runControl = agent.run({ task: 'instructions', instructions: ['run rule'] });
  const result = ended(await runControl.result);  assert.equal(result.executionStatus, 'completed');
  assert.deepEqual(received.map((item) => item.provenance), ['application', 'run', 'steering']);
});

test('check artifacts and diagnostics agree across ledger, session projection, and replay state', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const ref = await artifacts.store({ label: 'proof', content: new TextEncoder().encode('proof'), mediaType: 'text/plain' });
  const { agent, events, sessions, session } = await harness({ artifacts, checks: [{ id: 'advice', requirement: 'advisory', async run() { return { verdict: 'unknown', summary: 'unavailable', diagnostic: { kind: 'unavailable', message: 'offline' }, artifacts: [ref] }; } }] });
  const result = ended(await agent.run({ task: 'persist checks' }).result);  const ledgerFinal = (await eventsFor(events, result.runId)).find((event) => event.type === 'run.ended').terminal;
  const replay = await sessions.loadReplayState(session.id);
  const projection = replay.terminalProjections[0].terminal;
  assert.deepEqual(ledgerFinal.checkResults, result.checkResults);
  assert.deepEqual(projection.checkResults, result.checkResults);
  assert.equal(projection.candidate.source, result.candidate.source);
});

test('persisted terminal validation rejects illegal cross-field combinations', () => {
  assert.throws(() => decodeAgentTerminalSnapshot({ ...terminal(), executionStatus: 'completed', verificationStatus: 'not_run' }), /invalid verification/i);
  assert.throws(() => decodeAgentTerminalSnapshot({ ...terminal(), candidate: { status: 'absent' } }), /present candidate/i);
  assert.throws(() => decodeAgentTerminalSnapshot({ ...terminal(), terminationReason: 'model_output_limit', modelTerminationReason: 'output_limit' }), /candidate status partial/i);
  assert.throws(() => decodeAgentTerminalSnapshot({ ...terminal(), terminationReason: 'content_filtered', modelTerminationReason: 'content_filter', candidate: { ...terminal().candidate, status: 'indeterminate' } }), /candidate status partial/i);
  assert.throws(() => decodeAgentTerminalSnapshot({ ...terminal(), terminationReason: 'unknown_model_termination', modelTerminationReason: 'unknown' }), /candidate status indeterminate/i);
  assert.throws(() => decodeAgentTerminalSnapshot({ ...terminal(), candidate: { ...terminal().candidate, status: 'partial' } }), /candidate status complete/i);
  assert.throws(() => decodeAgentEvent({ type: 'obsolete.event', value: true }), /unsupported/i);
  assert.throws(() => decodeAgentEvent({ type: 'assistant.ended', turnIndex: 2, turnId: 'turn-2', requestAttempt: 1, content: 'x', candidate: { status: 'complete', message: 'x', source: 'content', turnIndex: 1 } }), /candidate turnIndex/i);
});

test('agent event persistence rejects hostile caller data before hashing or writing', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  let getterCalls = 0;
  const responseSummary = Object.defineProperty({}, 'getter', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('must not run'); }
  });
  await assert.rejects(
    events.append('hostile-event', {
      type: 'model.responded', turnIndex: 1, turnId: 'turn-1', requestAttempt: 1, response: responseSummary
    }),
    /not safely serializable.*accessor/u
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(await eventsFor(events, 'hostile-event'), []);
});

test('agent event persistence accepts long model answers within the runtime output envelope', () => {
  const message = '🧠'.repeat(100_000);
  const event = decodeAgentEvent({
    type: 'assistant.ended',
    turnIndex: 1,
    turnId: 'turn-1',
    requestAttempt: 1,
    content: message,
    candidate: { status: 'complete', message, source: 'content', turnIndex: 1 }
  });
  assert.equal(event.content, message);
  assert.throws(() => decodeAgentEvent({
    ...event,
    content: 'x'.repeat(1024 * 1024 + 1),
    candidate: { status: 'complete', message: 'x'.repeat(1024 * 1024 + 1), source: 'content', turnIndex: 1 }
  }), /not safely serializable.*text_truncated/u);
});

test('in-memory repositories run, reopen, and replay without filesystem paths', async () => {
  const first = await harness({ script: [response('stop', 'first')] });  const firstResult = ended(await first.agent.run({ task: 'first' }).result);  const started = (await eventsFor(first.events, firstResult.runId)).find((event) => event.type === 'run.started');
  assert.equal(started.runId, firstResult.runId);
  assert.equal(started.finalizationId, firstResult.finalizationId);
  const reopened = await first.sessions.open(first.session.id);
  assert.equal(reopened.id, first.session.id);
  const secondProvider = new ScriptedProvider([request => response('stop', request.messages.some(message => message.content.includes('Prior session context')) ? 'replayed' : 'missing')]);
  const second = new AgentRuntime({ provider: secondProvider, model: 'scripted', toolBoundary, repositories: { events: first.events, session: { repository: first.sessions, sessionId: first.session.id }, artifacts: first.artifacts } });
  const secondResult = ended(await second.run({ task: 'second' }).result);  assert.equal(firstResult.executionStatus, 'completed');
  assert.equal(secondResult.candidate.message, 'replayed');
});

test('session replay preserves an accepted task from an interrupted run', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ provider: 'scripted', model: 'scripted' });
  const artifacts = new InMemoryArtifactRepository();
  const interruptedTask = 'Investigate the unfinished continuity problem.';
  await sessions.appendInput(session.id, { runId: 'interrupted-run', task: interruptedTask });
  await events.append('interrupted-run', {
    type: 'run.started',
    runId: 'interrupted-run',
    finalizationId: 'interrupted-finalization',
    task: interruptedTask,
    model: 'scripted',
    toolPolicy: { allowedRisks: [] }
  });
  const provider = new ScriptedProvider([request => response(
    'stop',
    request.messages.some((message) => message.content.includes(interruptedTask)) ? 'recovered interrupted task' : 'missing interrupted task'
  )]);
  const reopened = new AgentRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: { events, session: { repository: sessions, sessionId: session.id }, artifacts }
  });

  const result = ended(await reopened.run({ task: 'Continue after recovery.' }).result);
  assert.equal(result.candidate.message, 'recovered interrupted task');
});

test('run limits and retry policy terminate deterministically', async () => {
  const call = { id: '1', type: 'function', name: 'noop', input: { kind: 'json', value: {} } };
  const provider = new ScriptedProvider([response('tool_calls', '', { toolCalls: [call] })]);
  const noop = { name: 'noop', implementationId: 'tests/noop-model-change@1', description: 'noop', jsonSchema: { type: 'object' }, outputSchema: emptyOutputSchema, effectEnvelope: readEnvelope, decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return readEffects; }, async invoke() { return { kind: 'result', ok: true, output: {}, summary: 'ok', scope: completeScope }; } };
  const { agent } = await harness({ provider, tools: [noop], limits: { modelTurns: 1 } });
  const exhausted = ended(await agent.run({ task: 'limit' }).result);  assert.equal(exhausted.terminationReason, 'limit_exhausted');
  assert.equal(exhausted.exhaustedLimit, 'model_turns');

  const retrying = new ScriptedProvider([new ModelProviderError({ provider: 'scripted', code: 'provider_unavailable', message: 'retry', retryable: true }), response()]);
  const retryHarness = await harness({ provider: retrying, retryPolicy: { retriesPerRequest: 1, initialDelayMs: 0 } });
  const retried = ended(await retryHarness.agent.run({ task: 'retry' }).result);  assert.equal(retried.executionStatus, 'completed');
  assert.equal(retrying.calls.length, 2);
  assert.equal((await eventsFor(retryHarness.events, retried.runId)).filter((event) => event.type === 'run.retry.scheduled').length, 1);
});

test('provider retries persist distinct attempt identities and honor session retry disposition', async () => {
  for (const [disposition, expectedResets] of [['reusable', 0], ['unknown', 1]]) {
    const provider = new ScriptedProvider([]);
    const script = [new ModelProviderError({ provider: 'scripted', code: 'provider_unavailable', message: 'retry', retryable: true }), response()];
    let resets = 0;
    provider.createSession = () => ({
      async complete(request) {
        provider.calls.push(request);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return { ...next, model: request.model };
      },
      retryDisposition() { return disposition; },
      resetContinuation() { resets += 1; }
    });
    const run = await harness({ provider, retryPolicy: { retriesPerRequest: 1, initialDelayMs: 0 }, withoutSession: true });
    const result = ended(await run.agent.run({ task: `retry ${disposition}` }).result);    const records = await eventsFor(run.events, result.runId);
    const requested = records.filter(event => event.type === 'model.requested');
    assert.deepEqual(requested.map(event => event.requestAttempt), [1, 2]);
    assert.equal(new Set(requested.map(event => event.turnId)).size, 1);
    assert.equal(records.find(event => event.type === 'model.responded').requestAttempt, 2);
    assert.equal(records.find(event => event.type === 'assistant.ended').requestAttempt, 2);
    assert.equal(resets, expectedResets);
  }
});

test('final request snapshot separates every dynamic context provenance and hashes the prompt', async () => {
  const item = (id, content) => ({ id, sourceUri: `memory:${id}`, sourceKind: 'external', representation: 'full', mediaType: 'text/plain', title: id, content, selectionReason: 'test', score: 1 });
  const run = await harness({
    withoutSession: true,
    contextItems: [item('configured', 'configured context')],
    contextProvider: () => [item('provider', 'provider context')]
  });
  const result = ended(await run.agent.run({ task: 'snapshot', contextItems: [item('run', 'run context')] }).result);  const snapshot = (await eventsFor(run.events, result.runId)).find(event => event.type === 'request.snapshot.created').snapshot;
  assert.deepEqual(snapshot.configuredContextIds, ['configured']);
  assert.deepEqual(snapshot.providerContextIds, ['provider']);
  assert.deepEqual(snapshot.runContextIds, ['run']);
  for (const field of ['effectiveInstructionHash', 'selectedEvidenceHash', 'retainedHistoryHash', 'modelToolSchemasHash', 'compiledPromptHash']) assert.match(snapshot[field], /^[a-f0-9]{64}$/);
});

test('durable approval resumes after repository reopen and rejects changed policy fingerprints', async () => {
  let effects = 0;
  const call = { id: 'effect-1', type: 'function', name: 'effect', input: { kind: 'json', value: { path: 'src/../state' } } };
  const tool = adoptToolDefinition({
    name: 'effect', implementationId: 'tests/canonical-effect@1', description: 'write one canonical resource', jsonSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, outputSchema: emptyOutputSchema,
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'workspace' }], lockScopes: ['workspace'] },
    decodeInput(input) { return { ok: true, input: input.value }; },
    canonicalizeInput(input) { return { ...input, path: 'state' }; }, snapshotInput(input) { return input; },
    deriveEffects(input) { return { accesses: [{ mode: 'write', scope: `workspace/${input.path}` }], lockScopes: [`workspace/${input.path}`], recovery: { kind: 'unknown' } }; },
    async invoke() { effects += 1; return { kind: 'result', ok: true, output: {}, summary: 'changed', scope: { resources: ['workspace/state'], coverage: 'complete' } }; }
  });
  const provider = new ScriptedProvider([response('tool_calls', '', { toolCalls: [call] }), response('stop', 'approved')]);
  const repositories = await harness({ provider, tools: [tool], toolPolicy: { allowedRisks: ['read', 'write'] }, toolAuthorizer: request => {
    assert.deepEqual(request.input, { path: 'state' });
    assert.deepEqual(request.effects.accesses, [{ mode: 'write', scope: 'workspace/state' }]);
    return { decision: 'require_approval', reason: 'confirm write' };
  }, checks: [{ id: 'required', requirement: 'required', async run() { return { verdict: 'passed', summary: 'ok' }; } }] });
  const suspended = await repositories.agent.run({ task: 'approval' }).result;
  assert.equal(suspended.state, 'suspended');
  assert.equal(effects, 0);
  const approval = suspended.pendingApprovals[0];

  const changedPolicy = new AgentRuntime({ provider, model: 'scripted', toolBoundary, repositories: { events: repositories.events, session: { repository: repositories.sessions, sessionId: repositories.session.id }, artifacts: repositories.artifacts }, tools: [tool], toolPolicy: { allowedRisks: ['read'] } });
  await assert.rejects(async () => (await changedPolicy.resumeApproval({ runId: suspended.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint, decision: 'allow' })).result, /fingerprint changed/);
  assert.equal((await eventsFor(repositories.events, suspended.runId)).filter(event => event.type === 'approval.resolved').length, 0);

  const changedTarget = new AgentRuntime({ provider, model: 'scripted', toolBoundary: { ...toolBoundary, executionTargetId: 'tests/other-target' }, repositories: { events: repositories.events, session: { repository: repositories.sessions, sessionId: repositories.session.id }, artifacts: repositories.artifacts }, tools: [tool], toolPolicy: { allowedRisks: ['read', 'write'] } });
  await assert.rejects(async () => (await changedTarget.resumeApproval({ runId: suspended.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint, decision: 'allow' })).result, /boundary changed/);

  const replacement = adoptToolDefinition({ ...tool, implementationId: 'tests/canonical-effect@2' });
  const changedImplementation = new AgentRuntime({ provider, model: 'scripted', toolBoundary, repositories: { events: repositories.events, session: { repository: repositories.sessions, sessionId: repositories.session.id }, artifacts: repositories.artifacts }, tools: [replacement], toolPolicy: { allowedRisks: ['read', 'write'] } });
  await assert.rejects(async () => (await changedImplementation.resumeApproval({ runId: suspended.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint, decision: 'allow' })).result, /implementation changed|fingerprint changed/);
  assert.deepEqual(approval.binding, { toolImplementationId: tool.implementationId, ...toolBoundary });

  const reopened = new AgentRuntime({ provider, model: 'scripted', toolBoundary, repositories: { events: repositories.events, session: { repository: repositories.sessions, sessionId: repositories.session.id }, artifacts: repositories.artifacts }, tools: [tool], toolPolicy: { allowedRisks: ['read', 'write'] }, checks: [{ id: 'required', requirement: 'required', async run() { return { verdict: 'passed', summary: 'ok' }; } }] });
  const result = ended(await (await reopened.resumeApproval({ runId: suspended.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint, decision: 'allow' })).result);  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.verificationStatus, 'passed');
  assert.equal(effects, 1);
  const records = await eventsFor(repositories.events, result.runId);
  assert.equal(records.filter(event => event.type === 'approval.requested').length, 1);
  assert.equal(records.filter(event => event.type === 'approval.resolved').length, 1);
  assert.equal(records.filter(event => event.type === 'run.ended').length, 1);
  assert.equal((await repositories.sessions.open(repositories.session.id)).id, repositories.session.id);
});

test('current authorization is re-evaluated and may veto a stored approval', async () => {
  let effects = 0;
  const tool = adoptToolDefinition({
    name: 'effect', implementationId: 'tests/current-veto-effect@1', description: 'effect', jsonSchema: { type: 'object' }, outputSchema: emptyOutputSchema,
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'state' }], lockScopes: ['state'] },
    decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return { accesses: [{ mode: 'write', scope: 'state' }], lockScopes: ['state'], recovery: { kind: 'unknown' } }; },
    async invoke() { effects += 1; return { kind: 'result', ok: true, output: {}, summary: 'changed', scope: { resources: ['state'], coverage: 'complete' } }; }
  });
  const provider = new ScriptedProvider([
    response('tool_calls', '', { toolCalls: [{ id: 'effect', type: 'function', name: 'effect', input: { kind: 'json', value: {} } }] }),
    response('stop', 'continued safely')
  ]);
  const first = await harness({ provider, tools: [tool], toolPolicy: { allowedRisks: ['read', 'write'] }, toolAuthorizer: () => ({ decision: 'require_approval', reason: 'confirm' }) });  const suspended = await first.agent.run({ task: 'current veto' }).result;
  const approval = suspended.pendingApprovals[0];
  let currentChecks = 0;
  const reopened = new AgentRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: { events: first.events, session: { repository: first.sessions, sessionId: first.session.id }, artifacts: first.artifacts },
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolAuthorizer() { currentChecks += 1; return { decision: 'deny', reason: 'policy changed' }; }
  });
  const result = ended(await (await reopened.resumeApproval({ runId: suspended.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint, decision: 'allow' })).result);  assert.equal(result.executionStatus, 'completed');
  assert.equal(effects, 0);
  assert.equal(currentChecks, 1);
  const toolEnded = (await eventsFor(first.events, result.runId)).find((event) => event.type === 'tool.ended');
  assert.equal(toolEnded.observation.ok, false);
  assert.match(toolEnded.observation.summary, /authorization denied/i);
});

test('process death after an approved effect without recovery proof remains uncertain without replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-approved-crash-'));
  const fixture = path.resolve('tests/fixtures/approval-crash.mjs');
  const initial = spawnSync(process.execPath, [fixture, 'suspend', root], { encoding: 'utf8' });
  assert.equal(initial.status, 0, initial.stderr);
  const approval = JSON.parse(initial.stdout);
  const crash = spawnSync(process.execPath, [fixture, 'crash', root, approval.runId, approval.approvalId, approval.fingerprint], { encoding: 'utf8' });
  assert.equal(crash.status, 42, crash.stderr);
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');

  const recovered = spawnSync(process.execPath, [fixture, 'recover', root, approval.runId, approval.approvalId, approval.fingerprint], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.executionStatus, 'failed');
  assert.equal(result.terminationReason, 'uncertain_tool_effect');
  assert.equal(result.verificationStatus, 'not_run');
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');

  const eventRepository = new (await import('@agent-core/evidence/node')).JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
  const records = await eventsFor(eventRepository, approval.runId);
  assert.equal(records.filter((event) => event.type === 'tool.started').length, 1);
  assert.equal(records.filter((event) => event.type === 'tool.ended').length, 0);
  assert.equal(records.filter((event) => event.type === 'run.ended').length, 1);
});

test('crashes while waiting for a lease or after acquisition but before tool.started remain safe to replay', async () => {
  const fixture = path.resolve('tests/fixtures/approval-crash.mjs');
  for (const [mode, exitStatus] of [['crash_waiting_for_lease', 44], ['crash_before_started', 45]]) {
    const root = await mkdtemp(path.join(tmpdir(), `agent-${mode}-`));
    const initial = spawnSync(process.execPath, [fixture, 'suspend', root], { encoding: 'utf8' });
    assert.equal(initial.status, 0, initial.stderr);
    const approval = JSON.parse(initial.stdout);

    const crash = spawnSync(process.execPath, [fixture, mode, root, approval.runId, approval.approvalId, approval.fingerprint], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(crash.status, exitStatus, crash.stderr);
    await assert.rejects(() => readFile(path.join(root, 'effect.txt'), 'utf8'), /ENOENT/u);

    const eventRepository = new (await import('@agent-core/evidence/node')).JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
    let records = await eventsFor(eventRepository, approval.runId);
    assert.equal(records.filter((event) => event.type === 'tool.started').length, 0, mode);
    assert.equal(records.filter((event) => event.type === 'tool.ended').length, 0, mode);

    const recovered = spawnSync(process.execPath, [fixture, 'recover', root, approval.runId, approval.approvalId, approval.fingerprint], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).executionStatus, 'completed');
    assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');
    records = await eventsFor(eventRepository, approval.runId);
    assert.equal(records.filter((event) => event.type === 'tool.started').length, 1, mode);
    assert.equal(records.filter((event) => event.type === 'tool.ended').length, 1, mode);
  }
});

test('process death after tool completion projects the durable observation without replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-completed-crash-'));
  const fixture = path.resolve('tests/fixtures/approval-crash.mjs');
  const initial = spawnSync(process.execPath, [fixture, 'suspend', root], { encoding: 'utf8' });
  assert.equal(initial.status, 0, initial.stderr);
  const approval = JSON.parse(initial.stdout);
  const crash = spawnSync(process.execPath, [fixture, 'crash_after_ended', root, approval.runId, approval.approvalId, approval.fingerprint], { encoding: 'utf8' });
  assert.equal(crash.status, 43, crash.stderr);
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');

  const recovered = spawnSync(process.execPath, [fixture, 'recover', root, approval.runId, approval.approvalId, approval.fingerprint], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.executionStatus, 'completed');
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');
  const eventRepository = new (await import('@agent-core/evidence/node')).JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
  const records = await eventsFor(eventRepository, approval.runId);
  assert.equal(records.filter((event) => event.type === 'tool.ended').length, 1);
  assert.equal(records.filter((event) => event.type === 'observation.record.created').length, 1);
  const sessionRepository = new (await import('@agent-core/runtime/node')).JsonlSessionRepository({ rootDir: path.join(root, 'sessions') });
  const replay = await sessionRepository.loadReplayState('crash-recovery');
  assert.equal(replay.branch.filter((entry) => entry.type === 'observation' && entry.toolName === 'effect').length, 1);
});

test('per-call recovery refuses incomplete effects without proof and only projects completed observations', async () => {
  const call = { id: 'effect-1', type: 'function', name: 'effect', input: { kind: 'json', value: {} } };
  const persistedCall = { id: call.id, name: call.name, input: call.input };
  const effects = { accesses: [{ mode: 'write', scope: 'state/effect' }], lockScopes: ['state/effect'], recovery: { kind: 'unknown' } };
  let invocations = 0;
  const tool = {
    name: 'effect', implementationId: 'tests/unknown-recovery@1', description: 'unknown recovery fixture', jsonSchema: { type: 'object' }, outputSchema: z.unknown(), effectEnvelope: { accesses: effects.accesses, lockScopes: effects.lockScopes },
    decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return effects; },
    async invoke(_input, context) {
      invocations += 1;
      assert.equal(context.invocation.toolAttempt, 2);
      return { kind: 'result', ok: true, output: { retried: true }, summary: 'must not retry', scope: { resources: ['state/effect'], coverage: 'complete' } };
    }
  };
  const provider = new ScriptedProvider([response('tool_calls', '', { toolCalls: [call] }), response('stop', 'after retry')]);
  const run = await harness({ provider, tools: [tool], toolPolicy: { allowedRisks: ['read', 'write'] }, toolAuthorizer: () => ({ decision: 'require_approval', reason: 'confirm' }) });
  const suspended = await run.agent.run({ task: 'unknown recovery' }).result;
  const approval = suspended.pendingApprovals[0];
  const identity = { turnIndex: approval.turnIndex, turnId: approval.turnId, requestAttempt: approval.requestAttempt, toolBatchId: approval.toolBatchId, callIndex: approval.callIndex, callId: approval.callId, toolAttempt: 1 };
  await run.events.append(suspended.runId, { type: 'tool.started', ...identity, toolName: tool.name, input: persistedCall, fingerprint: approval.fingerprint, effects }, { idempotencyKey: toolStageKey(suspended.runId, identity, 'started') });
  const result = ended(await (await run.agent.resumeApproval({ runId: suspended.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint, decision: 'allow' })).result);  assert.equal(result.executionStatus, 'failed');
  assert.equal(result.terminationReason, 'uncertain_tool_effect');
  assert.equal(invocations, 0);
  let records = await eventsFor(run.events, result.runId);
  assert.deepEqual(records.filter((event) => event.type === 'tool.started').map((event) => event.toolAttempt), [1]);
  assert.deepEqual(records.filter((event) => event.type === 'tool.ended').map((event) => event.toolAttempt), []);

  let projectedInvocations = 0;
  const completedTool = { ...tool, implementationId: 'tests/completed-recovery@1', async invoke() { projectedInvocations += 1; return { kind: 'result', ok: true, output: {}, summary: 'must not run', scope: { resources: ['state/effect'], coverage: 'complete' } }; } };
  const completedProvider = new ScriptedProvider([response('tool_calls', '', { toolCalls: [call] }), response('stop', 'after projection')]);
  const completedRun = await harness({ provider: completedProvider, tools: [completedTool], toolPolicy: { allowedRisks: ['read', 'write'] }, toolAuthorizer: () => ({ decision: 'require_approval', reason: 'confirm' }) });
  const completedSuspension = await completedRun.agent.run({ task: 'completed recovery' }).result;
  const completedApproval = completedSuspension.pendingApprovals[0];
  const completedIdentity = { turnIndex: completedApproval.turnIndex, turnId: completedApproval.turnId, requestAttempt: completedApproval.requestAttempt, toolBatchId: completedApproval.toolBatchId, callIndex: completedApproval.callIndex, callId: completedApproval.callId, toolAttempt: 1 };
  const completedObservation = parseToolObservation(completedTool, { kind: 'result', ok: true, output: { already: true }, summary: 'already completed', scope: { resources: ['state/effect'], coverage: 'complete' } });
  await completedRun.events.append(completedSuspension.runId, { type: 'tool.started', ...completedIdentity, toolName: completedTool.name, input: persistedCall, fingerprint: completedApproval.fingerprint, effects }, { idempotencyKey: toolStageKey(completedSuspension.runId, completedIdentity, 'started') });
  await completedRun.events.append(completedSuspension.runId, { type: 'tool.ended', ...completedIdentity, toolName: completedTool.name, observation: completedObservation }, { idempotencyKey: toolStageKey(completedSuspension.runId, completedIdentity, 'ended') });
  const completedResult = ended(await (await completedRun.agent.resumeApproval({ runId: completedSuspension.runId, approvalId: completedApproval.approvalId, fingerprint: completedApproval.fingerprint, decision: 'allow' })).result);  assert.equal(completedResult.executionStatus, 'completed');
  assert.equal(projectedInvocations, 0);
  records = await eventsFor(completedRun.events, completedResult.runId);
  assert.equal(records.filter((event) => event.type === 'tool.ended').length, 1);
  assert.equal(records.filter((event) => event.type === 'observation.record.created').length, 1);
  const replay = await completedRun.sessions.loadReplayState(completedRun.session.id);
  assert.equal(replay.branch.filter((entry) => entry.type === 'observation' && entry.toolName === completedTool.name).length, 1);
});

test('consumed provider usage remains in the terminal snapshot when it crosses a limit', async () => {
  const run = await harness({ script: [response('stop', 'over', { usage: { promptTokens: 4, completionTokens: 11, totalTokens: 15 } })], limits: { completionTokens: 10 }, withoutSession: true });
  const result = ended(await run.agent.run({ task: 'usage limit' }).result);  assert.equal(result.terminationReason, 'limit_exhausted');
  assert.equal(result.exhaustedLimit, 'completion_tokens');
  assert.equal(result.budget.completionTokens, 11);
  const usage = (await eventsFor(run.events, result.runId)).find(event => event.type === 'budget.provider_usage.recorded');
  assert.equal(usage.snapshot.completionTokens, 11);
});

test('elapsed limits use the injected monotonic clock', async () => {
  let now = 0;
  const call = { id: '1', type: 'function', name: 'noop', input: { kind: 'json', value: {} } };
  const provider = new ScriptedProvider([() => { now = 10; return response('tool_calls', '', { toolCalls: [call] }); }]);
  const noop = { name: 'noop', implementationId: 'tests/noop-elapsed@1', description: 'noop', jsonSchema: { type: 'object' }, outputSchema: emptyOutputSchema, effectEnvelope: readEnvelope, decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return readEffects; }, async invoke() { return { kind: 'result', ok: true, output: {}, summary: 'ok', scope: completeScope }; } };
  const run = await harness({ provider, tools: [noop], limits: { elapsedMs: 5 }, clock: { now: () => now }, withoutSession: true });
  const result = ended(await run.agent.run({ task: 'elapsed' }).result);  assert.equal(result.terminationReason, 'limit_exhausted');
  assert.equal(result.exhaustedLimit, 'elapsed_time');
  assert.equal(result.budget.elapsedMs, 10);
});

test('elapsed limits actively abort a provider request that never settles', async () => {
  const provider = new ScriptedProvider([
    request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
  ]);
  const run = await harness({ provider, limits: { elapsedMs: 20 }, retryPolicy: { retriesPerRequest: 0 }, withoutSession: true });
  const result = ended(await run.agent.run({ task: 'stalled provider' }).result);  assert.equal(result.terminationReason, 'limit_exhausted');
  assert.equal(result.exhaustedLimit, 'elapsed_time');
  assert.equal(result.executionStatus, 'failed');
});

test('tool preparation and authorization are abortable and elapsed-deadline bounded', async () => {
  const callResponse = () => response('tool_calls', '', { toolCalls: [{ id: 'stall', type: 'function', name: 'stall', input: { kind: 'json', value: {} } }] });
  const baseTool = {
    name: 'stall', implementationId: 'tests/stalled-boundary@1', description: 'stalled boundary', jsonSchema: { type: 'object' }, outputSchema: emptyOutputSchema, effectEnvelope: readEnvelope,
    decodeInput() { return { ok: true, input: {} }; },
    canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; },
    deriveEffects() { return readEffects; },
    async invoke() { return { kind: 'result', ok: true, output: {}, summary: 'unexpected', scope: completeScope }; }
  };
  const cases = [
    { name: 'canonicalizer', tool: { ...baseTool, canonicalizeInput() { return new Promise(() => {}); } } },
    { name: 'effect derivation', tool: { ...baseTool, deriveEffects() { return new Promise(() => {}); } } },
    { name: 'authorizer', tool: baseTool, toolAuthorizer: () => new Promise(() => {}) }
  ];
  for (const item of cases) {
    const controller = new AbortController();
    const run = await harness({ script: [callResponse()], tools: [item.tool], withoutSession: true, ...(item.toolAuthorizer ? { toolAuthorizer: item.toolAuthorizer } : {}) });
    setTimeout(() => controller.abort(`abort ${item.name}`), 10);
    const result = ended(await Promise.race([
      run.agent.run({ task: item.name, signal: controller.signal }).result,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${item.name} ignored abort`)), 1_000))
    ]));
    assert.equal(result.executionStatus, 'aborted', item.name);
    assert.equal(result.verificationStatus, 'not_run', item.name);
  }

  const deadlineRun = await harness({ script: [callResponse()], tools: [baseTool], toolAuthorizer: () => new Promise(() => {}), limits: { elapsedMs: 20 }, withoutSession: true });
  const deadlineResult = ended(await Promise.race([
    deadlineRun.agent.run({ task: 'authorization deadline' }).result,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('authorizer ignored elapsed deadline')), 1_000))
  ]));
  assert.equal(deadlineResult.executionStatus, 'failed');
  assert.equal(deadlineResult.terminationReason, 'limit_exhausted');
  assert.equal(deadlineResult.exhaustedLimit, 'elapsed_time');
});

test('completed tool failures with unknown recovery are not replayed automatically', async () => {
  const call = { id: '1', type: 'function', name: 'effect', input: { kind: 'json', value: {} } };
  const provider = new ScriptedProvider([response('tool_calls', '', { toolCalls: [call] }), response('stop', 'handled')]);
  let invocations = 0;
  const effect = { name: 'effect', implementationId: 'tests/unknown-recovery-effect@1', description: 'effect', jsonSchema: { type: 'object' }, outputSchema: emptyOutputSchema, effectEnvelope: { accesses: [{ mode: 'write', scope: 'state' }], lockScopes: ['state'] }, decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return { accesses: [{ mode: 'write', scope: 'state' }], lockScopes: ['state'], recovery: { kind: 'unknown' } }; }, async invoke() { invocations += 1; return { kind: 'failure', ok: false, output: { blocked: true, reason: 'runtime_error', error: 'failed', recovery: 'stop' }, summary: 'failed', scope: { resources: ['state'], coverage: 'partial', cause: 'failed' } }; } };
  const { agent } = await harness({ provider, tools: [effect], toolPolicy: { allowedRisks: ['read', 'write'] } });
  const result = ended(await agent.run({ task: 'effect' }).result);
  assert.equal(result.executionStatus, 'completed');
  assert.equal(invocations, 1);
});

test('throwing terminal observer leaves one commit and records one delivery diagnostic', async () => {
  const { agent, events } = await harness({ withoutSession: true, onProgress(event) { if (event.type === 'run.ended') throw new Error('renderer broke'); } });
  const result = ended(await agent.run({ task: 'observer' }).result);  const records = await eventsFor(events, result.runId);
  assert.equal(records.filter((event) => event.type === 'run.ended').length, 1);
  assert.equal(records.filter((event) => event.type === 'delivery.failed').length, 1);
  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.deliveryDiagnostics.length, 1);
});

test('finalization is idempotent, rejects conflicts, and recovers faults after every write', async () => {
  const base = terminal();
  const events = new InMemoryEventRepository(agentEventCodec);
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({});
  await sessions.appendInput(session.id, { runId: base.runId, task: 'finalize' });
  const finalizer = new AgentRunFinalizer({ runId: base.runId, finalizationId: base.finalizationId, events, session: { repository: sessions, sessionId: session.id } });
  const first = finalizer.finalize(base);
  assert.equal(first, finalizer.finalize(base));
  const result = ended(await first);  assert.equal(result.executionStatus, 'completed');
  assert.throws(() => finalizer.finalize({ ...base, candidate: { ...base.candidate, message: 'conflict' } }), /Conflicting terminal decision/);
  assert.equal((await eventsFor(events, base.runId)).filter(event => event.type === 'run.ended').length, 1);

  for (const point of ['prepared', 'session', 'committed']) {
    const durableEvents = new InMemoryEventRepository(agentEventCodec);
    const durableSessions = new InMemorySessionRepository();
    const durableSession = await durableSessions.create({});
    await durableSessions.appendInput(durableSession.id, { runId: base.runId, task: 'recover' });
    let thrown = false;
    const faultEvents = {
      ...durableEvents,
      append: async (runId, event, options) => {
        const record = await durableEvents.append(runId, event, options);
        if (!thrown && ((point === 'prepared' && event.type === 'finalization.prepared') || (point === 'committed' && event.type === 'run.ended'))) { thrown = true; throw new Error(`fault ${point}`); }
        return record;
      },
      read: runId => durableEvents.read(runId), listRunIds: () => durableEvents.listRunIds(), verifyIntegrity: runId => durableEvents.verifyIntegrity(runId)
    };
    const faultSessions = point === 'session' ? {
      ...durableSessions,
      projectFinal: async (sessionId, value) => { const projection = await durableSessions.projectFinal(sessionId, value); if (!thrown) { thrown = true; throw new Error('fault session'); } return projection; },
      loadReplayState: (sessionId, leafId) => durableSessions.loadReplayState(sessionId, leafId)
    } : durableSessions;
    const broken = new AgentRunFinalizer({ runId: base.runId, finalizationId: base.finalizationId, events: faultEvents, session: { repository: faultSessions, sessionId: durableSession.id } });
    await assert.rejects(broken.finalize(base), error => {
      assert.equal(error instanceof AgentFinalizationError, true);
      assert.equal(error.progress.reconciliation, 'verified');
      assert.equal(error.progress.prepared, true);
      assert.equal(error.progress.sessionProjected, point !== 'prepared');
      assert.equal(error.progress.committed, point === 'committed');
      return true;
    });
    const recovered = new AgentRunFinalizer({ runId: base.runId, finalizationId: base.finalizationId, events: durableEvents, session: { repository: durableSessions, sessionId: durableSession.id } });
    await recovered.finalize(base);
    assert.deepEqual(await readCommittedTerminal(durableEvents, base.runId), base);
    assert.equal((await eventsFor(durableEvents, base.runId)).filter(event => event.type === 'run.ended').length, 1);
    assert.equal((await durableSessions.loadReplayState(durableSession.id)).terminalProjections.length, 1);
  }
});

function terminal() {
  return decodeAgentTerminalSnapshot({
    runId: 'run-final', finalizationId: 'final-1', phase: 'ended', executionStatus: 'completed', verificationStatus: 'not_required', terminationReason: 'model_completed',
    modelTerminationReason: 'stop', candidate: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }, turnCount: 1, checkResults: [],
    budget: { modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0, providerRetries: 0 }
  });
}
