import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistenceCorruptionError } from '@agent-core/evidence';
import { InMemorySessionRepository, decodeAgentTerminalSnapshot } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

test('session repository initializes a missing nested root before acquiring its stream lock', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-session-missing-root-'));
  const rootDir = path.join(parent, 'missing', 'nested');
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'created', workspaceRoot: process.cwd() });
  assert.equal((await repository.open(session.id)).id, 'created');
});

test('concurrent session appends preserve one parent chain and leaf', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-concurrent-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'concurrent', workspaceRoot: process.cwd() });
  await Promise.all(Array.from({ length: 30 }, (_, index) => repository.appendInput(session.id, { runId: `run-${index}`, task: `task ${index}` })));
  const replay = await repository.loadReplayState(session.id);
  assert.equal(replay.branch.length, 30);
  assert.equal(replay.branch[0].parentId, null);
  for (let index = 1; index < replay.branch.length; index += 1) assert.equal(replay.branch[index].parentId, replay.branch[index - 1].id);
  assert.equal((await repository.open(session.id)).leafId, replay.branch.at(-1).id);
});

test('session repositories scan once and incrementally preserve a cross-instance branch', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-index-'));
  const first = new JsonlSessionRepository({ rootDir });
  const second = new JsonlSessionRepository({ rootDir });
  const session = await first.create({ id: 'indexed', workspaceRoot: process.cwd() });
  await second.open(session.id);
  // Force each warm index to ingest one record from the other writer before the
  // concurrent burst. Lock scheduling may otherwise let one repository finish
  // its whole local queue first, which is correct but exercises only one
  // incremental refresh path.
  await first.appendInput(session.id, { runId: 'run-0', task: 'task-0' });
  await second.appendInput(session.id, { runId: 'run-1', task: 'task-1' });
  await first.appendInput(session.id, { runId: 'run-2', task: 'task-2' });
  await Promise.all(Array.from({ length: 21 }, (_, offset) => {
    const index = offset + 3;
    return (index % 2 === 0 ? first : second).appendInput(session.id, { runId: `run-${index}`, task: `task-${index}` });
  }));
  const replay = await first.loadReplayState(session.id);
  assert.equal(replay.branch.length, 24);
  for (let index = 1; index < replay.branch.length; index += 1) assert.equal(replay.branch[index].parentId, replay.branch[index - 1].id);
  assert.ok(first.indexMetrics().incrementalRefreshes > 0);
  assert.equal(second.indexMetrics().fullScans, 1);
  assert.ok(second.indexMetrics().incrementalRefreshes > 0);
});

test('session observations normalize hostile output and metadata before durable replay', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-hostile-json-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'hostile-json', workspaceRoot: process.cwd() });
  await repository.appendInput(session.id, { runId: 'run-hostile', task: 'persist hostile observation' });
  let getterCalls = 0;
  const output = Object.create(null);
  Object.defineProperty(output, 'getter', { enumerable: true, get() { getterCalls += 1; throw new Error('must not run'); } });
  Object.defineProperty(output, '__proto__', { enumerable: true, value: { retained: true } });
  output.cycle = output;
  const metadata = new Proxy({}, { ownKeys() { throw new Error('ownKeys denied'); } });
  await repository.appendObservation(session.id, {
    runId: 'run-hostile',
    identity: { turnIndex: 1, turnId: 'turn-hostile', requestAttempt: 1 },
    toolName: 'hostile_tool',
    observation: { ok: true, summary: 'bounded', output, metadata }
  });

  const replay = await new JsonlSessionRepository({ rootDir }).loadReplayState(session.id);
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
    const session = await repository.create({ id: `owned-${String(index)}`, workspaceRoot: process.cwd(), model: 'original' });
    const instruction = { id: 'instruction', content: 'original', provenance: 'run' };
    const input = await repository.appendInput(session.id, { runId: 'run', task: 'original', instructions: [instruction] });
    instruction.content = 'mutated';

    assert.equal(input.instructions[0].content, 'original');
    assert.equal(Object.isFrozen(session), true);
    assert.equal(Object.isFrozen(session.header), true);
    assert.equal(Object.isFrozen(input), true);
    assert.equal(Object.isFrozen(input.instructions), true);
    assert.equal(Object.isFrozen(input.instructions[0]), true);
    assert.throws(() => { input.instructions[0].content = 'changed'; }, TypeError);

    const replay = await repository.loadReplayState(session.id);
    assert.equal(Object.isFrozen(replay), true);
    assert.equal(Object.isFrozen(replay.branch), true);
    assert.equal(Object.isFrozen(replay.terminalProjections), true);
    assert.equal(Object.isFrozen(replay.ledgerRunIds), true);
    assert.throws(() => { replay.branch.pop(); }, TypeError);
    assert.equal((await repository.loadReplayState(session.id)).branch[0].instructions[0].content, 'original');
  }
});

