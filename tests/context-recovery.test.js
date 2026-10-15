import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { conservativeProtocolCapabilities, compileModelRequest } from '@agent-core/model';
import { defineTool, ToolInputError, serializeToolModelContent } from '@agent-core/tools';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime, ContextService, HistoryReader, InMemorySessionRepository,
  InMemoryInferenceRepository, InferenceService, agentEventCodec, createHistoryTools, resolveToolObservation, resolveToolModelContent
} from '@agent-core/runtime';

const marker = 'Prepare a fresh context for the same ongoing work';
const response = (content = 'Done.') => ({ provider: 'recovery-fixture', model: 'fixture', content, terminationReason: 'stop' });
const call = (name, value = {}) => ({ ...response(''), terminationReason: 'tool_calls',
  toolCalls: [{ id: `call-${crypto.randomUUID()}`, type: 'function', name, input: { kind: 'json', value } }] });
const select = () => call('context_transition', { reason: 'Release old optional material; preserve active task.', retain: [] });

async function fixture({ allowedRisks = ['read', 'write'], budget, sourceBytes = 24000, sourceBound = 100000, targetCapacity = 19400,
  events = new InMemoryEventRepository(agentEventCodec), toolOutput = () => 'written' } = {}) {
  const sessions = new InMemorySessionRepository();
  const descriptor = await sessions.create({ binding: { schemaId: 'recovery-tests', schemaVersion: 1, subject: {} } });
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session: descriptor, events, artifacts });
  const inferenceRepository = new InMemoryInferenceRepository();
  const requests = [];
  let effects = 0;
  let recover = select;
  const capacity = targetCapacity;
  const provider = {
    id: 'recovery-fixture', implementationId: 'recovery-fixture@1',
    describe: () => ({ id: 'recovery-fixture', displayName: 'Recovery fixture', defaultModel: 'fixture' }),
    describeModel: async () => ({
      id: 'fixture', provider: 'recovery-fixture',
      capabilities: { protocol: conservativeProtocolCapabilities('fixture://recovery', { contextReset: 'fresh_request' }), streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false,
        jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: capacity, outputTokens: 1024 },
      supportedParameters: ['tools', 'maxOutputTokens']
    }),
    complete: async request => {
      requests.push(request);
      return request.messages.some(item => item.role === 'user' && item.content.includes(marker))
        ? recover(request) : response();
    }
  };
  const domain = defineTool({ name: 'domain_write', implementationId: 'fixture.domain-write@1', description: 'Perform domain write.',
    schema: z.strictObject({}), outputSchema: z.string(), canonicalizeInput: input => input,
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'domain' }], lockScopes: ['domain'] },
    deriveEffects: () => ({ accesses: [{ mode: 'write', scope: 'domain' }], lockScopes: ['domain'], recovery: { kind: 'unknown' } }),
    invoke: async () => { effects++; return { kind: 'result', output: toolOutput(effects), summary: 'Written', scope: { resources: ['domain'], coverage: 'complete' } }; }
  });
  const options = maxSourceBytes => {
    const context = new ContextService({ repository: sessions, session: descriptor, history, artifacts,
      policy: { maxSourceBytes, historyRead: { history, isAvailable: () => true } } });
    return { provider, model: 'fixture', context, contextRenewal: { automatic: true },
      repositories: { events, artifacts, session: { repository: sessions, descriptor } },
      tools: [domain, ...context.toolDefinitions(), ...createHistoryTools({ history })],
      toolPolicy: { allowedRisks }, toolBoundary: { authorizationPolicyId: 'recovery-test', executionTargetId: 'recovery-test' },
      maxOutputTokens: 512,
      inferenceService: new InferenceService({ provider, artifacts, repository: inferenceRepository, ...(budget ? { budget } : {}) }) };
  };
  const seed = await new AgentRuntime({ ...options(100000), tools: [], contextRenewal: { automatic: false } }).run({ runId: 'seed', task: 'Old optional evidence: ' + 'x'.repeat(sourceBytes) }).result;
  assert.equal(seed.terminal?.executionStatus, 'completed');
  return { options: () => options(sourceBound), provider, requests, events, artifacts, history, sessions, descriptor, inferenceRepository,
    effects: () => effects, recover: value => { recover = value; },
    recoveryRequests: () => requests.filter(request => request.messages.some(item => item.role === 'user' && item.content.includes(marker))) };
}

// These routing tests use exact fixture counts so pagination/read contents do not tune the trigger.
function countedCheckpoint(f) {
  f.provider.compileRequest = async request => {
    const { signal: _signal, ...body } = request;
    const oldHistory = request.messages.some(item => item.role === 'user' && item.content.startsWith('Old optional evidence:'));
    const checkpoint = request.messages.some(item => item.content.includes(marker));
    return compileModelRequest({ request, body, profile: await f.provider.describeModel(), endpoint: 'fixture://counted-recovery',
      providerInputTokens: oldHistory ? (checkpoint ? 18800 : 16000) : (checkpoint ? 3100 : 1000) });
  };
}

async function records(f, runId) { const result = []; for await (const { event } of f.events.read(runId)) result.push(event); return result; }

