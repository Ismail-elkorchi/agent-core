import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { ModelProviderError, requestAccountingInputTokens, conservativeProtocolCapabilities } from '@agent-core/model';
import { defineTool } from '@agent-core/tools';
import { hashJson, InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime, ContextService, HistoryReader, InMemorySessionRepository,
  InMemoryInferenceRepository, InferenceService, agentEventCodec, createHistoryTools
} from '@agent-core/runtime';

const marker = 'Prepare a fresh context for the same ongoing work';
const applicationTask = 'ACTUAL TASK: preserve this exact application request.';
const applicationInstruction = 'APPLICATION AUTHORITY: preserve the original requirements.';
const seedTask = 'Old optional evidence: ' + 'x'.repeat(24000);
const response = (content = 'Done.') => ({
  provider: 'recovery-accounting-fixture', model: 'fixture', content, terminationReason: 'stop'
});
const call = (name, value = {}) => ({
  ...response(''), terminationReason: 'tool_calls',
  toolCalls: [{ id: `call-${crypto.randomUUID()}`, type: 'function', name, input: { kind: 'json', value } }]
});
const select = () => call('context_transition', { reason: 'Release complete optional sources.', retain: [] });
const isRecovery = request => request.messages.some(item => item.role === 'user' && item.content.includes(marker));
const controlTask = request => JSON.parse(request.messages.findLast(item => item.role === 'user').content);
const withoutSignal = ({ signal: _signal, ...request }) => request;

// Kept independent of other test modules so this file can run alone, using public contracts only.
async function fixture({ budget, sourceBound = 100000, targetCapacity = 25000,
  events = new InMemoryEventRepository(agentEventCodec) } = {}) {
  const sessions = new InMemorySessionRepository();
  const descriptor = await sessions.create({ binding: { schemaId: 'recovery-accounting-tests', schemaVersion: 1, subject: {} } });
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session: descriptor, events, artifacts });
  const inferenceRepository = new InMemoryInferenceRepository();
  const requests = [];
  const logicalRequests = [];
  const contextCollections = [];
  const admissions = [];
  let recovery = select;
  let application = () => response();
  const capacity = targetCapacity;
  let reads = 0;
  const provider = {
    id: 'recovery-accounting-fixture', implementationId: 'recovery-accounting-fixture@1',
    describe: () => ({ id: 'recovery-accounting-fixture', displayName: 'Recovery accounting fixture', defaultModel: 'fixture' }),
    describeModel: async () => ({
      id: 'fixture', provider: 'recovery-accounting-fixture',
      capabilities: { protocol: { ...conservativeProtocolCapabilities('recovery-accounting-fixture'), contextReset: 'fresh_request' }, streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false,
        jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: capacity, outputTokens: 4096 },
      supportedParameters: ['tools', 'maxOutputTokens']
    }),
    complete: async request => {
      requests.push(withoutSignal(request));
      return isRecovery(request) ? recovery(request) : application(request);
    }
  };
  const domain = defineTool({
    name: 'domain_read', implementationId: 'fixture.domain-read@1', description: 'Read the next complete original source.',
    schema: z.strictObject({}), outputSchema: z.string(), canonicalizeInput: input => input,
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'domain' }], lockScopes: [] },
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'domain' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async () => {
      reads++;
      return { kind: 'result', output: `Original source ${reads}: ${'x'.repeat(24000)}`,
        summary: `Read source ${reads}`, scope: { resources: ['domain'], coverage: 'complete' } };
    }
  });
  const options = maxSourceBytes => {
    const context = new ContextService({ repository: sessions, session: descriptor, history, artifacts,
      policy: { maxSourceBytes, historyRead: { history, isAvailable: () => true } } });
    return {
      provider, model: 'fixture', context, contextRenewal: { automatic: true },
      instructions: [{ id: 'application-authority', role: 'system', content: applicationInstruction }],
      contextProvider: request => { contextCollections.push(request); return []; },
      recordLogicalRequest: request => { logicalRequests.push(request); },
      repositories: { events, artifacts, session: { repository: sessions, descriptor } },
      tools: [domain, ...context.toolDefinitions(), ...createHistoryTools({ history })],
      toolPolicy: { allowedRisks: ['read', 'write'] },
      toolBoundary: { authorizationPolicyId: 'recovery-accounting-test', executionTargetId: 'recovery-accounting-test' },
      maxOutputTokens: 4096,
      inferenceService: new InferenceService({ provider, artifacts, repository: inferenceRepository,
        admitRequest: compiled => { admissions.push(compiled); }, ...(budget ? { budget } : {}) })
    };
  };
  // The same provider capacity applies throughout. Seed a fitting ordinary request;
  // subsequent accepted input grows the conversation into the early-renewal band.
  const seed = await new AgentRuntime({ ...options(100000), contextRenewal: { automatic: false } }).run({ runId: 'seed', task: seedTask }).result;
  assert.equal(seed.terminal?.executionStatus, 'completed', JSON.stringify(seed));
  requests.length = logicalRequests.length = contextCollections.length = admissions.length = 0;
  return {
    options: () => options(sourceBound), requests, logicalRequests, contextCollections, admissions,
    events, artifacts, inferenceRepository, sessions, descriptor,
    reads: () => reads, recover: value => { recovery = value; }, application: value => { application = value; },
    recoveryRequests: () => requests.filter(isRecovery)
  };
}

