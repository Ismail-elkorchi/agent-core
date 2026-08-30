import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashJson, InMemoryEventRepository, PersistenceCorruptionError } from '@agent-core/evidence';
import { closeExternalEffect, issueEffectStartTicket, settleExternalEffect, startExternalEffect } from '@agent-core/effects';
import {
  AgentOperationCoordinator,
  AgentSession,
  InMemorySessionRepository,
  SessionBindingMismatchError,
  agentEventCodec,
  createSessionBinding,
  decodeAgentTerminalSnapshot
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { createToolCall } from '@agent-core/tools';

const TEST_SESSION_BINDING = Object.freeze({
  schemaId: 'agent-core.tests/session',
  schemaVersion: 1,
  subject: Object.freeze({ application: 'agent-core-tests' })
});

test('session bindings are canonical, required, and do not disclose their subject on mismatch', async () => {
  const left = createSessionBinding({
    schemaId: 'agent-core.tests/writer', schemaVersion: 3,
    subject: { workspace: '/private/work', document: 'draft', options: { language: 'en', audience: 'expert' } }
  });
  const reordered = createSessionBinding({
    schemaId: 'agent-core.tests/writer', schemaVersion: 3,
    subject: { options: { audience: 'expert', language: 'en' }, document: 'draft', workspace: '/private/work' }
  });
  assert.equal(left.bindingSha256, reordered.bindingSha256);
  assert.equal(Object.isFrozen(left), true);

  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'bound', binding: left });
  const wrong = { schemaId: left.schemaId, schemaVersion: left.schemaVersion, subject: { workspace: '/private/other', secret: 'must-not-leak' } };
  await assert.rejects(repository.open(descriptor.id, wrong), (error) => {
    assert.equal(error instanceof SessionBindingMismatchError, true);
    assert.doesNotMatch(error.message, /must-not-leak|private\/other/u);
    return true;
  });
  await assert.rejects(repository.loadReplayState({ ...descriptor, header: { ...descriptor.header, binding: createSessionBinding(wrong) } }), SessionBindingMismatchError);
  await assert.rejects(repository.loadReplayState({
    ...descriptor,
    header: { ...descriptor.header, binding: { ...descriptor.header.binding, bindingSha256: '0'.repeat(64) } }
  }), /binding hash is invalid/u);
});

test('child sessions inherit the application binding exactly', async () => {
  const repository = new InMemorySessionRepository();
  const parent = await repository.create({ id: 'bound-parent', binding: TEST_SESSION_BINDING });
  const child = await repository.create({ id: 'bound-child', binding: TEST_SESSION_BINDING, parent });
  assert.equal(child.header.parentSessionId, parent.id);
  await assert.rejects(repository.create({
    id: 'wrong-child', parent,
    binding: { schemaId: TEST_SESSION_BINDING.schemaId, schemaVersion: 2, subject: TEST_SESSION_BINDING.subject }
  }), SessionBindingMismatchError);
});

test('JSONL session headers reject missing or tampered bindings before replay', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-binding-corruption-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const descriptor = await repository.create({ id: 'binding-corruption', binding: TEST_SESSION_BINDING });
  await assert.rejects(repository.open(descriptor.id, {
    schemaId: TEST_SESSION_BINDING.schemaId,
    schemaVersion: TEST_SESSION_BINDING.schemaVersion,
    subject: { application: 'another-agent' }
  }), SessionBindingMismatchError);
  const file = repository.location(descriptor.id);
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  const header = JSON.parse(lines[0]);
  header.binding.subject = { application: 'tampered' };
  lines[0] = JSON.stringify(header);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  await assert.rejects(
    new JsonlSessionRepository({ rootDir }).open(descriptor.id, TEST_SESSION_BINDING),
    (error) => error instanceof PersistenceCorruptionError && error.line === 1
  );

  const missing = await repository.create({ id: 'binding-missing', binding: TEST_SESSION_BINDING });
  const missingFile = repository.location(missing.id);
  const missingHeader = JSON.parse((await readFile(missingFile, 'utf8')).trim());
  delete missingHeader.binding;
  await writeFile(missingFile, `${JSON.stringify(missingHeader)}\n`, 'utf8');
  await assert.rejects(
    new JsonlSessionRepository({ rootDir }).open(missing.id, TEST_SESSION_BINDING),
    (error) => error instanceof PersistenceCorruptionError && error.line === 1
  );
});

test('session repository initializes a missing nested root before acquiring its stream lock', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-session-missing-root-'));
  const rootDir = path.join(parent, 'missing', 'nested');
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'created', binding: TEST_SESSION_BINDING });
  assert.equal((await repository.open(session.id, TEST_SESSION_BINDING)).id, 'created');
});

test('concurrent session appends preserve one parent chain and leaf', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-concurrent-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'concurrent', binding: TEST_SESSION_BINDING });
  await Promise.all(Array.from({ length: 30 }, (_, index) => repository.appendInput(session, { runId: `run-${index}`, task: `task ${index}` })));
  const replay = await repository.loadReplayState(session);
  assert.equal(replay.branch.length, 30);
  assert.equal(replay.branch[0].parentId, null);
  for (let index = 1; index < replay.branch.length; index += 1) assert.equal(replay.branch[index].parentId, replay.branch[index - 1].id);
  assert.equal((await repository.open(session.id, TEST_SESSION_BINDING)).leafId, replay.branch.at(-1).id);
});

