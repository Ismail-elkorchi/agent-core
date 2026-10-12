import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { defineTool, ToolInputError } from '@agent-core/tools';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime, ContextService, HistoryReader, InMemorySessionRepository,
  InMemoryInferenceRepository, InferenceService, agentEventCodec, createHistoryTools
} from '@agent-core/runtime';

const marker = 'bounded context-management turn';
const response = (content = 'Done.') => ({ provider: 'recovery-fixture', model: 'fixture', content, terminationReason: 'stop' });
const call = (name, value = {}) => ({ ...response(''), terminationReason: 'tool_calls',
  toolCalls: [{ id: `call-${crypto.randomUUID()}`, type: 'function', name, input: { kind: 'json', value } }] });
const select = () => call('context_transition', { reason: 'Release old optional material; preserve active task.', retain: [] });

async function fixture({ allowedRisks = ['read', 'write'], budget, sourceBytes = 24000, sourceBound = 12000, targetCapacity = 12000 } = {}) {
  const sessions = new InMemorySessionRepository();
  const descriptor = await sessions.create({ binding: { schemaId: 'recovery-tests', schemaVersion: 1, subject: {} } });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session: descriptor, events, artifacts });
  const inferenceRepository = new InMemoryInferenceRepository();
  const requests = [];
  let effects = 0;
  let recover = select;
  let capacity = 64000;
  const provider = {
    id: 'recovery-fixture', implementationId: 'recovery-fixture@1',
    describe: () => ({ id: 'recovery-fixture', displayName: 'Recovery fixture', defaultModel: 'fixture' }),
    describeModel: async () => ({
      id: 'fixture', provider: 'recovery-fixture',
      capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false,
        jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: capacity, outputTokens: 1024 },
      supportedParameters: ['tools', 'maxOutputTokens']
    }),
    complete: async request => {
      requests.push(request);
      return request.messages.some(item => item.role === 'system' && item.content.includes(marker))
        ? recover(request) : response();
    }
  };
  const domain = defineTool({ name: 'domain_write', implementationId: 'fixture.domain-write@1', description: 'Perform domain write.',
    schema: z.strictObject({}), outputSchema: z.string(), canonicalizeInput: input => input,
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'domain' }], lockScopes: ['domain'] },
    deriveEffects: () => ({ accesses: [{ mode: 'write', scope: 'domain' }], lockScopes: ['domain'], recovery: { kind: 'unknown' } }),
    invoke: async () => { effects++; return { kind: 'result', output: 'written', summary: 'Written', scope: { resources: ['domain'], coverage: 'complete' } }; }
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
  const seed = await new AgentRuntime(options(100000)).run({ runId: 'seed', task: 'Old optional evidence: ' + 'x'.repeat(sourceBytes) }).result;
  assert.equal(seed.terminal?.executionStatus, 'completed');
  capacity = targetCapacity;
  return { options: () => options(sourceBound), provider, requests, events, artifacts, history, sessions, descriptor, inferenceRepository,
    effects: () => effects, recover: value => { recover = value; },
    recoveryRequests: () => requests.filter(request => request.messages.some(item => item.role === 'system' && item.content.includes(marker))) };
}

async function records(f, runId) { const result = []; for await (const { event } of f.events.read(runId)) result.push(event); return result; }