async function records(f, runId) {
  const result = [];
  for await (const { event } of f.events.read(runId)) result.push(event);
  return result;
}

test('a retryable recovery failure preserves the exact bounded candidate and its owner accounting', async () => {
  const f = await fixture({ budget: { maxInvocations: 3 } });
  let attempts = 0;
  let collectionsAtFailure;
  let collectionsAtRetry;
  f.recover(() => {
    if (++attempts === 1) {
      collectionsAtFailure = f.contextCollections.length;
      throw new ModelProviderError({ provider: 'recovery-accounting-fixture', code: 'provider_unavailable',
        message: 'Retry the same control request.', retryable: true });
    }
    collectionsAtRetry = f.contextCollections.length;
    return select();
  });
  const options = f.options();
  const result = await new AgentRuntime(options).run({ runId: 'retry-control', task: applicationTask }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(collectionsAtRetry, collectionsAtFailure, 'Recovery retries cannot re-enter application context collection.');
  const control = f.recoveryRequests();
  assert.equal(control.length, 2);
  assert.deepEqual(control[1], control[0]);
  assert.deepEqual(controlTask(control[1]), controlTask(control[0]));
  assert.ok(Buffer.byteLength(control[0].messages.findLast(item => item.role === 'user').content) <= 32768);
  assert.ok(controlTask(control[0]).inventory.items.length > 0);
  assert.ok(JSON.stringify(control[0]).includes(applicationInstruction));
  assert.ok(control[0].messages.some(item => item.role === 'user' && item.content === seedTask),
    'The checkpoint retains the complete original conversation rather than a metadata-only substitute.');
  assert.ok(control[0].messages.some(item => item.role === 'user' && item.content === applicationTask));
  assert.ok(control[0].tools.some(tool => tool.function?.name === 'domain_read'), 'Catalog remains stable; execution gate rejects domain work during checkpoint.');

  const log = await records(f, 'retry-control');
  const snapshots = log.filter(event => event.type === 'turn.snapshot.created' && event.snapshot.contextRecovery).map(event => event.snapshot);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].turnId, snapshots[0].turnId);
  assert.equal(snapshots[1].requestAttempt, snapshots[0].requestAttempt + 1);
  assert.deepEqual(snapshots[1].contextRecovery, snapshots[0].contextRecovery);
  const fingerprints = log.filter(event => event.type === 'inference.request.fingerprinted').map(event => event.fingerprint);
  const [first, retried] = fingerprints;
  assert.notEqual(retried.requestId, first.requestId);
  assert.equal(retried.requestAttempt, first.requestAttempt + 1);
  for (const field of ['compiledInputIdentity', 'capabilityRevision', 'effectiveInstructionHash',
    'modelWindowHistoryHash', 'modelToolSchemasHash', 'modelWindowHash']) assert.equal(retried[field], first[field], field);
  assert.equal(first.modelWindowHash, hashJson(control[0].messages));
  assert.equal(first.modelToolSchemasHash, hashJson(control[0].tools));
  for (const field of ['configuredContextIds', 'providerContextIds', 'runContextIds']) assert.deepEqual(first[field], []);
  const admitted = f.admissions.filter(item => item.inputIdentity === first.compiledInputIdentity);
  assert.ok(admitted.length >= 2, 'Every provider attempt must receive admission.');
  const compiled = admitted[0];
  for (const candidate of admitted) {
    assert.deepEqual(candidate.accounting, compiled.accounting);
    assert.deepEqual(withoutSignal(candidate.logicalRequest), control[0]);
  }
  const one = (await f.inferenceRepository.load('retry-control', { invocationId: first.requestId })).invocation;
  const two = (await f.inferenceRepository.load('retry-control', { invocationId: retried.requestId })).invocation;
  assert.equal(one.start.purpose, 'context_recovery');
  assert.equal(two.start.purpose, 'context_recovery');
  assert.ok(one.uncertain);
  assert.equal(one.settlement, undefined);
  assert.ok(two.settlement);
  assert.deepEqual(two.start.reservation, one.start.reservation);
  assert.equal(one.start.reservation.promptTokens, requestAccountingInputTokens(compiled.accounting));
  assert.equal(one.start.reservation.completionTokens, compiled.accounting.outputReservation);
  const owner = await f.inferenceRepository.load('retry-control');
  assert.equal(owner.committed.invocations, 3);
  assert.equal(owner.settledUsage.invocations, 2);
  assert.ok(owner.committed.usage.promptTokens > owner.settledUsage.usage.promptTokens);
  assert.equal(f.logicalRequests[0].requestId, first.requestId);
  assert.equal(f.logicalRequests[1].requestId, retried.requestId);
  assert.deepEqual(f.logicalRequests[1].request, f.logicalRequests[0].request);
  const originalInput = await options.inferenceService.admittedInput('retry-control', first.requestId);
  const retryInput = await options.inferenceService.admittedInput('retry-control', retried.requestId);
  assert.deepEqual(originalInput.request, control[0]);
  assert.deepEqual(retryInput, originalInput);

  const ordinary = f.requests.at(-1);
  assert.equal(f.requests.length, 3);
  assert.ok(!isRecovery(ordinary));
  assert.ok(ordinary.messages.some(item => item.role === 'user' && item.content === applicationTask));
  assert.ok(ordinary.messages.some(item => item.content.includes(applicationInstruction)));
  assert.ok(ordinary.tools.some(tool => tool.function?.name === 'domain_read'));
  assert.ok(!JSON.stringify(ordinary.messages).includes('recentRecoveryResults'));
  assert.equal(f.reads(), 0);
});