test('session repositories scan once and incrementally preserve a cross-instance branch', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-index-'));
  const first = new JsonlSessionRepository({ rootDir });
  const second = new JsonlSessionRepository({ rootDir });
  const session = await first.create({ id: 'indexed', binding: TEST_SESSION_BINDING });
  const secondDescriptor = await second.open(session.id, TEST_SESSION_BINDING);
  // Force each warm index to ingest one record from the other writer before the
  // concurrent burst. Lock scheduling may otherwise let one repository finish
  // its whole local queue first, which is correct but exercises only one
  // incremental refresh path.
  await first.appendInput(session, { runId: 'run-0', task: 'task-0' });
  await second.appendInput(secondDescriptor, { runId: 'run-1', task: 'task-1' });
  await first.appendInput(session, { runId: 'run-2', task: 'task-2' });
  await Promise.all(Array.from({ length: 21 }, (_, offset) => {
    const index = offset + 3;
    return (index % 2 === 0 ? first : second).appendInput(index % 2 === 0 ? session : secondDescriptor, { runId: `run-${index}`, task: `task-${index}` });
  }));
  const replay = await first.loadReplayState(session);
  assert.equal(replay.branch.length, 24);
  for (let index = 1; index < replay.branch.length; index += 1) assert.equal(replay.branch[index].parentId, replay.branch[index - 1].id);
  assert.ok(first.indexMetrics().incrementalRefreshes > 0);
  assert.equal(second.indexMetrics().fullScans, 1);
  assert.ok(second.indexMetrics().incrementalRefreshes > 0);
});

test('session observations normalize hostile output and metadata before durable replay', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-hostile-json-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'hostile-json', binding: TEST_SESSION_BINDING });
  await repository.appendInput(session, { runId: 'run-hostile', task: 'persist hostile observation' });
  let getterCalls = 0;
  const output = Object.create(null);
  Object.defineProperty(output, 'getter', { enumerable: true, get() { getterCalls += 1; throw new Error('must not run'); } });
  Object.defineProperty(output, '__proto__', { enumerable: true, value: { retained: true } });
  output.cycle = output;
  const metadata = new Proxy({}, { ownKeys() { throw new Error('ownKeys denied'); } });
  await repository.appendObservation(session, {
    runId: 'run-hostile',
    identity: { turnIndex: 1, turnId: 'turn-hostile', requestAttempt: 1 },
    toolName: 'hostile_tool',
    observation: { ok: true, summary: 'bounded', output, metadata }
  });

  const replay = await new JsonlSessionRepository({ rootDir }).loadReplayState(session);
  const observation = replay.branch.find((entry) => entry.type === 'observation');
  assert.equal(getterCalls, 0);
  assert.equal(observation.output.getter, '[accessor omitted]');
  assert.equal(observation.output.__proto__.retained, true);
  assert.match(observation.output.cycle, /circular/u);
  assert.deepEqual(observation.metadata, { value: '[value inspection failed]' });
});

test('session repositories retain and expose only owned session state', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-owned-'));
  const repositories = [new InMemorySessionRepository(), new JsonlSessionRepository({ rootDir })];
  for (const [index, repository] of repositories.entries()) {
    const session = await repository.create({ id: `owned-${String(index)}`, model: 'original', binding: TEST_SESSION_BINDING });
    const instruction = { id: 'instruction', content: 'original', provenance: 'run' };
    const input = await repository.appendInput(session, { runId: 'run', task: 'original', instructions: [instruction] });
    instruction.content = 'mutated';

    assert.equal(input.instructions[0].content, 'original');
    assert.equal(Object.isFrozen(session), true);
    assert.equal(Object.isFrozen(session.header), true);
    assert.equal(Object.isFrozen(input), true);
    assert.equal(Object.isFrozen(input.instructions), true);
    assert.equal(Object.isFrozen(input.instructions[0]), true);
    assert.throws(() => { input.instructions[0].content = 'changed'; }, TypeError);

    const replay = await repository.loadReplayState(session);
    assert.equal(Object.isFrozen(replay), true);
    assert.equal(Object.isFrozen(replay.branch), true);
    assert.equal(Object.isFrozen(replay.terminalProjections), true);
    assert.equal(Object.isFrozen(replay.ledgerRunIds), true);
    assert.throws(() => { replay.branch.pop(); }, TypeError);
    assert.equal((await repository.loadReplayState(session)).branch[0].instructions[0].content, 'original');
  }
});