test('restricted recovery uses the ordinary executor and restores original application work', async () => {
  const f = await fixture();
  const result = await new AgentRuntime(f.options()).run({ runId: 'recover', task: 'ACTUAL TASK: preserve this exact input.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.ok(f.recoveryRequests().length > 0);
  assert.ok(f.recoveryRequests()[0].messages.some(item => item.content.includes('x'.repeat(24000))), 'The checkpoint sees the complete original material.');
  assert.equal(f.effects(), 0);
  const log = await records(f, 'recover');
  assert.ok(log.some(event => event.type === 'tool.started' && event.toolName === 'context_transition'));
  assert.ok(log.some(event => event.type === 'turn.snapshot.created' && event.snapshot.contextRecovery));
  const ordinary = f.requests.at(-1);
  assert.ok(ordinary.messages.some(item => item.role === 'user' && item.content.includes('ACTUAL TASK')));
  assert.ok(!JSON.stringify(ordinary.messages).includes(marker));
  assert.ok(!ordinary.messages.some(item => item.toolName === 'context_transition'));
});

test('recovery cannot execute domain side effects or claim a final answer, including after restart', async () => {
  for (const behavior of [() => call('domain_write'), () => response('Task complete without doing it.')]) {
    const f = await fixture();
    f.recover(behavior);
    const first = await new AgentRuntime(f.options()).run({ runId: 'blocked', task: 'ACTUAL TASK: keep read-only requirements.' }).result;
    assert.equal(first.state, 'suspended', JSON.stringify(first));
    assert.equal(f.effects(), 0);
    assert.ok(!(await records(f, 'blocked')).some(event => event.type === 'tool.started' && event.toolName === 'domain_write'));
    f.recover(select);
    const resumed = await new AgentRuntime(f.options()).resume('blocked').result;
    assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
    assert.equal(f.effects(), 0);
    const ordinary = f.requests.at(-1);
    assert.ok(ordinary.messages.some(item => item.content.includes('ACTUAL TASK')));
    assert.ok(!JSON.stringify(ordinary.messages).includes('Task complete without doing it.'));
  }
});

test('unchanged recovery inspection is bounded across restart and does not repeat domain work', async () => {
  const f = await fixture();
  f.recover(() => call('context_inspect', { limit: 2, maxBytes: 4096 }));
  const first = await new AgentRuntime(f.options()).run({ runId: 'unchanged', task: 'ACTUAL TASK' }).result;
  assert.equal(first.state, 'suspended', JSON.stringify(first));
  const attempts = f.recoveryRequests().length;
  assert.ok(attempts > 0 && attempts <= 4);
  const resumed = await new AgentRuntime(f.options()).resume('unchanged').result;
  assert.equal(resumed.state, 'suspended', JSON.stringify(resumed));
  assert.equal(f.recoveryRequests().length, attempts);
  assert.equal(f.effects(), 0);
});

test('context recovery cannot bypass ordinary tool write authorization', async () => {
  const f = await fixture();
  const authorizations = [];
  const result = await new AgentRuntime({ ...f.options(), toolAuthorizer: request => {
    authorizations.push(request);
    return { decision: 'deny', reason: 'Context writes are denied for this test.' };
  } }).run({ runId: 'denied', task: 'ACTUAL TASK' }).result;
  assert.notEqual(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(f.effects(), 0);
  assert.ok(authorizations.length > 0);
  assert.ok(authorizations.every(request => request.call.name === 'context_transition' &&
    request.effects.accesses.some(access => access.mode === 'write' && access.scope.startsWith('context/')) &&
    typeof request.fingerprint === 'string'));
  const view = await f.sessions.sourceSnapshot(f.descriptor);
  assert.equal((await Array.fromAsync(view.entries)).filter(entry => entry.type === 'context_transition').length, 0);
});

test('recovery consumes the same inference budget as ordinary work', async () => {
  const f = await fixture({ budget: { maxInvocations: 1 } });
  f.recover(() => call('context_inspect', { limit: 2, maxBytes: 4096 }));
  const first = await new AgentRuntime(f.options()).run({ runId: 'budget', task: 'ACTUAL TASK' }).result;
  assert.notEqual(first.terminal?.executionStatus, 'completed', JSON.stringify(first));
  assert.equal((await f.inferenceRepository.load('budget')).settledUsage.invocations, 1);
  assert.equal(f.recoveryRequests().length, 1);
  assert.equal(f.effects(), 0);
});

test('native state from a restricted recovery invocation never binds the resumed domain prefix', async () => {
  const { createProviderContextState } = await import('@agent-core/model');
  const f = await fixture();
  f.recover(async request => ({ ...response('Do not replay this recovery-only answer.'),
    output: [{ type: 'protocol', state: await createProviderContextState({
      provider: 'recovery-fixture', protocolRevision: 'conservative-v1', endpoint: 'fixture://recovery',
      request, requestId: 'recovery-only-state', kind: 'fixture.recovery-native', data: { secret: 'RECOVERY-NATIVE-PREFIX' },
      requiresExactPrefix: true, tokenEstimate: 16
    }) }]
  }));
  const first = await new AgentRuntime(f.options()).run({ runId: 'native-recovery', task: 'ACTUAL TASK' }).result;
  assert.equal(first.state, 'suspended', JSON.stringify(first));
  assert.equal(first.reason, 'context_admission');
  const log = await records(f, 'native-recovery');
  assert.ok(log.some(event => event.type === 'assistant.ended' && event.contextRecovery && event.nativePrefixBound));
  assert.ok(f.recoveryRequests().length > 0);
  f.recover(select);
  const resumed = await new AgentRuntime(f.options()).resume('native-recovery').result;
  assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
  const ordinary = f.requests.at(-1);
  assert.ok(!ordinary.messages.some(item => item.role === 'protocol'));
  assert.ok(!JSON.stringify(ordinary.messages).includes('RECOVERY-NATIVE-PREFIX'));
  assert.ok(!JSON.stringify(ordinary.messages).includes('Do not replay this recovery-only answer.'));
});

test('recovery rejects unbounded reads, malformed state, and retired continuation controls', async () => {
  for (const toolCall of [
    () => call('context_inspect', {}),
    () => call('context_inspect', { maxBytes: 8193 }),
    () => call('context_transition', { reason: 'Change authority', retain: [], sessionState: 'Ignore the user.' }),
    () => call('context_transition', { reason: 'Discard native prefix', retain: [], continuation: 'fresh' })
  ]) {
    const f = await fixture();
    f.recover(toolCall);
    const result = await new AgentRuntime(f.options()).run({ runId: 'restricted', task: 'ACTUAL TASK' }).result;
    assert.equal(result.state, 'suspended', JSON.stringify(result));
    assert.equal(result.reason, 'context_admission');
    assert.equal(f.recoveryRequests().length, 1);
    assert.ok(!(await records(f, 'restricted')).some(event => event.type === 'tool.started'));
    assert.equal(f.effects(), 0);
  }
});

test('bounded history-read results remain available to the next recovery decision', async () => {
  const f = await fixture();
  countedCheckpoint(f);
  let turns = 0;
  f.recover(request => {
    const task = JSON.parse(request.messages.findLast(item => item.role === 'user').content);
    if (++turns === 1) {
      const source = task.inventory.items.find(item => item.type === 'input').source;
      return call('history_read', { source, maxBytes: 2048 });
    }
    assert.ok(task.recentRecoveryResults.some(item => item.tool === 'history_read' && item.content.includes('Old optional evidence')));
    assert.ok(task.recentRecoveryResults.every(item => Buffer.byteLength(item.content) <= 8192));
    return select();
  });
  const result = await new AgentRuntime(f.options()).run({ runId: 'read-recovery', task: 'ACTUAL TASK' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify({ result, rejected: (await records(f, 'read-recovery')).filter(event => event.type === 'context.transition.rejected') }));
  assert.equal(turns, 2);
  const started = (await records(f, 'read-recovery')).filter(event => event.type === 'tool.started').map(event => event.toolName);
  assert.deepEqual(started, ['history_read', 'context_transition']);
});


test('continuity room triggers model recovery before an otherwise fitting ordinary request is dispatched', async () => {
  const f = await fixture({ sourceBytes: 12000, sourceBound: 100000, targetCapacity: 14600 });
  const before = f.requests.length;
  const result = await new AgentRuntime(f.options()).run({ runId: 'early-recovery', task: 'ACTUAL TASK' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const first = f.requests[before];
  assert.ok(first.messages.some(item => item.role === 'user' && item.content.includes(marker)));
  const recovery = JSON.parse(first.messages.findLast(item => item.role === 'user').content);
  assert.equal(recovery.conflict.kind, 'request_capacity');
  assert.ok(Math.ceil(recovery.conflict.estimatedInputTokens * 1.2) + recovery.conflict.outputReservation < recovery.conflict.contextTokens,
    JSON.stringify(recovery.conflict));
  assert.match(recovery.conflict.message, /continuity room/);
  assert.ok(f.requests.at(-1).messages.some(item => item.content.includes('ACTUAL TASK')));
  assert.equal(f.effects(), 0);
});

async function inspectPresentation(context, input = {}) {
  const tool = context.toolDefinitions().find(item => item.name === 'context_inspect');
  const canonical = await tool.canonicalizeInput(input, {});
  const execution = await tool.bindExecution(canonical, {});
  const observation = await execution.invoke({});
  assert.equal(observation.kind, 'result');
  const content = tool.buildModelContent({ observation });
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  return { text: content[0].text, value: JSON.parse(content[0].text), observation };
}

test('context inspection budgets complete UTF-8 JSON while pagination retains exact sources and obligations', async () => {
  const f = await fixture({ sourceBytes: 64, sourceBound: 100000, targetCapacity: 64000 });
  const options = f.options();
  for (let i = 0; i < 8; i++)
    await new AgentRuntime(options).run({ runId: `page-${i}`, task: `Original ${i}: ${'日本語🦉'.repeat(30)}` }).result;
  const wide = await inspectPresentation(options.context, { maxBytes: 128000, limit: 100 });
  assert.equal(wide.value.selection.coverage, 'complete');
  const expected = wide.value.selection.items.map(item => item.source);
  const selected = [];
  let cursor;
  let pages = 0;
  do {
    const page = await inspectPresentation(options.context, cursor ? { cursor, maxBytes: 8192 } : {});
    assert.ok(Buffer.byteLength(page.text) <= 8192);
    assert.deepEqual(page.value.selection.cut, wide.value.selection.cut);
    assert.deepEqual(page.value.protectedSources, wide.value.protectedSources);
    assert.deepEqual(page.value.pendingWork, wide.value.pendingWork);
    assert.deepEqual(page.value.sessionState, wide.value.sessionState);
    assert.deepEqual(page.value.accounting, wide.value.accounting);
    selected.push(...page.value.selection.items.map(item => item.source));
    cursor = page.value.selection.cursor;
    assert.equal(page.value.selection.coverage, cursor ? 'partial' : 'complete');
    assert.ok(++pages <= expected.length + 1);
  } while (cursor);
  assert.ok(pages > 1);
  assert.deepEqual(selected, expected);
});

test('inspection reports an impossible whole-envelope bound without dropping protected or pending metadata', async () => {
  const f = await fixture({ sourceBytes: 64, sourceBound: 100000, targetCapacity: 64000 });
  const context = f.options().context;
  const original = context.inspect.bind(context);
  let inspections = 0;
  context.inspect = async (...args) => {
    inspections++;
    return { ...(await original(...args)),
      pendingWork: [{ runId: 'pending', submissionId: 'must-preserve-' + 'x'.repeat(9000), state: 'accepted' }] };
  };
  for (const maxBytes of [4096, 8192]) {
    const before = inspections;
    await assert.rejects(inspectPresentation(context, { maxBytes }), error =>
      error instanceof ToolInputError && /cannot fit maxBytes/.test(error.message));
    assert.equal(inspections - before, 1);
  }
  const complete = await inspectPresentation(context, { maxBytes: 16384 });
  assert.ok(Buffer.byteLength(complete.text) <= 16384);
  assert.equal(complete.value.pendingWork[0].submissionId.length, 9014);
});


test('paged inspection of large session state reads only metadata and retains an authorized exact-source reference', async (t) => {
  const f = await fixture({ sourceBytes: 64, sourceBound: 100000, targetCapacity: 64000 });
  const context = f.options().context;
  const cut = await f.history.capture();
  const requestRef = await f.artifacts.storeProtected({ label: 'state-origin', mediaType: 'application/json',
    content: new TextEncoder().encode(JSON.stringify({ sessionStateRevisionId: null, logical: { model: 'fixture', messages: [] } })) });
  const body = JSON.stringify({ working: [{ id: 'notes', text: 'GENERATED-STATE ' + 'x'.repeat(52000) }] });
  const sessionState = { id: 'large-session-state', previousRevisionId: null, capturedHistoryCut: cut,
    content: JSON.parse(body),
    inference: { ownerId: 'owner', invocationId: 'state-origin', requestRef } };
  const update = await context.transition({ expectedWindowId: (await context.history.selectedContext(cut))?.windowId ?? null,
    expectedSourceRevision: cut.sourceRevision, sessionState, idempotencyKey: 'large-session-state', reason: 'Fixture admitted state',
    selection: await context.freshSelection({ selection: await context.selectSources(cut, {}), model: { provider: f.provider.id, model: 'fixture' }, profile: await f.provider.describeModel(), cut, resetId: 'fixture-state' }) },
    { admit: async () => ({ compiledInputIdentity: 'fixture-state', capabilityRevision: 'fixture' }) });
  assert.equal(update.transition.admission.status, 'admitted');
  const reads = [];
  for (const method of ['readVerified', 'readVerifiedRange']) {
    const original = f.artifacts[method].bind(f.artifacts);
    t.mock.method(f.artifacts, method, async (...args) => { reads.push({ method, args }); return original(...args); });
  }
  const page = await inspectPresentation(context);
  assert.ok(Buffer.byteLength(page.text) <= 8192);
  assert.deepEqual(reads, []);
  assert.equal(page.value.sessionState.revisionId, 'large-session-state');
  assert.equal(page.value.sessionState.content, undefined);
  assert.equal(page.value.sessionState.complete, false);
  assert.equal(page.value.sessionState.totalBytes, Buffer.byteLength(body));
  const retrieved = await f.history.read({ source: page.value.sessionState.source, maxBytes: 1024 });
  assert.equal(retrieved.status, 'available');
  assert.ok(retrieved.item.text.includes('GENERATED-STATE'));
  assert.deepEqual(reads, [], 'Committed inline state is retrieved from its original journal record, not an artifact.');
  const unpaged = await context.inspect();
  assert.ok(unpaged.sessionState.preview.includes('GENERATED-STATE'));
  assert.equal(unpaged.sessionState.complete, false);
});

test('admission, feedback, and inspection disclose the same compiled control reserve', async () => {
  const f = await fixture({ sourceBytes: 12000, sourceBound: 100000, targetCapacity: 14600 });
  const options = f.options();
  let blocked;
  let conflict;
  f.recover(async request => {
    conflict = JSON.parse(request.messages.findLast(item => item.role === 'user').content).conflict;
    blocked = await options.context.inspect(undefined, { limit: 12, maxBytes: 4096 });
    return select();
  });
  const result = await new AgentRuntime(options).run({ runId: 'visible-reserve', task: 'ACTUAL TASK' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(blocked.admission.status, 'blocked');
  assert.equal(blocked.capacity.continuityHeadroomPolicy, 'required');
  assert.equal(blocked.capacity.pressure, 'continuity');
  assert.equal(blocked.capacity.ordinaryRemainingTokens, 0);
  assert.ok(blocked.capacity.continuityHeadroomTokens > blocked.capacity.outputReservation);
  assert.equal(blocked.capacity.continuityHeadroomTokens, Number(conflict.message.match(/requires (\d+) tokens/)[1]));
  const candidate = f.requests.find(request => request.messages.some(item => item.content.includes('ACTUAL TASK')));
  assert.ok(candidate);
  const final = await options.context.inspect(undefined, { limit: 12, maxBytes: 4096 });
  assert.equal(final.admission.status, 'admitted');
  assert.equal(final.capacity.continuityHeadroomPolicy, 'required');
  assert.ok(final.capacity.remainingTokens >= final.capacity.continuityHeadroomTokens);
});

test('a cheaper compiled checkpoint does not invent excessive continuity pressure', async () => {
  const { compileModelRequest } = await import('@agent-core/model');
  const f = await fixture({ sourceBytes: 64, sourceBound: 100000, targetCapacity: 6000 });
  f.provider.compileRequest = async request => {
    const { signal: _signal, ...body } = request;
    return compileModelRequest({ request, body, profile: await f.provider.describeModel(),
      endpoint: 'fixture://mandatory-capacity',
      providerInputTokens: request.messages.some(item => item.content.includes(marker)) ? 2300 : 4500 });
  };
  const options = f.options();
  const result = await new AgentRuntime(options).run({ runId: 'mandatory-reserve', task: 'Mandatory initial request.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(f.recoveryRequests().length, 0);
  const current = await options.context.inspect(undefined, { limit: 12, maxBytes: 4096 });
  assert.equal(current.capacity.continuityHeadroomTokens, 0);
  assert.equal(current.capacity.inputTokens, 4500);
  assert.equal(current.capacity.remainingTokens, 988);
  assert.equal(current.capacity.pressure, 'normal');
});

test('a short request still requires room to retain its large ordinary generation', async () => {
  const f = await fixture({ sourceBytes: 64, sourceBound: 100000, targetCapacity: 32768 });
  const describe = f.provider.describeModel;
  f.provider.describeModel = async () => {
    const profile = await describe();
    return { ...profile, limits: { ...profile.limits, outputTokens: 16384 } };
  };
  const options = { ...f.options(), maxOutputTokens: 16384 };
  const result = await new AgentRuntime(options).run({ runId: 'large-output', task: 'Explain this small example.' }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.reason, 'context_admission');
  assert.ok(f.recoveryRequests().length > 0);
  const resumed = await new AgentRuntime({ ...options, maxOutputTokens: 8192 }).resume('large-output').result;
  assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
  assert.equal(f.requests.at(-1).maxOutputTokens, 8192);
});

test('ordinary turns and settled tool batches compile control probes without scanning durable recovery attempts', async t => {
  const { compileModelRequest } = await import('@agent-core/model');
  const f = await fixture({ sourceBytes: 64, sourceBound: 100000, targetCapacity: 64000 });
  const options = f.options();
  const counts = { ordinaryCompilations: 0, controlCompilations: 0, recoveryQueries: 0, boundedInspections: 0, unpagedInspections: 0 };
  f.provider.compileRequest = async request => {
    const control = request.messages.some(item => item.content.includes(marker));
    counts[control ? 'controlCompilations' : 'ordinaryCompilations']++;
    const { signal: _signal, ...body } = request;
    return compileModelRequest({ request, body, profile: await f.provider.describeModel(),
      endpoint: 'fixture://probe-work', providerInputTokens: 100 });
  };
  let ordinaryTurns = 0;
  f.provider.complete = async request => {
    assert.ok(!request.messages.some(item => item.content.includes(marker)));
    return ++ordinaryTurns < 3 ? call('domain_write') : response();
  };
  const readMetadata = f.events.readMetadataRange.bind(f.events);
  t.mock.method(f.events, 'readMetadataRange', async (runId, query) => {
    if (query?.types?.includes('turn.snapshot.created')) counts.recoveryQueries++;
    return readMetadata(runId, query);
  });
  const inspect = options.context.inspect.bind(options.context);
  t.mock.method(options.context, 'inspect', async (cut, page) => {
    counts[page ? 'boundedInspections' : 'unpagedInspections']++;
    return inspect(cut, page);
  });
  const result = await new AgentRuntime(options).run({ runId: 'ordinary-probe-work', task: 'Complete the ordinary work.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  // Three inference candidates plus two completed batches each check their exact successor.
  assert.deepEqual(counts, { ordinaryCompilations: 5, controlCompilations: 5, recoveryQueries: 0, boundedInspections: 5, unpagedInspections: 0 });
  t.diagnostic(JSON.stringify({ measurement: 'three ordinary turns', counts }));
});

test('recovery sees the current request independently of a twelve-item inventory after twenty old records', async () => {
  const f = await fixture();
  countedCheckpoint(f);
  for (let i = 0; i < 20; i++) await f.sessions.appendAssistant(f.descriptor, {
    runId: `old-${i}`, identity: { turnId: `old-${i}`, turnIndex: i, requestAttempt: 1, toolBatchId: `old-batch-${i}` },
    content: `Old unrelated completed record ${i}`
  });
  let presented;
  f.recover(request => {
    presented = JSON.parse(request.messages.findLast(item => item.role === 'user').content);
    presented.toolNames = request.tools.map(tool => tool.type === 'function' ? tool.function.name : tool.name);
    return select();
  });
  const result = await new AgentRuntime(f.options()).run({ runId: 'request-after-twenty',
    task: 'CURRENT REQUEST: inspect the unpaid invoice only.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.ok(presented);
  assert.equal(presented.currentRequest.text, 'CURRENT REQUEST: inspect the unpaid invoice only.');
  assert.equal(presented.currentRequest.coverage, 'complete');
  assert.equal(presented.currentRequest.sourceIdentity.runId, 'request-after-twenty');
  assert.ok(presented.inventory.items.length <= 12);
  assert.equal(presented.inventory.coverage, 'partial');
  assert.ok(presented.inventory.cursor);
  assert.equal(presented.sessionState.authority, 'fallible_model_interpretation');
  assert.ok(presented.toolNames.includes('history_search'));

  assert.equal(f.effects(), 0);
});

// Preview bounds are independent of state/source size and keep their original identity.
test('oversized full-context state cannot be replaced by a bounded checkpoint preview', async () => {
  const f = await fixture({ sourceBound: 100000, targetCapacity: 14600 });
  const options = f.options();
  const context = options.context;
  const cut = await f.history.capture();
  const requestRef = await f.artifacts.storeProtected({ label: 'state-origin', mediaType: 'application/json',
    content: new TextEncoder().encode(JSON.stringify({ sessionStateRevisionId: null, logical: { model: 'fixture', messages: [] } })) });
  const sessionState = { id: 'preview-state', previousRevisionId: null, capturedHistoryCut: cut,
    content: { working: [{ id: 'notes', text: 'Important uncertainty: verify the original. ' + '文😀'.repeat(4000) }] },
    inference: { ownerId: 'owner', invocationId: 'state-origin', requestRef } };
  await context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'preview-state', sessionState, reason: 'Fixture admitted state', selection: await context.freshSelection({ selection: await context.selectSources(cut, {}), model: { provider: f.provider.id, model: 'fixture' }, profile: await f.provider.describeModel(), cut, resetId: 'fixture-state' }) },
    { admit: async () => ({ compiledInputIdentity: 'fixture-state', capabilityRevision: 'fixture' }) });
  const result = await new AgentRuntime(options).run({ runId: 'preview-recovery', task: 'Current scoped question.' }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.contextAdmission.recovery, 'request_unavailable');
  assert.equal(f.recoveryRequests().length, 0, 'A preview cannot replace the full state in a checkpoint.');
  const preview = await context.inspectSessionState(undefined, 2048);
  assert.equal(preview.complete, false);
  assert.ok(Buffer.byteLength(preview.preview) <= 2048);
  assert.match(preview.preview, /verify the original/);
  assert.equal((await context.sessionState()).revision.id, 'preview-state');
});

test('oversized steering cannot be silently replaced by its bounded preview', async () => {
  const f = await fixture();
  const handle = new AgentRuntime(f.options()).run({ runId: 'recent-steering', task: 'Inspect only.' });
  for (let i = 1; i <= 15; i++) handle.injectSteering({ deliveryId: `correction-${i}`,
    instruction: `Steering ${i}: ${'x'.repeat(900)} End of steering ${i}` });
  const result = await handle.result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(f.recoveryRequests().length, 0);
  assert.equal((await records(f, 'recent-steering')).filter(event => event.type === 'input.steering.accepted').length, 15);
});


for (const reasoningAccounting of ['included_output', 'separate']) {
  for (const inputOnly of [false, true]) {
    test(`renewal precedes retained ordinary output larger than checkpoint output (${reasoningAccounting}, ${inputOnly ? 'input maximum' : 'context maximum'})`, async () => {
      const f = await fixture({ sourceBytes: 64, targetCapacity: inputOnly ? 65536 : 32768 });
      f.requests.length = 0;
      const describe = f.provider.describeModel;
      f.provider.describeModel = async () => {
        const profile = await describe();
        return { ...profile,
          supportedParameters: [...profile.supportedParameters, 'reasoning'],
          capabilities: { ...profile.capabilities,
            reasoning: { strategies: ['budget'], canDisable: false, separateOutput: true },
            protocol: { ...profile.capabilities.protocol, reasoningAccounting } },
          limits: { ...profile.limits, outputTokens: 16384, ...(inputOnly ? { maxInputTokens: 26000 } : {}) } };
      };
      const retained = 'RETAINED_OUTPUT ' + 'x'.repeat(48000);
      const compilations = [];
      f.provider.compileRequest = async request => {
        const checkpoint = request.messages.some(item => item.content.includes(marker));
        const oldHistory = request.messages.some(item => item.content.startsWith('Old optional evidence:'));
        const hasRetained = request.messages.some(item => item.content.includes('RETAINED_OUTPUT'));
        // Exact provider counts isolate the next-turn output growth from heuristic text estimates.
        const input = (oldHistory ? (reasoningAccounting === 'separate' ? 13000 : 15000) : 1000) +
          (checkpoint ? 1000 : 0) + (hasRetained ? 12000 : 0);
        const { signal: _signal, ...body } = request;
        const compiled = await compileModelRequest({ request, body, profile: await f.provider.describeModel(),
          endpoint: 'fixture://retained-generation', providerInputTokens: input });
        compilations.push({ checkpoint, oldHistory, hasRetained, compiled });
        return compiled;
      };
      let ordinary = 0;
      let firstPressure;
      f.provider.complete = async request => {
        f.requests.push(request);
        if (request.messages.some(item => item.content.includes(marker))) {
          firstPressure ??= (await options.context.inspect()).capacity;
          return select();
        }
        assert.equal(request.maxOutputTokens, 16384, 'Core must preserve the explicit ordinary output reservation.');
        assert.ok(!request.messages.some(item => item.content.startsWith('Old optional evidence:')),
          'Risky ordinary generation must wait for the first renewal.');
        return ++ordinary === 1 ? { ...call('domain_write'), content: retained } : response('Continued after renewal.');
      };
      const options = { ...f.options(), maxOutputTokens: 16384, reasoning: { strategy: 'budget', maxTokens: 1024 } };
      const result = await new AgentRuntime(options).run({ runId: 'retained-generation', task: 'Continue work after the tool result.' }).result;
      assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
      assert.equal(result.terminal.modelOutput.message, 'Continued after renewal.');
      assert.equal(ordinary, 2);
      assert.equal(f.effects(), 1);
      assert.ok(f.requests[0].messages.some(item => item.content.includes(marker)));
      assert.ok(f.recoveryRequests().length >= 1);
      const oldCandidate = compilations.find(item => item.oldHistory && !item.checkpoint).compiled.accounting;
      const checkpoint = compilations.find(item => item.oldHistory && item.checkpoint).compiled.accounting;
      assert.equal(oldCandidate.outputReservation, 16384);
      assert.equal(checkpoint.outputReservation, 8192);
      assert.equal(oldCandidate.reasoningReservation, 1024);
      assert.equal(firstPressure.continuityHeadroomTokens,
        (inputOnly ? 17384 : 9192) + (reasoningAccounting === 'separate' ? 1024 : 0),
        'Independent input limits cannot borrow released output capacity; included reasoning is not double counted.');
      assert.equal(oldCandidate.pricingSemantics.reasoningIncludedInOutput, reasoningAccounting === 'included_output');
      assert.ok(compilations.some(item => item.hasRetained), 'The complete ordinary generation participates in successor accounting.');
      const replay = await f.sessions.loadReplayState(f.descriptor);
      assert.ok(replay.branch.some(item => item.type === 'assistant' && item.content === retained),
        'Renewal cannot rewrite the original assistant output.');
      const restarted = await new AgentRuntime(options).resume('retained-generation').result;
      assert.equal(restarted.terminal?.executionStatus, 'completed');
      assert.equal(ordinary, 2, 'Restart cannot repeat already completed work.');
      assert.equal(f.effects(), 1);
    });
  }
}


for (const mode of ['ordinary', 'restart', 'restart without automatic renewal']) {
  const interruptPublication = mode !== 'ordinary';
  const disableAutomaticOnResume = mode === 'restart without automatic renewal';
  const batchSize = disableAutomaticOnResume ? 1 : 10;
  const capacity = disableAutomaticOnResume ? 4000 : 15000;
  test(`an oversized ordinary tool batch stages bounded presentations with exact durable originals (${mode})`, async () => {
    class PublicationEvents extends InMemoryEventRepository {
      stopped = false;
      interrupted = false;
      async appendConditional(runId, event, options) {
        if (this.stopped) throw new Error('simulated stop during staged presentation publication');
        const receipt = await super.appendConditional(runId, event, options);
        if (interruptPublication && !this.interrupted && event.type === 'observation.record.created' &&
            event.toolName === 'domain_write') {
          this.interrupted = this.stopped = true;
          throw new Error('simulated stop during staged presentation publication');
        }
        return receipt;
      }
    }
    const events = new PublicationEvents(agentEventCodec);
    const callIndexes = Array.from({ length: batchSize }, (_, index) => index + 1);
    const originals = callIndexes.map(index => `BATCH_ORIGINAL_${index}: ` + '日本語🦉'.repeat(800));
    const f = await fixture({ sourceBytes: 64, sourceBound: 1000000, targetCapacity: capacity, events,
      toolOutput: index => originals[index - 1] });
    f.requests.length = 0;
    const compilations = [];
    f.provider.compileRequest = async request => {
      const checkpoint = request.messages.some(item => item.content.includes(marker));
      const resultBytes = request.messages.filter(item => item.role === 'tool')
        .reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
      const { signal: _signal, ...body } = request;
      const compiled = await compileModelRequest({ request, body, profile: await f.provider.describeModel(),
        endpoint: 'fixture://staged-tool-batch', providerInputTokens: 1000 + Math.ceil(resultBytes / 4) + (checkpoint ? 1000 : 0) });
      compilations.push({ checkpoint, resultBytes, compiled });
      return compiled;
    };
    let ordinary = 0;
    f.provider.complete = async request => {
      f.requests.push(request);
      if (request.messages.some(item => item.content.includes(marker))) return select();
      if (++ordinary === 1) return { ...call('domain_write'), toolCalls: callIndexes.map(index => ({
        id: `batch-call-${index}`, type: 'function', name: 'domain_write', input: { kind: 'json', value: {} }
      })) };
      return response('All exact originals processed.');
    };
    const options = f.options();
    const handle = new AgentRuntime(options).run({ runId: 'staged-batch', task: 'Process the complete sources.' });
    let result;
    let publishedBeforeRestart = [];
    if (interruptPublication) {
      await assert.rejects(handle.result, /simulated stop|unresolved started provider effect/);
      assert.equal(events.stopped, true);
      publishedBeforeRestart = (await records(f, 'staged-batch')).filter(event =>
        event.type === 'observation.record.created' && event.toolName === 'domain_write');
      assert.equal(publishedBeforeRestart.length, 1);
      events.stopped = false;
      result = await new AgentRuntime({ ...f.options(),
        ...(disableAutomaticOnResume ? { contextRenewal: { automatic: false } } : {})
      }).resume('staged-batch').result;
    } else result = await handle.result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(f.effects(), batchSize, 'Settled effects must never repeat to repair presentation publication.');
    const log = await records(f, 'staged-batch');
    const ends = log.filter(event => event.type === 'tool.ended' && event.toolName === 'domain_write');
    assert.equal(ends.length, batchSize);
    for (let index = 0; index < batchSize; index++) {
      const original = await resolveToolObservation(ends[index].observation, f.artifacts);
      assert.equal(original.output, originals[index]);
      assert.equal(original.scope.coverage, 'complete');
    }
    const presentations = log.filter(event => event.type === 'observation.record.created' && event.toolName === 'domain_write');
    assert.equal(presentations.length, batchSize);
    if (interruptPublication) assert.deepEqual(presentations[0], publishedBeforeRestart[0]);
    const replay = await f.sessions.loadReplayState(f.descriptor);
    const replayed = replay.branch.filter(item => item.type === 'observation' && item.toolName === 'domain_write');
    assert.equal(replayed.length, batchSize);
    for (const record of presentations) {
      const content = await resolveToolModelContent(record, f.artifacts);
      const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      assert.match(text, /Presentation coverage: partial/);
      assert.match(text, /Original result coverage: complete/);
      const entry = replayed.find(item => item.callId === record.callId);
      assert.ok(entry);
      assert.deepEqual(await resolveToolModelContent(entry, f.artifacts), content,
        'Session replay uses the exact immutable selected event presentation.');
      const deliveries = f.requests.flatMap(request => request.messages.filter(item =>
        item.role === 'tool' && item.toolCallId === record.callId));
      assert.ok(deliveries.length > 0);
      assert.ok(deliveries.every(item => item.content === serializeToolModelContent(content)),
        'Every dispatched successor uses the published selection, even when automatic renewal is disabled on resume.');
      const full = content.find(part => part.type === 'artifact');
      assert.ok(full, 'Full selected presentation remains retrievable.');
      assert.ok(JSON.parse(new TextDecoder().decode(await f.artifacts.readVerified(full.artifact))).length > 0);
    }
    assert.ok(compilations.some(item => item.checkpoint && 2000 + Math.ceil(item.resultBytes / 4) + 512 > capacity),
      'Admission checks the combined batch before publishing bounded views.');
    assert.ok(f.requests.every(request => request.messages.filter(item => item.role === 'tool')
      .reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) < (capacity - 1512) * 4));
    const delivered = f.requests.flatMap(request => request.messages.filter(item => item.role === 'tool'));
    assert.ok(delivered.length >= batchSize, 'A fitting checkpoint or ordinary successor receives every tool outcome.');
    const before = f.requests.length;
    assert.equal((await new AgentRuntime(f.options()).resume('staged-batch').result).terminal?.executionStatus, 'completed');
    assert.equal(f.requests.length, before);
    assert.equal(f.effects(), batchSize);
  });
}

for (const blocker of ['presentation storage', 'minimum protocol metadata']) {
  test(`an unpresentable settled batch suspends without losing or repeating effects: ${blocker}`, async () => {
    const original = 'EXACT_UNPRESENTABLE_SOURCE ' + 'x'.repeat(12000);
    const f = await fixture({ sourceBytes: 64, sourceBound: 1000000, targetCapacity: 15000,
      toolOutput: () => original });
    f.requests.length = 0;
    const store = f.artifacts.store.bind(f.artifacts);
    let blockedStores = 0;
    if (blocker === 'presentation storage') f.artifacts.store = async request => {
      // Initial per-result preservation succeeds; fail only preservation of an
      // already bounded presentation when the complete batch needs a smaller view.
      if (request.label === 'domain_write-full-model-content' &&
          new TextDecoder().decode(request.content).includes('Presentation coverage: partial')) {
        blockedStores++;
        throw new Error('Presentation preservation unavailable.');
      }
      return store(request);
    };
    f.provider.compileRequest = async request => {
      const checkpoint = request.messages.some(item => item.content.includes(marker));
      const results = request.messages.filter(item => item.role === 'tool');
      const bytes = results.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
      const { signal: _signal, ...body } = request;
      return compileModelRequest({ request, body, profile: await f.provider.describeModel(),
        endpoint: 'fixture://unpresentable-tool-batch',
        providerInputTokens: 1000 + Math.ceil(bytes / 4) + (checkpoint ? 1000 : 0) +
          (blocker === 'minimum protocol metadata' && results.length ? 14000 : 0) });
    };
    f.provider.complete = async request => {
      f.requests.push(request);
      assert.equal(f.requests.length, 1, 'No oversized successor may dispatch.');
      return { ...call('domain_write'), toolCalls: Array.from({ length: 10 }, (_, index) => ({
        id: `blocked-call-${index}`, type: 'function', name: 'domain_write', input: { kind: 'json', value: {} }
      })) };
    };
    const first = await new AgentRuntime(f.options()).run({ runId: 'unpresentable-batch', task: 'Process ten originals.' }).result;
    assert.equal(first.state, 'suspended', JSON.stringify(first));
    assert.equal(first.reason, 'context_admission');
    assert.equal(first.contextAdmission.recovery, 'request_unavailable');
    assert.equal(f.effects(), 10);
    if (blocker === 'presentation storage') assert.ok(blockedStores > 0);
    const log = await records(f, 'unpresentable-batch');
    const settled = log.filter(event => event.type === 'tool.ended' && event.toolName === 'domain_write');
    assert.equal(settled.length, 10);
    for (const event of settled) assert.equal((await resolveToolObservation(event.observation, f.artifacts)).output, original);
    assert.equal(log.filter(event => event.type === 'observation.record.created' && event.toolName === 'domain_write').length, 0,
      'An unadmitted batch must not publish shortened presentations.');
    const resumed = await new AgentRuntime(f.options()).resume('unpresentable-batch').result;
    assert.equal(resumed.state, 'suspended', JSON.stringify(resumed));
    assert.equal(resumed.reason, 'context_admission');
    assert.equal(f.effects(), 10);
    assert.equal(f.requests.length, 1);
  });
}