test('a provider capacity rejection of recovery preserves the application conflict without ordinary reassembly', async () => {
  const f = await fixture();
  let collectionsAtFailure;
  f.recover(() => {
    collectionsAtFailure = f.contextCollections.length;
    throw new ModelProviderError({ provider: 'recovery-accounting-fixture', code: 'context_overflow',
      message: 'Even the bounded recovery candidate does not fit.' });
  });
  const result = await new AgentRuntime(f.options()).run({ runId: 'rejected-control', task: applicationTask }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.reason, 'context_admission');
  assert.equal(f.requests.length, 1);
  assert.equal(f.recoveryRequests().length, 1);
  assert.equal(f.contextCollections.length, collectionsAtFailure);
  const original = controlTask(f.requests[0]).conflict;
  assert.equal(result.contextAdmission.kind, original.kind);
  assert.equal(result.contextAdmission.recoveryBoundary, original.recoveryBoundary);
  assert.deepEqual(result.contextAdmission.bound, original.bound);
  assert.deepEqual(result.contextAdmission.source, original.source);
  assert.deepEqual(result.contextAdmission.cut, original.cut);
  assert.equal(result.contextAdmission.recovery, 'request_unavailable');
  const log = await records(f, 'rejected-control');
  assert.ok(!log.some(event => event.type === 'tool.started'));
  const fingerprint = log.find(event => event.type === 'inference.request.fingerprinted').fingerprint;
  const owner = await f.inferenceRepository.load('rejected-control', { invocationId: fingerprint.requestId });
  assert.equal(owner.committed.invocations, 1);
  assert.equal(owner.settledUsage.invocations, 0);
  assert.equal(owner.invocation.start.purpose, 'context_recovery');
  assert.equal(owner.invocation.rejected.code, 'context_overflow');
  assert.equal(owner.invocation.rejected.inputIdentity, fingerprint.compiledInputIdentity);
});