test('session final projections are idempotent and validate the complete terminal union', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-final-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'final', workspaceRoot: process.cwd() });
  await repository.appendInput(session.id, { runId: 'run', task: 'finish the run' });
  const terminal = decodeAgentTerminalSnapshot({
    runId: 'run', finalizationId: 'fin', phase: 'ended', executionStatus: 'completed', verificationStatus: 'not_required', terminationReason: 'model_completed', modelTerminationReason: 'stop',
    candidate: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }, turnCount: 1, checkResults: [],
    budget: { modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0, providerRetries: 0 }
  });
  const first = await repository.projectFinal(session.id, terminal);
  const second = await repository.projectFinal(session.id, terminal);
  assert.equal(first.id, second.id);
  const replay = await repository.loadReplayState(session.id);
  assert.equal(replay.terminalProjections.length, 1);
  assert.equal(replay.contextProjection?.recentTurns.at(-1)?.task, 'finish the run');

  const file = repository.location(session.id);
  await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify({ type: 'final', id: 'bad', timestamp: new Date().toISOString(), runId: 'bad', finalizationId: 'bad', terminal: { ...terminal, runId: 'bad', finalizationId: 'bad', candidate: { status: 'absent' } } })}\n`, 'utf8');
  await assert.rejects(repository.open(session.id), error => error instanceof PersistenceCorruptionError && error.code === 'invalid_record');
});

test('session replay remains compact after hundreds of completed turns', async () => {
  const repository = new InMemorySessionRepository();
  const session = await repository.create({ id: 'long-session', workspaceRoot: process.cwd() });
  for (let index = 0; index < 300; index += 1) {
    const runId = `run-${String(index)}`;
    await repository.appendInput(session.id, { runId, task: `${'任務'.repeat(600)} ${String(index)}` });
    await repository.projectFinal(session.id, completedTerminal(runId, `final-${String(index)}`, `${'結果'.repeat(900)} ${String(index)}`));
  }

  const replay = await repository.loadReplayState(session.id);
  assert.equal(replay.branch.length, 300, 'the durable branch retains every input');
  assert.equal(replay.terminalProjections.length, 1, 'replay exposes only terminal state relevant after the checkpoint');
  assert.deepEqual(replay.ledgerRunIds, ['run-299']);
  assert.equal(replay.contextProjection?.recentTurns.length, 8);
  assert.equal(Buffer.byteLength(JSON.stringify(replay.contextProjection), 'utf8') < 64 * 1024, true);
  assert.equal(Buffer.byteLength(replay.contextProjection?.recentTurns.at(-1)?.task ?? '', 'utf8') <= 800, true);
  assert.equal(Buffer.byteLength(replay.contextProjection?.recentTurns.at(-1)?.result ?? '', 'utf8') <= 1_200, true);
});

test('session JSONL tolerates a torn tail and identifies middle corruption', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-torn-'));
  const repository = new JsonlSessionRepository({ rootDir });
  const session = await repository.create({ id: 'torn', workspaceRoot: process.cwd() });
  await repository.appendInput(session.id, { runId: 'run', task: 'task' });
  const file = repository.location(session.id);
  await writeFile(file, `${await readFile(file, 'utf8')}{"type":`, 'utf8');
  assert.equal((await repository.loadReplayState(session.id)).branch.length, 1);
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.splice(1, 0, '{bad');
  await writeFile(file, lines.join('\n'), 'utf8');
  await assert.rejects(repository.open(session.id), error => error instanceof PersistenceCorruptionError && error.line === 2 && error.byteOffset > 0);
});

test('session JSONL indexes only newline-committed records and repairs arbitrarily large torn tails', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-session-committed-prefix-'));
  let repository = new JsonlSessionRepository({ rootDir });
  let session = await repository.create({ id: 'valid-tail', workspaceRoot: process.cwd() });
  await repository.appendInput(session.id, { runId: 'one', task: 'one' });
  await repository.appendInput(session.id, { runId: 'uncommitted', task: 'uncommitted' });
  const validFile = repository.location(session.id);
  const validBytes = await readFile(validFile);
  await writeFile(validFile, validBytes.subarray(0, validBytes.length - 1));

  repository = new JsonlSessionRepository({ rootDir });
  await repository.appendInput(session.id, { runId: 'replacement', task: 'replacement' });
  let replay = await new JsonlSessionRepository({ rootDir }).loadReplayState(session.id);
  assert.deepEqual(replay.branch.map(entry => entry.runId), ['one', 'replacement']);
  assert.equal(replay.branch[1].parentId, replay.branch[0].id);

  repository = new JsonlSessionRepository({ rootDir });
  session = await repository.create({ id: 'large-tail', workspaceRoot: process.cwd() });
  await repository.appendInput(session.id, { runId: 'one', task: 'one' });
  await appendFile(repository.location(session.id), 'x'.repeat(70 * 1024));
  await new JsonlSessionRepository({ rootDir }).appendInput(session.id, { runId: 'two', task: 'two' });
  replay = await new JsonlSessionRepository({ rootDir }).loadReplayState(session.id);
  assert.deepEqual(replay.branch.map(entry => entry.runId), ['one', 'two']);
  assert.equal(replay.branch[1].parentId, replay.branch[0].id);
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
      consecutiveToolFailures: 0,
      providerRetries: 0
    }
  };
}
test('session listing orders sessions by latest committed activity', async () => {
  const repository = new InMemorySessionRepository();
  const first = await repository.create({ id: 'first', workspaceRoot: '/workspace' });
  await new Promise(resolve => setTimeout(resolve, 2));
  await repository.create({ id: 'second', workspaceRoot: '/workspace' });
  await new Promise(resolve => setTimeout(resolve, 2));
  await repository.appendInput(first.id, { runId: 'run', task: 'recent activity' });
  const sessions = await repository.list('/workspace');
  assert.equal(sessions[0].id, first.id);
  assert.ok(sessions[0].updatedAt >= sessions[0].timestamp);
});