test('session final projections are idempotent and validate the complete terminal union', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-final-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'final', binding: TEST_SESSION_BINDING });
  await repository.appendInput(session, { runId: 'run', task: 'finish the run' });
  const terminal = decodeAgentTerminalSnapshot({
    runId: 'run', finalizationId: 'fin', phase: 'ended', executionStatus: 'completed', verificationStatus: 'not_required', terminationReason: 'model_completed', modelTerminationReason: 'stop',
    candidate: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }, turnCount: 1, checkResults: [],
    budget: { modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, candidateRevisions: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0 }
  });
  const first = await repository.projectFinal(session, terminal);
  const second = await repository.projectFinal(session, terminal);
  assert.equal(first.id, second.id);
  const replay = await repository.loadReplayState(session);
  assert.equal(replay.terminalProjections.length, 1);
  assert.equal(first.throughEntryId, replay.branch[0].id);

  const file = repository.location(session.id);
  await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify({ type: 'final', id: 'bad', timestamp: new Date().toISOString(), runId: 'bad', finalizationId: 'bad', terminal: { ...terminal, runId: 'bad', finalizationId: 'bad', candidate: { status: 'absent' } } })}\n`, 'utf8');
  await assert.rejects(repository.open(session.id, TEST_SESSION_BINDING), error => error instanceof PersistenceCorruptionError && error.code === 'invalid_record');
});

test('session replay derives bounded continuity without persisted context records', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ id: 'long-session', binding: TEST_SESSION_BINDING });
  for (let index = 0; index < 300; index += 1) {
    const runId = `run-${String(index)}`;
    await repository.appendInput(session, { runId, task: `${'任務'.repeat(600)} ${String(index)}` });
    await repository.projectFinal(session, completedTerminal(runId, `final-${String(index)}`, `${'結果'.repeat(900)} ${String(index)}`));
  }

  const replay = await repository.loadReplayState(session);
  assert.equal(replay.branch.length, 300, 'the durable branch retains every input');
  assert.equal(replay.terminalProjections.length, 300, 'final projections remain authoritative inputs to derived continuity');
  assert.deepEqual(replay.ledgerRunIds, ['run-299']);
});

test('session JSONL tolerates a torn tail and identifies middle corruption', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-torn-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'torn', binding: TEST_SESSION_BINDING });
  await repository.appendInput(session, { runId: 'run', task: 'task' });
  const file = repository.location(session.id);
  await writeFile(file, `${await readFile(file, 'utf8')}{"type":`, 'utf8');
  assert.equal((await repository.loadReplayState(session)).branch.length, 1);
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.splice(1, 0, '{bad');
  await writeFile(file, lines.join('\n'), 'utf8');
  await assert.rejects(repository.open(session.id, TEST_SESSION_BINDING), error => error instanceof PersistenceCorruptionError && error.line === 2 && error.byteOffset > 0);
});

test('session JSONL indexes only newline-committed records and repairs arbitrarily large torn tails', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-committed-prefix-'));
  let repository = new JsonlSessionRepository({ rootDir });
  let session = await repository.create({ id: 'valid-tail', binding: TEST_SESSION_BINDING });
  await repository.appendInput(session, { runId: 'one', task: 'one' });
  await repository.appendInput(session, { runId: 'uncommitted', task: 'uncommitted' });
  const validFile = repository.location(session.id);
  const validBytes = await readFile(validFile);
  await writeFile(validFile, validBytes.subarray(0, validBytes.length - 1));

  repository = new JsonlSessionRepository({ rootDir });
  session = await repository.open(session.id, TEST_SESSION_BINDING);
  await repository.appendInput(session, { runId: 'replacement', task: 'replacement' });
  let replay = await new JsonlSessionRepository({ rootDir }).loadReplayState(session);
  assert.deepEqual(replay.branch.map(entry => entry.runId), ['one', 'replacement']);
  assert.equal(replay.branch[1].parentId, replay.branch[0].id);

  repository = new JsonlSessionRepository({ rootDir });
  session = await repository.create({ id: 'large-tail', binding: TEST_SESSION_BINDING });
  await repository.appendInput(session, { runId: 'one', task: 'one' });
  await appendFile(repository.location(session.id), 'x'.repeat(70 * 1024));
  const replacementRepository = new JsonlSessionRepository({ rootDir });
  const replacementDescriptor = await replacementRepository.open(session.id, TEST_SESSION_BINDING);
  await replacementRepository.appendInput(replacementDescriptor, { runId: 'two', task: 'two' });
  replay = await new JsonlSessionRepository({ rootDir }).loadReplayState(replacementDescriptor);
  assert.deepEqual(replay.branch.map(entry => entry.runId), ['one', 'two']);
  assert.equal(replay.branch[1].parentId, replay.branch[0].id);
});

test('session JSONL owns queued configuration and validates submission lifecycle recovery', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-submissions-'));
  let repository = new JsonlSessionRepository({ rootDir });
  let session = await repository.create({ id: 'submissions', binding: TEST_SESSION_BINDING });
  await repository.enqueueSubmission(session, {
    submissionId: 'submission', runId: 'run', input: { task: 'persisted task' },
    configuration: { provider: 'test', model: 'captured-model', reasoning: { strategy: 'effort', effort: 'high' }, responseFormat: { type: 'json_schema', schema: { type: 'object' } } }
  });
  repository = new JsonlSessionRepository({ rootDir });
  session = await repository.open(session.id, TEST_SESSION_BINDING);
  let pending = await repository.loadPendingSubmissions(session);
  assert.equal(pending[0].configuration.model, 'captured-model');
  assert.equal(Object.isFrozen(pending[0].configuration.responseFormat.schema), true);
  await repository.transitionSubmission(session, 'submission', { state: 'claimed' });
  const suspension = { runId: 'run', submissionId: 'submission', category: 'implementation', reason: 'missing_implementation', actions: ['resume', 'abort'] };
  await repository.transitionSubmission(session, 'submission', { state: 'suspended', suspension });
  pending = await new JsonlSessionRepository({ rootDir }).loadPendingSubmissions(session);
  assert.equal(pending[0].state, 'suspended');

  await appendFile(repository.location(session.id), `${JSON.stringify({ type: 'submission.completed', submissionId: 'submission', runId: 'run', timestamp: new Date().toISOString() })}\n`);
  await assert.rejects(new JsonlSessionRepository({ rootDir }).open(session.id, TEST_SESSION_BINDING), error => error instanceof PersistenceCorruptionError && error.code === 'invalid_record');
});

function completedTerminal(runId, finalizationId, message) {
  return {
    runId,
    finalizationId,
    phase: 'ended',
    executionStatus: 'completed',
    verificationStatus: 'not_required',
    terminationReason: 'model_completed',
    modelTerminationReason: 'stop',
    candidate: { status: 'complete', message, source: 'content', turnIndex: 1 },
    turnCount: 1,
    checkResults: [],
    budget: {
      modelTurns: 1,
      totalToolCalls: 0,
      repeatedIdenticalToolCalls: 0,
      candidateRevisions: 0,
      elapsedMs: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      knownCosts: {},
      pricingStatus: 'unknown',
      unknownPricedTokens: 0,
      consecutiveProviderFailures: 0,
      consecutiveToolFailures: 0
    }
  };
}

function testBudget() { return completedTerminal('run', 'final', 'result').budget; }

function operationCoordinator() {
  return new AgentOperationCoordinator(new InMemoryEventRepository(agentEventCodec));
}

async function acceptTestOperation(operations, runId) {
  return operations.accept({
    runId,
    finalizationId: `${runId}:final`,
    input: { task: 'claimed', instructions: [], contextItems: [] },
    configuration: { providerId: 'test', providerImplementationId: 'agent-core.tests.session-provider@1', model: 'model', runtimeImplementationId: 'test/runtime@1', toolImplementationIds: [], checks: [], disposition: { implementationId: 'agent-core.tests.accept-disposition@1', policyIdentity: { strategy: 'accept' }, policyHash: hashJson({ strategy: 'accept' }) }, policyHash: 'policy' }
  });
}

async function acceptApprovalOperation(operations, runId) {
  await acceptTestOperation(operations, runId);
  const driver = await operations.attach(runId, 'session-test-driver');
  const identity = { turnIndex: 1, turnId: 'turn', requestAttempt: 1 };
  const advance = async (procedure, phase) => {
    const result = await driver.drive(({ instruction }) => {
      assert.equal(instruction.procedure, procedure);
      return { phase, budget: testBudget() };
    });
    assert.equal(result.kind, 'advanced');
  };
  await advance('prepare', { kind: 'preparing', step: 'assemble_turn', turnIndex: 1 });
  await advance('assemble_turn', { kind: 'provider', stage: 'ready', identity, toolBatchId: 'batch' });
  const issued = issueEffectStartTicket({ intent: { effectId: 'provider-effect', operationId: runId, implementationId: 'agent-core.tests.session-provider@1', parametersDigest: '0'.repeat(64), recovery: { kind: 'unknown' }, exposure: { quantities: [] } }, ticketId: 'provider-ticket', settlementPermitId: 'provider-permit', driverGeneration: driver.state().driverGeneration, currentDriverGeneration: driver.state().driverGeneration });
  assert.equal(issued.status, 'issued');
  await advance('prepare_provider_request', { kind: 'provider', stage: 'effect_ready', identity, toolBatchId: 'batch', requestEventId: 'request', responseId: 'response', effect: issued.state });
  const started = startExternalEffect(issued.state, issued.state.ticket, driver.state().driverGeneration);
  assert.equal(started.status, 'started');
  await advance('start_provider_request', { kind: 'provider', stage: 'effect_pending', identity, toolBatchId: 'batch', requestEventId: 'request', responseId: 'response', effect: started.state });
  const settled = settleExternalEffect(started.state, started.state.settlementPermit, { outcome: 'succeeded', resultDigest: '1'.repeat(64), exposure: { status: 'known', quantities: [] } });
  assert.equal(settled.status, 'settled');
  await advance('reconcile_provider_request', { kind: 'provider', stage: 'settled', identity, toolBatchId: 'batch', requestEventId: 'request', responseId: 'response', settlementEventId: 'response-event', effect: settled.state });
  const call = createToolCall({ id: 'call', name: 'write', input: { kind: 'json', value: {} } });
  const effects = { accesses: [{ mode: 'write', scope: 'workspace/file' }], lockScopes: ['workspace/file'], recovery: { kind: 'unknown' } };
  const binding = { toolImplementationId: 'test/write@1', authorizationPolicyId: 'test-policy', executionTargetId: 'test-target' };
  const preparation = { toolImplementationId: binding.toolImplementationId, canonicalInput: {}, fingerprint: '2'.repeat(64), effects, binding, authorization: 'require_approval', authorizationReason: 'confirm' };
  const approval = { runId, ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call', approvalId: 'approval', status: 'pending', toolName: 'write', fingerprint: preparation.fingerprint, input: {}, effects, binding, policyHash: '3'.repeat(64), reason: 'confirm' };
  const batch = { identity, toolBatchId: 'batch', calls: [call], callStates: [{ stage: 'ready' }], maxConcurrency: 1, nextProjectionIndex: 0, instructions: [], modelInputModalities: ['text'] };
  await advance('consume_provider_settlement', { kind: 'tools', ...batch });
  await advance('prepare_tool_call', { kind: 'approval', ...batch, approvalCallIndex: 0, preparation, approval });
}

async function acceptExternalRecoveryOperation(operations, runId) {
  await acceptTestOperation(operations, runId);
  const driver = await operations.attach(runId, 'external-recovery-driver');
  const identity = { turnIndex: 1, turnId: 'turn', requestAttempt: 1 };
  const advance = async (procedure, phase) => {
    const result = await driver.drive(({ instruction }) => {
      assert.equal(instruction.procedure, procedure);
      return { phase, budget: testBudget() };
    });
    assert.equal(result.kind, 'advanced');
  };
  await advance('prepare', { kind: 'preparing', step: 'assemble_turn', turnIndex: 1 });
  await advance('assemble_turn', { kind: 'provider', stage: 'ready', identity, toolBatchId: 'batch' });
  const issued = issueEffectStartTicket({
    intent: { effectId: 'provider-effect', operationId: runId, implementationId: 'agent-core.tests.session-provider@1', parametersDigest: '0'.repeat(64), recovery: { kind: 'unknown' }, exposure: { quantities: [] } },
    ticketId: 'provider-ticket', settlementPermitId: 'provider-permit',
    driverGeneration: driver.state().driverGeneration, currentDriverGeneration: driver.state().driverGeneration
  });
  assert.equal(issued.status, 'issued');
  const provider = { kind: 'provider', identity, toolBatchId: 'batch', requestEventId: 'request', responseId: 'response' };
  await advance('prepare_provider_request', { ...provider, stage: 'effect_ready', effect: issued.state });
  const started = startExternalEffect(issued.state, issued.state.ticket, driver.state().driverGeneration);
  assert.equal(started.status, 'started');
  await advance('start_provider_request', { ...provider, stage: 'effect_pending', effect: started.state });
  await advance('reconcile_provider_request', { ...provider, stage: 'outcome_unknown', effect: closeExternalEffect(started.state, 'unknown_outcome') });
}

async function acceptUserDecisionOperation(operations, runId) {
  await acceptTestOperation(operations, runId);
  const driver = await operations.attach(runId, 'user-decision-driver');
  const identity = { turnIndex: 1, turnId: 'turn', requestAttempt: 1 };
  const advance = async (procedure, phase) => {
    const result = await driver.drive(({ instruction }) => {
      assert.equal(instruction.procedure, procedure);
      return { phase, budget: testBudget() };
    });
    assert.equal(result.kind, 'advanced');
  };
  await advance('prepare', { kind: 'preparing', step: 'assemble_turn', turnIndex: 1 });
  await advance('assemble_turn', { kind: 'provider', stage: 'ready', identity, toolBatchId: 'batch' });
  const issued = issueEffectStartTicket({
    intent: { effectId: 'provider-effect', operationId: runId, implementationId: 'agent-core.tests.session-provider@1', parametersDigest: '0'.repeat(64), recovery: { kind: 'unknown' }, exposure: { quantities: [] } },
    ticketId: 'provider-ticket', settlementPermitId: 'provider-permit',
    driverGeneration: driver.state().driverGeneration, currentDriverGeneration: driver.state().driverGeneration
  });
  assert.equal(issued.status, 'issued');
  const blockedProvider = { kind: 'provider', identity, toolBatchId: 'batch', requestEventId: 'request', responseId: 'response' };
  await advance('prepare_provider_request', { ...blockedProvider, stage: 'effect_ready', effect: issued.state });
  const effect = closeExternalEffect(issued.state, 'cancelled_before_start');
  const operationRevision = driver.state().revision + 1;
  const id = `${runId}:decision:${effect.intent.effectId}`;
  const reason = 'The provider start was cancelled before execution; abort is the only safe continuation.';
  const choices = ['abort'];
  const fingerprint = hashJson({ id, reason, choices, operationRevision, effectId: effect.intent.effectId });
  const decisionRequest = { id, reason, choices, fingerprint, operationRevision };
  await advance('start_provider_request', {
    kind: 'suspended', reason: 'user_decision', effectId: effect.intent.effectId, decisionRequest,
    continuation: { kind: 'cancelled_provider_start', blockedProvider: { ...blockedProvider, effect } }
  });
  return Object.freeze({ ...decisionRequest, choices: Object.freeze(choices) });
}

test('AgentSession rejects a mismatched binding before restoration or runtime construction', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'session-binding-boundary', binding: TEST_SESSION_BINDING });
  let runtimeCreations = 0;
  assert.throws(() => new AgentSession({
    descriptor,
    expectedBinding: { ...TEST_SESSION_BINDING, subject: { application: 'another-agent' } },
    repository,
    operations: operationCoordinator(),
    configuration: { provider: 'test', model: 'model' },
    createRuntime() { runtimeCreations += 1; throw new Error('must not execute'); }
  }), SessionBindingMismatchError);
  assert.equal(runtimeCreations, 0);
});

test('AgentSession serializes admission, preserves steering identity, and snapshots configuration at submission', async () => {
  const configurations = [];
  const runtimeContexts = [];
  const controls = [];
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'session-authority', binding: TEST_SESSION_BINDING });
  const session = new AgentSession({
    descriptor,
    expectedBinding: TEST_SESSION_BINDING,
    repository,
    operations: operationCoordinator(),
    configuration: { provider: 'test', model: 'first' },
    createRuntime(configuration, _onProgress, context) {
      configurations.push(configuration);
      runtimeContexts.push(context);
      if (configuration.model === 'broken') throw new Error('unsupported model');
      return {
        run(input) {
          let resolve;
          const steering = [];
          const result = new Promise((done) => { resolve = done; });
          const control = { runId: input.runId, steering, resolve, result, injectSteering(value) { steering.push(value.instruction); return { id: 'steer', runId: input.runId, timestamp: new Date().toISOString() }; }, abort() {} };
          controls.push(control);
          return control;
        }
      };
    }
  });
  const first = await session.submit({ task: 'first' });
  assert.equal(first.kind, 'started');
  const stale = await session.submit({ task: 'stale' }, { delivery: 'steer', expectedRunId: 'wrong' });
  assert.deepEqual(stale, { kind: 'rejected', reason: 'run_mismatch' });
  const steered = await session.submit({ task: 'focus' }, { delivery: 'steer', expectedRunId: first.runId });
  assert.equal(steered.kind, 'steered');
  assert.deepEqual(controls[0].steering, ['focus']);
  await session.configure({ model: 'second' });
  const second = await session.submit({ task: 'second' });
  assert.equal(second.kind, 'queued');
  controls[0].resolve({ state: 'ended', terminal: { runId: first.runId }, deliveryDiagnostics: [] });
  await first.completion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(configurations[0].model, 'first');
  assert.equal(configurations[1].model, 'second');
  assert.equal(runtimeContexts[0].runId, first.runId);
  assert.equal(runtimeContexts[0].submissionId, first.submissionId);
  assert.equal(runtimeContexts[0].input.task, 'first');
  assert.equal(runtimeContexts[0].resuming, false);
  controls[1].resolve({ state: 'ended', terminal: { runId: controls[1].runId }, deliveryDiagnostics: [] });
  await second.completion;
  assert.equal(session.state().phase, 'idle');

  const third = await session.submit({ task: 'third' });
  await session.configure({ model: 'broken' });
  const fourth = await session.submit({ task: 'fourth' });
  controls[2].resolve({ state: 'ended', terminal: { runId: controls[2].runId }, deliveryDiagnostics: [] });
  await third.completion;
  await assert.rejects(fourth.completion, /unsupported model/u);
  assert.equal(session.state().phase, 'idle');
});

test('session branches require stable boundaries and conversation projects assistant turns once', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ id: 'stable-branch', binding: TEST_SESSION_BINDING });
  const input = await repository.appendInput(session, { runId: 'run', task: 'work' });
  await assert.rejects(repository.branchFrom(session, input.id), /completed final or compaction/u);
  await repository.appendAssistant(session, {
    runId: 'run', identity: { turnIndex: 1, turnId: 'turn', requestAttempt: 1 }, content: 'answer'
  });
  await repository.appendSteering(session, { runId: 'run', content: 'preserve this accepted correction' });
  await assert.rejects(repository.appendAssistant(session, {
    runId: 'run', identity: { turnIndex: 1, turnId: 'turn', requestAttempt: 1 }, content: 'conflicting answer'
  }), /Conflicting assistant projection/u);
  await repository.appendAssistant(session, {
    runId: 'run', identity: { turnIndex: 1, turnId: 'turn', requestAttempt: 1 }, content: 'answer'
  });
  await repository.projectFinal(session, completedTerminal('run', 'final', 'answer'));
  const points = await repository.listBranchPoints(session);
  assert.equal(points.length, 1);
  await repository.branchFrom(session, points[0].entryId);
  const conversation = await repository.readConversation(session);
  assert.equal(conversation.filter((entry) => entry.type === 'assistant').length, 1);
  assert.equal(conversation.filter((entry) => entry.type === 'steering').length, 1);
});

test('AgentSession restores claimed and queued work without starting execution during restore', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'durable-admission', binding: TEST_SESSION_BINDING });
  const blocked = new AgentSession({
    descriptor, expectedBinding: TEST_SESSION_BINDING, repository, operations: operationCoordinator(), configuration: { provider: 'test', model: 'model' },
    createRuntime() {
      return { run(input) { return { runId: input.runId, result: new Promise(() => {}), injectSteering() { throw new Error('unused'); }, abort() {} }; } };
    }
  });
  const claimed = await blocked.submit({ task: 'claimed' });
  const queued = await blocked.submit({ task: 'recover me' });
  assert.equal(queued.kind, 'queued');

  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  await acceptTestOperation(operations, claimed.runId);

  const executed = [];
  const failures = [];
  const recovered = new AgentSession({
    descriptor, expectedBinding: TEST_SESSION_BINDING, repository, operations, configuration: { provider: 'test', model: 'different-model' },
    createRuntime(configuration, _onProgress, context) {
      const execute = (input) => {
        executed.push({ task: input.task, model: configuration.model, resuming: context.resuming });
        return { runId: input.runId, result: Promise.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }), injectSteering() { throw new Error('unused'); }, abort() {} };
      };
      return { run: execute, resume(runId) { return execute({ runId, task: 'claimed' }); } };
    }
  });
  recovered.subscribe((event) => { if (event.type === 'run.failed') failures.push(event.error.message); });
  await recovered.restore();
  assert.deepEqual(executed, []);
  await recovered.waitForIdle();
  assert.deepEqual(executed, [{ task: 'claimed', model: 'model', resuming: true }, { task: 'recover me', model: 'model', resuming: false }]);
  assert.equal(failures.length, 0);
  assert.deepEqual(await repository.loadPendingSubmissions(descriptor), []);
});

test('semantic compaction is persisted once and becomes the replay base', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'semantic-compaction', binding: TEST_SESSION_BINDING });
  await repository.appendInput(descriptor, { runId: 'run', task: 'retain this decision' });
  await repository.appendAssistant(descriptor, { runId: 'run', identity: { turnIndex: 1, turnId: 'turn', requestAttempt: 1 }, content: 'decision retained' });
  await repository.projectFinal(descriptor, completedTerminal('run', 'final', 'decision retained'));
  let calls = 0;
  const agent = new AgentSession({
    descriptor, expectedBinding: TEST_SESSION_BINDING, repository, operations: operationCoordinator(), configuration: { provider: 'test', model: 'summary-model' },
    createRuntime() { throw new Error('runtime is not needed for compaction'); },
    async summarizeConversation(request) {
      calls += 1;
      assert.equal(request.conversation.some((entry) => entry.type === 'assistant'), true);
      return 'Persisted semantic decision.';
    }
  });
  const compacted = await agent.compact();
  assert.equal(Object.isFrozen(compacted), true);
  const replay = await repository.loadReplayState(descriptor);
  assert.equal(replay.compaction?.summary, 'Persisted semantic decision.');
  assert.deepEqual(replay.ledgerRunIds, []);
  assert.equal(calls, 1);
  await assert.rejects(agent.compact(), /requires new completed conversation history/u);
  assert.equal(calls, 1);
});

test('approval suspension remains durable and blocks queued follow-ups until resolution', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'durable-suspension', binding: TEST_SESSION_BINDING });
  const approvalEvents = new InMemoryEventRepository(agentEventCodec);
  const approvalOperations = new AgentOperationCoordinator(approvalEvents);
  let resolveFirst;
  const firstProcess = new AgentSession({
    descriptor, expectedBinding: TEST_SESSION_BINDING, repository, operations: approvalOperations, configuration: { provider: 'test', model: 'model' },
    createRuntime() { return { run(input) {
      return { runId: input.runId, result: new Promise((resolve) => { resolveFirst = resolve; }), injectSteering() { throw new Error('unused'); }, abort() {} };
    } }; }
  });
  const first = await firstProcess.submit({ task: 'needs approval' });
  const followUp = await firstProcess.submit({ task: 'after approval' });
  assert.equal(followUp.kind, 'queued');
  await acceptApprovalOperation(approvalOperations, first.runId);
  resolveFirst({ state: 'suspended', reason: 'approval_required', runId: first.runId, finalizationId: 'final', pendingApprovals: [], budget: testBudget() });
  await first.completion;
  assert.equal(firstProcess.state().phase, 'suspended');
  const rejected = await firstProcess.submit({ task: 'must not enter the durable queue' });
  assert.equal(rejected.kind, 'rejected');
  assert.equal(rejected.reason, 'session_suspended');
  assert.equal((await repository.loadPendingSubmissions(descriptor)).length, 2);

  const executed = [];
  const restarted = new AgentSession({
    descriptor, expectedBinding: TEST_SESSION_BINDING, repository, operations: approvalOperations, configuration: { provider: 'test', model: 'model' },
    createRuntime() { return {
      run(input) {
        executed.push(input.task);
        return { runId: input.runId, result: Promise.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }), injectSteering() { throw new Error('unused'); }, abort() {} };
      },
      resolveApproval(input) {
        return Promise.resolve({ runId: input.runId, result: Promise.resolve({ state: 'ended', terminal: { runId: input.runId }, deliveryDiagnostics: [] }), injectSteering() { throw new Error('unused'); }, abort() {} });
      }
    }; }
  });
  await restarted.restore();
  assert.equal(restarted.state().phase, 'suspended');
  assert.deepEqual(executed, []);
  await restarted.resolveApproval({ runId: first.runId, approvalId: 'approval', fingerprint: 'fingerprint', decision: 'allow' });
  await restarted.waitForIdle();
  assert.deepEqual(executed, ['after approval']);
});

test('external recovery suspension remains explicit and unresolved reconciliation cannot replay work', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'external-suspension', binding: TEST_SESSION_BINDING });
  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  let settleInitial;
  let resumes = 0;
  const session = new AgentSession({
    descriptor, expectedBinding: TEST_SESSION_BINDING, repository, operations,
    configuration: { provider: 'test', model: 'model' },
    createRuntime() {
      return {
        run(input) {
          return { runId: input.runId, result: new Promise((resolve) => { settleInitial = resolve; }), injectSteering() { throw new Error('unused'); }, abort() {} };
        },
        resume(runId) {
          resumes += 1;
          const result = operations.inspect(runId).then((operation) => operation.state.control.status === 'abort_requested'
            ? { state: 'ended', terminal: { runId }, deliveryDiagnostics: [] }
            : { state: 'suspended', reason: 'provider_outcome_unknown', runId, finalizationId: `${runId}:final`, effectId: 'provider-effect', budget: testBudget() });
          return { runId, result, injectSteering() { throw new Error('unused'); }, abort() {} };
        }
      };
    }
  });
  const submission = await session.submit({ task: 'external effect' });
  await acceptExternalRecoveryOperation(operations, submission.runId);
  settleInitial({ state: 'suspended', reason: 'provider_outcome_unknown', runId: submission.runId, finalizationId: `${submission.runId}:final`, effectId: 'provider-effect', budget: testBudget() });
  await submission.completion;
  assert.deepEqual(session.inspectSuspension(), {
    runId: submission.runId, submissionId: submission.submissionId, category: 'external_recovery', reason: 'provider_outcome_unknown', effectId: 'provider-effect', actions: ['reconcile', 'abort']
  });
  await assert.rejects(session.resumeImplementation(submission.runId), /does not permit/u);
  const unresolved = await session.reconcileExternal(submission.runId);
  assert.equal(unresolved.state, 'suspended');
  assert.equal(session.state().phase, 'suspended');
  assert.equal(resumes, 1);
  assert.equal(await session.abort('stop unresolved external work', submission.runId), true);
  await session.waitForIdle();
  assert.equal(resumes, 2);
  assert.equal(session.state().phase, 'idle');
});

test('missing implementation suspension resumes only through its category-specific operation', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'implementation-suspension', binding: TEST_SESSION_BINDING });
  const operations = operationCoordinator();
  let settleInitial;
  let resumes = 0;
  const session = new AgentSession({
    descriptor, expectedBinding: TEST_SESSION_BINDING, repository, operations,
    configuration: { provider: 'test', model: 'model' },
    createRuntime() {
      return {
        run(input) {
          return { runId: input.runId, result: new Promise((resolve) => { settleInitial = resolve; }), injectSteering() { throw new Error('unused'); }, abort() {} };
        },
        resume(runId) {
          resumes += 1;
          return { runId, result: Promise.resolve({ state: 'ended', terminal: { runId }, deliveryDiagnostics: [] }), injectSteering() { throw new Error('unused'); }, abort() {} };
        }
      };
    }
  });
  const submission = await session.submit({ task: 'requires unavailable implementation' });
  await acceptTestOperation(operations, submission.runId);
  settleInitial({ state: 'suspended', reason: 'missing_implementation', runId: submission.runId, finalizationId: `${submission.runId}:final`, budget: testBudget() });
  await submission.completion;
  assert.equal(session.inspectSuspension().category, 'implementation');
  assert.deepEqual(session.inspectSuspension().actions, ['resume', 'abort']);
  await assert.rejects(session.reconcileExternal(submission.runId), /does not permit/u);
  const result = await session.resumeImplementation(submission.runId);
  assert.equal(result.state, 'ended');
  assert.equal(resumes, 1);
  assert.equal(session.state().phase, 'idle');
});

test('durable user decisions enforce every identity and revision guard before abort continuation', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'decision-suspension', binding: TEST_SESSION_BINDING });
  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  const runId = 'decision-run';
  const request = await acceptUserDecisionOperation(operations, runId);
  await repository.enqueueSubmission(descriptor, {
    submissionId: 'decision-submission', runId, input: { task: 'requires a decision' }, configuration: { provider: 'test', model: 'model' }
  });
  await repository.transitionSubmission(descriptor, 'decision-submission', { state: 'claimed' });
  await repository.transitionSubmission(descriptor, 'decision-submission', {
    state: 'suspended',
    suspension: { runId, submissionId: 'decision-submission', category: 'user_decision', reason: 'user_decision', effectId: 'provider-effect', actions: ['decide', 'abort'], decisionRequest: request }
  });
  let resumes = 0;
  const session = new AgentSession({
    descriptor, expectedBinding: TEST_SESSION_BINDING, repository, operations,
    configuration: { provider: 'test', model: 'model' },
    createRuntime() {
      return {
        resume(resumedRunId) {
          resumes += 1;
          const result = operations.inspect(resumedRunId).then((operation) => {
            assert.equal(operation.state.control.status, 'abort_requested');
            return { state: 'ended', terminal: { runId: resumedRunId }, deliveryDiagnostics: [] };
          });
          return { runId: resumedRunId, result, injectSteering() { throw new Error('unused'); }, abort() {} };
        }
      };
    }
  });
  await session.restore();
  const suspension = session.inspectSuspension();
  assert.equal(suspension.category, 'user_decision');
  assert.deepEqual(suspension.actions, ['decide', 'abort']);
  const exact = { runId, decisionRequestId: request.id, choice: 'abort', fingerprint: request.fingerprint, expectedOperationRevision: request.operationRevision };
  await assert.rejects(session.resolveDecision({ ...exact, runId: 'stale-run' }), /suspended on run/u);
  await assert.rejects(session.resolveDecision({ ...exact, decisionRequestId: 'stale-decision' }), /stale/u);
  await assert.rejects(session.resolveDecision({ ...exact, fingerprint: '0'.repeat(64) }), /stale/u);
  await assert.rejects(session.resolveDecision({ ...exact, expectedOperationRevision: request.operationRevision - 1 }), /stale/u);
  await assert.rejects(session.resolveDecision({ ...exact, choice: 'retry' }), /not permitted/u);
  await operations.requestAbort(runId, request.reason);
  const result = await session.resolveDecision(exact);
  assert.equal(result.state, 'ended');
  assert.equal(resumes, 1);
  await assert.rejects(session.resolveDecision(exact), /not suspended/u);
  assert.equal(resumes, 1);
});

test('aborting a suspended submission commits cancellation before starting finalization', async () => {
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'abort-suspension', binding: TEST_SESSION_BINDING });
  const runId = 'suspended-run';
  await repository.enqueueSubmission(descriptor, {
    submissionId: 'submission',
    runId,
    input: { task: 'suspended task' },
    configuration: { provider: 'test', model: 'model' }
  });
  await repository.transitionSubmission(descriptor, 'submission', { state: 'claimed' });
  const events = new InMemoryEventRepository(agentEventCodec);
  const operations = new AgentOperationCoordinator(events);
  await acceptApprovalOperation(operations, runId);
  await repository.transitionSubmission(descriptor, 'submission', {
    state: 'suspended',
    suspension: { runId, submissionId: 'submission', category: 'approval', reason: 'approval_required', actions: ['approval', 'abort'] }
  });
  let resumed = false;
  const session = new AgentSession({
    descriptor,
    expectedBinding: TEST_SESSION_BINDING,
    repository,
    operations,
    configuration: { provider: 'test', model: 'model' },
    createRuntime() {
      return {
        resume(resumedRunId) {
          resumed = true;
          const result = operations.inspect(resumedRunId).then((inspection) => {
            assert.equal(inspection.state.control.status, 'abort_requested');
            return { state: 'ended', terminal: { runId: resumedRunId }, deliveryDiagnostics: [] };
          });
          return { runId: resumedRunId, result, injectSteering() { throw new Error('unused'); }, abort() { return Promise.resolve(); } };
        }
      };
    }
  });
  await session.restore();
  assert.equal(session.state().phase, 'suspended');
  assert.equal(await session.abort('cancel suspended work', runId), true);
  await session.waitForIdle();
  assert.equal(resumed, true);
  assert.equal(session.state().phase, 'idle');
});
test('session listing orders sessions by latest committed activity', async () => {
  const repository = new InMemorySessionRepository();
  const first = await repository.create({ id: 'first', binding: TEST_SESSION_BINDING });
  await new Promise(resolve => setTimeout(resolve, 2));
  await repository.create({ id: 'second', binding: TEST_SESSION_BINDING });
  await new Promise(resolve => setTimeout(resolve, 2));
  await repository.appendInput(first, { runId: 'run', task: 'recent activity' });
  const sessions = await repository.list();
  assert.equal(sessions[0].id, first.id);
  assert.ok(sessions[0].updatedAt >= sessions[0].timestamp);
});