test('successful distinct recovery boundaries exceed four requests while retaining the inference owner budget', async t => {
  const baseline = await fixture();
  baseline.application(() => baseline.reads() < 15 ? call('domain_read') : response('All fifteen sources processed.'));
  const completed = await new AgentRuntime(baseline.options()).run({ runId: 'boundary-baseline', task: applicationTask }).result;
  assert.equal(completed.terminal?.executionStatus, 'completed', JSON.stringify(completed));
  const requiredInvocations = baseline.requests.length;
  const requiredRecoveries = baseline.recoveryRequests().length;
  assert.ok(requiredRecoveries > 4, 'This fixture must exercise more than one unchanged-boundary allowance.');
  assert.equal(requiredInvocations, 16 + requiredRecoveries);
  for (const maxInvocations of [requiredInvocations, requiredInvocations - 1]) await t.test(`owner allowance ${maxInvocations}`, async () => {
    const f = await fixture({ budget: { maxInvocations } });
    const boundaryReads = [];
    const readMetadata = f.events.readMetadataRange.bind(f.events);
    f.events.readMetadataRange = async (runId, query) => {
      const page = await readMetadata(runId, query);
      if (query?.types?.includes('turn.snapshot.created')) boundaryReads.push({ query, scanned: page.scanned });
      return page;
    };
    // Derive the allowance from the same completed work, rather than assuming a
    // tokenizer-specific renewal cadence. Every recovery still consumes its owner budget.
    f.application(() => f.reads() < 15 ? call('domain_read') : response('All fifteen sources processed.'));
    const runId = `many-boundaries-${maxInvocations}`;
    const result = await new AgentRuntime(f.options()).run({ runId, task: applicationTask }).result;
    const control = f.recoveryRequests();
    assert.equal(control.length, requiredRecoveries, JSON.stringify(result));
    assert.equal(new Set(control.map(request => controlTask(request).conflict.recoveryBoundary)).size, requiredRecoveries);
    assert.ok(control.every(request => controlTask(request).attempt === 1));
    assert.equal(boundaryReads.length, requiredRecoveries);
    assert.ok(boundaryReads.every(read => typeof read.query.metadata.recoveryBoundary === 'string' && read.scanned === 0),
      'The indexed boundary allowance never scans prior successful recoveries.');
    assert.equal(f.reads(), 15);
    assert.equal(f.requests.length, maxInvocations);
    const owner = await f.inferenceRepository.load(runId);
    assert.equal(owner.committed.invocations, maxInvocations);
    assert.equal(owner.settledUsage.invocations, maxInvocations);
    const log = await records(f, runId);
    assert.equal(log.filter(event => event.type === 'tool.started' && event.toolName === 'context_transition').length, requiredRecoveries);
    if (maxInvocations === requiredInvocations) {
      assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
      assert.equal(result.terminal.modelOutput.message, 'All fifteen sources processed.');
    } else {
      assert.equal(result.terminal?.executionStatus, 'failed', JSON.stringify(result));
      assert.match(result.terminal.errorMessage, /Inference owner allowance exceeded \(invocations\)/u);
      assert.equal(f.requests.filter(request => !isRecovery(request)).length, 15);
    }
  });
});

test('four distinct inspection actions at an unchanged boundary remain capped after restart', async () => {
  const f = await fixture();
  let inspections = 0;
  f.recover(() => call('context_inspect', { limit: ++inspections, maxBytes: 2048 }));
  const first = await new AgentRuntime(f.options()).run({ runId: 'bounded-inspection', task: applicationTask }).result;
  assert.equal(first.state, 'suspended', JSON.stringify(first));
  assert.equal(first.reason, 'context_admission');
  assert.equal(first.contextAdmission.recovery, 'attempt_limit');
  assert.equal(f.recoveryRequests().length, 4);
  const tasks = f.recoveryRequests().map(controlTask);
  assert.equal(new Set(tasks.map(task => task.conflict.recoveryBoundary)).size, 1);
  assert.deepEqual(tasks.map(task => task.attempt), [1, 2, 3, 4]);
  const resumed = await new AgentRuntime(f.options()).resume('bounded-inspection').result;
  assert.equal(resumed.state, 'suspended', JSON.stringify(resumed));
  assert.equal(resumed.reason, 'context_admission');
  assert.equal(resumed.contextAdmission.recovery, 'attempt_limit');
  assert.equal(resumed.contextAdmission.recoveryBoundary, first.contextAdmission.recoveryBoundary);
  assert.equal(f.requests.length, 4);
  assert.equal(f.reads(), 0);
  const owner = await f.inferenceRepository.load('bounded-inspection');
  assert.equal(owner.committed.invocations, 4);
  assert.equal(owner.settledUsage.invocations, 4);
});