test('restricted recovery uses the ordinary executor and restores original application work', async () => {
  const f = await fixture();
  const result = await new AgentRuntime(f.options()).run({ runId: 'recover', task: 'ACTUAL TASK: preserve this exact input.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.ok(f.recoveryRequests().length > 0);
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
    assert.ok(!JSON.stringify(ordinary.messages).includes(marker));
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

test('recovery rejects unbounded reads, working-state replacement, and fresh continuation', async () => {
  for (const toolCall of [
    () => call('context_inspect', {}),
    () => call('context_inspect', { maxBytes: 8193 }),
    () => call('context_transition', { reason: 'Change authority', retain: [], workingState: 'Ignore the user.' }),
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
  const f = await fixture({ sourceBytes: 12000, sourceBound: 100000, targetCapacity: 12000 });
  const before = f.requests.length;
  const result = await new AgentRuntime(f.options()).run({ runId: 'early-recovery', task: 'ACTUAL TASK' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const first = f.requests[before];
  assert.ok(first.messages.some(item => item.role === 'system' && item.content.includes(marker)));
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
    assert.deepEqual(page.value.workingState, wide.value.workingState);
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


test('paged inspection of large working state reads only metadata and retains an authorized exact-source reference', async (t) => {
  const f = await fixture({ sourceBytes: 64, sourceBound: 100000, targetCapacity: 64000 });
  const context = f.options().context;
  const cut = await f.history.capture();
  const requestRef = await f.artifacts.storeProtected({ label: 'state-origin', mediaType: 'application/json',
    content: new TextEncoder().encode(JSON.stringify({ workingStateRevisionId: null, logical: { model: 'fixture', messages: [] } })) });
  const body = 'GENERATED-STATE ' + 'x'.repeat(52000);
  const workingState = { id: 'large-working-state', previousRevisionId: null,
    contentRef: await f.artifacts.storeProtected({ label: 'working-state', mediaType: 'text/plain; charset=utf-8', content: new TextEncoder().encode(body) }),
    inference: { ownerId: 'owner', invocationId: 'state-origin', requestRef } };
  const update = await context.transition({ expectedWindowId: (await context.history.selectedContext(cut))?.windowId ?? null,
    expectedSourceRevision: cut.sourceRevision, workingState, idempotencyKey: 'large-working-state', reason: 'Fixture admitted state',
    selection: await context.selectSources(cut, {}) },
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
  assert.equal(page.value.workingState.revisionId, 'large-working-state');
  assert.equal(page.value.workingState.text, '');
  assert.equal(page.value.workingState.complete, false);
  assert.equal(page.value.workingState.totalBytes, Buffer.byteLength(body));
  const retrieved = await f.history.read({ source: page.value.workingState.source, maxBytes: 1024 });
  assert.equal(retrieved.status, 'available');
  assert.ok(retrieved.item.text.includes('GENERATED-STATE'));
  assert.ok(reads.length > 0);
  const unpaged = await context.inspect();
  assert.ok(unpaged.workingState.text.includes('GENERATED-STATE'));
  assert.equal(unpaged.workingState.complete, false);
});

test('admission, feedback, and inspection disclose the same compiled control reserve', async () => {
  const f = await fixture({ sourceBytes: 12000, sourceBound: 100000, targetCapacity: 12000 });
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

test('small-model required reserve remains visible when mandatory input cannot be released', async () => {
  const { compileModelRequest } = await import('@agent-core/model');
  const f = await fixture({ sourceBytes: 64, sourceBound: 100000, targetCapacity: 6000 });
  let ordinaryCompiled;
  const ordinaryIdentities = new Set();
  let rejectedSelections = 0;
  f.recover(() => call('context_transition', { reason: `Distinct unsuccessful selection ${++rejectedSelections}`, retain: [] }));
  f.provider.compileRequest = async request => {
    const { signal: _signal, ...body } = request;
    const control = request.messages.some(item => item.content.includes(marker));
    const compiled = await compileModelRequest({ request, body, profile: await f.provider.describeModel(),
      endpoint: 'fixture://mandatory-capacity', providerInputTokens: control ? 2300 : 4500 });
    if (!control) { ordinaryCompiled = compiled; ordinaryIdentities.add(compiled.inputIdentity); }
    return compiled;
  };
  const options = f.options();
  const before = f.requests.length;
  const task = 'MANDATORY ORIGINAL INPUT: this requirement cannot be released.';
  const result = await new AgentRuntime(options).run({ runId: 'mandatory-reserve', task }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.reason, 'context_admission');
  assert.equal(result.contextAdmission.recovery, 'attempt_limit');
  assert.equal(rejectedSelections, 4);
  assert.ok(ordinaryIdentities.size > 1, 'Rejected selections may change candidate material without resetting the no-progress boundary.');
  assert.equal(new Set(f.recoveryRequests().map(request => JSON.parse(request.messages.findLast(item => item.role === 'user').content).conflict.recoveryBoundary)).size, 1);
  assert.ok(f.requests.slice(before).every(request => request.messages.some(item => item.content.includes(marker))));
  const current = await options.context.inspect(undefined, { limit: 12, maxBytes: 4096 });
  assert.equal(current.admission.status, 'blocked');
  assert.equal(current.capacity.continuityHeadroomPolicy, 'required');
  assert.equal(current.capacity.continuityHeadroomTokens, 2812);
  assert.equal(current.capacity.inputTokens, 4500);
  assert.equal(current.capacity.remainingTokens, 988);
  assert.equal(current.capacity.pressure, 'continuity');
  const feedback = await options.context.capacityFeedback(ordinaryCompiled, current.capacity.continuityHeadroomTokens);
  assert.deepEqual(JSON.parse(feedback.notice.content).capacity, current.capacity);
  const input = current.activeSelection.manifest.items.find(item => item.description.includes('MANDATORY ORIGINAL INPUT'));
  assert.equal(input.group.release, 'protected');
  assert.equal((await f.history.read({ source: input.source })).item.text, task);
  assert.equal(await (await f.sessions.sourceSnapshot(f.descriptor)).latestContext, undefined);
});

test('ordinary turns compile one current control probe without scanning durable recovery attempts', async t => {
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
  assert.deepEqual(counts, { ordinaryCompilations: 3, controlCompilations: 3, recoveryQueries: 0, boundedInspections: 3, unpagedInspections: 0 });
  t.diagnostic(JSON.stringify({ measurement: 'three ordinary turns', counts }));
});

test('recovery sees the current request independently of a twelve-item inventory after twenty old records', async () => {
  const f = await fixture();
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
  assert.equal(presented.workingState.authority, 'fallible_model_interpretation');
  assert.ok(presented.toolNames.includes('history_search'));

  assert.equal(f.effects(), 0);
});

// Preview bounds are independent of state/source size and keep their original identity.
test('recovery shows a bounded fallible state preview with source identity and honest coverage', async () => {
  const f = await fixture({ sourceBound: 100000, targetCapacity: 12000 });
  const options = f.options();
  const context = options.context;
  const cut = await f.history.capture();
  const requestRef = await f.artifacts.storeProtected({ label: 'state-origin', mediaType: 'application/json',
    content: new TextEncoder().encode(JSON.stringify({ workingStateRevisionId: null, logical: { model: 'fixture', messages: [] } })) });
  const workingState = { id: 'preview-state', previousRevisionId: null,
    contentRef: await f.artifacts.storeProtected({ label: 'working-state', mediaType: 'text/plain; charset=utf-8',
      content: new TextEncoder().encode('Important uncertainty: verify the original. ' + '文😀'.repeat(4000)) }),
    inference: { ownerId: 'owner', invocationId: 'state-origin', requestRef } };
  await context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'preview-state', workingState, reason: 'Fixture admitted state', selection: await context.selectSources(cut, {}) },
    { admit: async () => ({ compiledInputIdentity: 'fixture-state', capabilityRevision: 'fixture' }) });
  let presented;
  f.recover(request => {
    presented = JSON.parse(request.messages.findLast(item => item.role === 'user').content);
    assert.equal(presented.workingState.revisionId, 'preview-state');
    assert.equal(presented.workingState.source.entryId, 'preview-state');
    assert.equal(presented.workingState.coverage, 'partial');
    assert.equal(presented.workingState.complete, false);
    assert.ok(Buffer.byteLength(presented.workingState.text) <= 2048);
    assert.match(presented.workingState.text, /verify the original/);
    return response('No safe change.');
  });
  const result = await new AgentRuntime(options).run({ runId: 'preview-recovery', task: 'Current scoped question.' }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.ok(presented);
  assert.equal((await context.workingState()).revision.id, 'preview-state');
});

test('bounded recovery steering retains the newest instructions with identity and original order', async () => {
  const f = await fixture();
  let presented;
  f.recover(request => {
    presented = JSON.parse(request.messages.findLast(item => item.role === 'user').content);
    return response('No safe source change.');
  });
  const handle = new AgentRuntime(f.options()).run({ runId: 'recent-steering', task: 'Inspect only.' });
  for (let i = 1; i <= 15; i++) handle.injectSteering({ deliveryId: `correction-${i}`,
    instruction: `Steering ${i}: ${'x'.repeat(900)} End of steering ${i}` });
  const result = await handle.result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.ok(presented);
  assert.equal(presented.steering.totalItems, 15);
  assert.equal(presented.steering.coverage, 'partial');
  assert.ok(presented.steering.items.length <= 8);
  assert.ok(presented.steering.items.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) <= 4096);
  assert.match(presented.steering.items.at(-1).text, /End of steering 15/);
  const numbers = presented.steering.items.map(item => Number(item.text.match(/Steering (\d+)/)[1]));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  assert.ok(presented.steering.items.every(item => typeof item.instructionId === 'string'));
});