test('retryable provider failures consume the durable unchanged-boundary allowance', async () => {
  const f = await fixture();
  let attempts = 0;
  f.recover(() => {
    if (++attempts === 3) return call('context_inspect', { limit: 1, maxBytes: 2048 });
    throw new ModelProviderError({ provider: 'recovery-accounting-fixture', code: 'provider_unavailable',
      message: 'Control generation has not produced output.', retryable: true });
  });
  const first = await new AgentRuntime(f.options()).run({ runId: 'retry-boundary-cap', task: applicationTask }).result;
  assert.equal(first.state, 'suspended', JSON.stringify(first));
  assert.equal(first.reason, 'context_admission');
  assert.equal(first.contextAdmission.recovery, 'attempt_limit');
  assert.equal(f.recoveryRequests().length, 4);
  const log = await records(f, 'retry-boundary-cap');
  const snapshots = log.filter(event => event.type === 'turn.snapshot.created').map(event => event.snapshot);
  assert.equal(snapshots.length, 4);
  assert.ok(snapshots.every(snapshot => snapshot.contextRecovery));
  assert.equal(new Set(snapshots.map(snapshot => snapshot.contextRecovery.recoveryBoundary)).size, 1);
  const owner = await f.inferenceRepository.load('retry-boundary-cap');
  assert.equal(owner.committed.invocations, 4);
  assert.equal(owner.settledUsage.invocations, 1);
  assert.ok(owner.committed.usage.promptTokens > owner.settledUsage.usage.promptTokens);
  const resumed = await new AgentRuntime(f.options()).resume('retry-boundary-cap').result;
  assert.equal(resumed.state, 'suspended', JSON.stringify(resumed));
  assert.equal(resumed.reason, 'context_admission');
  assert.equal(resumed.contextAdmission.recovery, 'attempt_limit');
  assert.equal(resumed.contextAdmission.recoveryBoundary, first.contextAdmission.recoveryBoundary);
  assert.equal(f.requests.length, 4);
});

test('process loss after a control failure fails closed without dispatching a reconstructed application candidate', async t => {
  for (const boundary of ['receipt', 'failed_phase', 'retry_prepared']) await t.test(boundary, async () => {
    class InterruptedControlFailureRepository extends InMemoryEventRepository {
      stopped = false;
      interrupt = true;
      async appendConditional(runId, event, options) {
        if (this.stopped) throw new Error('simulated process stop after control failure');
        const receipt = await super.appendConditional(runId, event, options);
        const updates = event.type === 'run.state.transitioned' && event.transition.kind === 'updated'
          ? event.transition.providerRequests ?? [] : [];
        if (this.interrupt && (
          (boundary === 'receipt' && event.type === 'provider.attempt.failed') ||
          (boundary === 'failed_phase' && updates.some(entry => entry.value.stage === 'failed')) ||
          (boundary === 'retry_prepared' && updates.some(entry =>
            entry.value.stage === 'ready' && entry.value.identity.requestAttempt === 2))
        )) {
          this.interrupt = false;
          this.stopped = true;
          throw new Error('simulated process stop after control failure');
        }
        return receipt;
      }
    }
    const events = new InterruptedControlFailureRepository(agentEventCodec);
    const f = await fixture({ events });
    f.recover(() => {
      throw new ModelProviderError({ provider: 'recovery-accounting-fixture', code: 'provider_unavailable',
        message: 'Recorded control generation failure.', retryable: true });
    });
    const runId = `control-crash-${boundary}`;
    const control = new AgentRuntime(f.options()).run({ runId, task: applicationTask });
    await assert.rejects(control.result, /simulated process stop|unresolved started provider effect/u);
    assert.equal(events.stopped, true, 'The selected durable boundary must have been reached.');
    assert.equal(f.requests.length, 1);
    assert.ok(isRecovery(f.requests[0]));
    const before = await f.sessions.loadReplayState(f.descriptor);
    const originalInputs = before.branch.filter(entry => entry.type === 'input');
    assert.ok(originalInputs.some(entry => entry.runId === runId && entry.task === applicationTask));
    assert.ok(originalInputs.some(entry => entry.runId === 'seed' && entry.task.includes('Old optional evidence')));
    const collections = f.contextCollections.length;
    events.stopped = false;
    f.recover(select);
    const resumed = await new AgentRuntime(f.options()).resume(runId).result;
    assert.equal(resumed.terminal?.executionStatus, 'failed', JSON.stringify(resumed));
    assert.equal(resumed.terminal.terminationReason, 'provider_error');
    assert.equal(resumed.terminal.errorMessage, 'Recorded control generation failure.');
    assert.equal(resumed.terminal.modelOutput.status, 'absent');
    assert.equal(f.requests.length, 1, 'Restart must not dispatch either the control retry or application work.');
    assert.equal(f.contextCollections.length, collections);
    const after = await f.sessions.loadReplayState(f.descriptor);
    assert.deepEqual(after.branch.filter(entry => entry.type === 'input'), originalInputs);
    assert.ok(!after.branch.some(entry => entry.type === 'context_transition'));
    const log = await records(f, runId);
    assert.equal(log.filter(event => event.type === 'turn.snapshot.created').length, 1);
    assert.ok(!log.some(event => event.type === 'tool.started'));
    const fingerprint = log.find(event => event.type === 'inference.request.fingerprinted').fingerprint;
    const owner = await f.inferenceRepository.load(runId, { invocationId: fingerprint.requestId });
    assert.equal(owner.committed.invocations, 1);
    assert.equal(owner.settledUsage.invocations, 0);
    assert.equal(owner.invocation.start.purpose, 'context_recovery');
    assert.ok(owner.invocation.uncertain);
    assert.equal(owner.invocation.settlement, undefined);
  });
});

test('resuming a settled recovery response restores application authority and the ordinary tool catalog', async () => {
  class InterruptedControlSettlementRepository extends InMemoryEventRepository {
    stopped = false;
    interrupt = false;
    async appendConditional(runId, event, options) {
      if (this.stopped) throw new Error('simulated process stop after control settlement');
      const receipt = await super.appendConditional(runId, event, options);
      if (this.interrupt && event.type === 'run.state.transitioned' && event.transition.kind === 'updated' &&
          event.transition.providerRequests?.some(entry => entry.value.stage === 'settled')) {
        this.interrupt = false;
        this.stopped = true;
        throw new Error('simulated process stop after control settlement');
      }
      return receipt;
    }
  }
  const events = new InterruptedControlSettlementRepository(agentEventCodec);
  const f = await fixture({ events });
  events.interrupt = true;
  const runId = 'settled-control';
  const runInstruction = 'RUN AUTHORITY: verify the accepted task before reporting completion.';
  const control = new AgentRuntime(f.options()).run({ runId, task: applicationTask, instructions: [runInstruction] });
  await assert.rejects(control.result, /simulated process stop|unresolved started provider effect/u);
  assert.equal(events.stopped, true);
  assert.equal(f.requests.length, 1);
  assert.ok(isRecovery(f.requests[0]));
  events.stopped = false;
  const resumed = await new AgentRuntime(f.options()).resume(runId).result;
  assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
  assert.equal(f.requests.length, 2, 'The settled control response must be consumed without a second recovery dispatch.');
  assert.equal(f.recoveryRequests().length, 1);
  const ordinary = f.requests[1];
  assert.ok(!isRecovery(ordinary));
  assert.ok(ordinary.messages.some(item => item.role === 'user' && item.content === applicationTask));
  assert.ok(ordinary.messages.some(item => item.content.includes(applicationInstruction)));
  assert.ok(ordinary.messages.some(item => item.content.includes(runInstruction)));
  assert.ok(ordinary.tools.some(tool => tool.function?.name === 'domain_read'));
  assert.ok(!JSON.stringify(ordinary.messages).includes('recentRecoveryResults'));
  const log = await records(f, runId);
  assert.equal(log.filter(event => event.type === 'tool.started' && event.toolName === 'context_transition').length, 1);
  const snapshots = log.filter(event => event.type === 'turn.snapshot.created').map(event => event.snapshot);
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots[0].contextRecovery);
  assert.equal(snapshots[1].contextRecovery, undefined);
  assert.ok(snapshots[1].instructions.some(item => item.content === applicationInstruction));
  assert.ok(snapshots[1].instructions.some(item => item.content === runInstruction));
  const owner = await f.inferenceRepository.load(runId);
  assert.equal(owner.committed.invocations, 2);
  assert.equal(owner.settledUsage.invocations, 2);
  assert.equal(f.reads(), 0);
});
