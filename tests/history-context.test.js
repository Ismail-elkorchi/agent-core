import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createProviderContextState } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { LocalArtifactRepository, JsonlEventRepository } from '@agent-core/persistence/node';
import {
  AgentSession,
  AgentRunCoordinator,
  ContextService,
  HistoryReader,
  InMemorySessionRepository,
  agentEventCodec,
  createHistoryTools,
  createContextTools,
  sourceRef
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'tests/history', schemaVersion: 1, subject: { app: 'neutral' } };
const identity = { turnId: 'turn', turnIndex: 1, requestAttempt: 1 };
function terminal(runId) {
  return {
    runId,
    finalizationId: `final-${runId}`,
    phase: 'ended',
    executionStatus: 'completed',
    terminationReason: 'model_completed',
    modelTerminationReason: 'stop',
    modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 },
    turnCount: 1,
    budget: {
      modelTurns: 1,
      totalToolCalls: 0,
      elapsedMs: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      knownCosts: {},
      pricingStatus: 'unknown',
      unknownPricedTokens: 0
    }
  };
}
async function backend(kind) {
  if (kind === 'memory')
    return {
      sessions: new InMemorySessionRepository(),
      artifacts: new InMemoryArtifactRepository(),
      events: new InMemoryEventRepository(agentEventCodec)
    };
  const root = await mkdtemp(path.join(tmpdir(), 'agent-history-'));
  const artifacts = new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') });
  return {
    root,
    sessions: new JsonlSessionRepository(path.join(root, 'sessions')),
    events: new JsonlEventRepository({
      rootDir: path.join(root, 'events'),
      codec: agentEventCodec
    }),
    artifacts
  };
}
for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: 1000 completed original inputs remain searchable with bounded pages and stable cuts`, async () => {
    const { sessions } = await backend(kind);
    const session = await sessions.create({ id: 'session', binding });
    let first;
    for (let i = 0; i < 1000; i++) {
      const entry = await sessions.appendInput(session, {
        runId: `run-${i}`,
        task: `${'x'.repeat(900)} original-${i} keep original Unicode: 改正`
      });
      if (i === 0) first = entry;
      await sessions.appendAssistant(session, {
        runId: `run-${i}`,
        identity: { ...identity, turnId: `turn-${i}` },
        content: `answer-${i}`
      });
      await sessions.recordRunFinalization(session, terminal(`run-${i}`));
    }
    const history = new HistoryReader({ repository: sessions, session });
    let page = await history.search({
      query: 'original-',
      maxScanned: 37,
      limit: 11,
      maxBytes: 8192
    });
    const cut = page.cut;
    const sources = [];
    while (true) {
      assert.ok(page.scanned <= 37);
      assert.ok(page.bytes <= 8192);
      assert.ok(page.items.length <= 11);
      sources.push(...page.items.map((item) => item.source));
      if (!page.cursor) break;
      page = await history.search({
        query: 'original-',
        cursor: page.cursor,
        maxScanned: 37,
        limit: 11,
        maxBytes: 8192
      });
    }
    assert.equal(sources.length, 1000);
    assert.equal(new Set(sources.map((item) => item.entryId)).size, 1000);
    await sessions.appendInput(session, {
      runId: 'later',
      task: 'original-later must stay after captured cut'
    });
    const old = await history.search({ query: 'original-later', cut });
    assert.equal(old.items.length, 0);
    const exact = await history.read({ source: sourceRef(session.id, first), maxBytes: 8192 });
    assert.equal(exact.status, 'available');
    assert.equal(exact.item.text, first.task);
    const wrong = await history.read({ source: { ...sources[0], sha256: '0'.repeat(64) } });
    assert.equal(wrong.status, 'unavailable');
    assert.equal(wrong.reason, 'identity_mismatch');
    if (kind === 'jsonl')
      assert.ok(
        sessions.indexMetrics().fullScans <= 1,
        'JSONL cache must not rescan the file per page'
      );
  });

  test(`${kind}: accepted input owns original context attachments and strict branch scope`, async () => {
    const { sessions } = await backend(kind);
    const session = await sessions.create({ id: 'session', binding });
    const input = {
      task: 'Original input',
      instructions: ['original instruction'],
      contextItems: [
        {
          sourceUri: 'test:attachment',
          sourceKind: 'external',
          representation: 'full',
          mediaType: 'text/plain',
          title: 'attachment',
          content: 'unmodified attachment',
          purpose: 'reference'
        }
      ]
    };
    await sessions.enqueueSubmission(session, {
      submissionId: 'submission',
      runId: 'run',
      input,
      configuration: { provider: 'test', model: 'test' }
    });
    input.task = 'mutated';
    input.contextItems[0].content = 'mutated';
    const first = await sessions.appendInput(session, {
      runId: 'run',
      task: 'runtime transformed task'
    });
    await sessions.recordRunFinalization(session, terminal('run'));
    assert.equal(first.originalInput.task, 'Original input');
    assert.equal(first.originalInput.contextItems[0].content, 'unmodified attachment');
    const secret = await sessions.appendInput(session, {
      runId: 'parent-later',
      task: 'sibling-only secret'
    });
    await sessions.recordRunFinalization(session, terminal('parent-later'));
    await sessions.branchFrom(session, first.id);
    const reader = new HistoryReader({ repository: sessions, session });
    assert.equal((await reader.search({ query: 'sibling-only' })).items.length, 0);
    assert.equal(
      (await reader.read({ source: sourceRef(session.id, secret) })).status,
      'unavailable'
    );
    assert.equal(
      (await reader.read({ source: { ...sourceRef(session.id, first), sessionId: 'other' } }))
        .reason,
      'outside_scope'
    );
  });
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: authoritative unfinished ledger output survives a missing mirror and captured heads exclude later output`, async () => {
    const { sessions, events } = await backend(kind);
    const session = await sessions.create({ id: 'ledger-session', binding });
    await sessions.appendInput(session, { runId: 'open-run', task: 'Original task' });
    const receipt = await events.append('open-run', {
      type: 'assistant.interrupted',
      ...identity,
      content: 'committed partial answer',
      modelOutput: {
        status: 'partial',
        message: 'committed partial answer',
        source: 'stream_recovery',
        turnIndex: 1
      },
      finalResponseReceived: false
    });
    const history = new HistoryReader({ repository: sessions, session, events });
    const cut = await history.capture();
    const view = await history.page({ cut });
    const answer = view.entries.find((entry) => entry.type === 'assistant');
    assert.equal(answer.content, 'committed partial answer');
    assert.equal(answer.completeness, 'partial');
    const source = sourceRef(session.id, answer);
    assert.equal(source.event.eventId, receipt.eventId);
    assert.equal(source.sha256, receipt.hash);
    await events.append('open-run', {
      type: 'assistant.ended',
      ...identity,
      content: 'later settled answer',
      modelOutput: {
        status: 'complete',
        message: 'later settled answer',
        source: 'content',
        turnIndex: 1
      }
    });
    assert.equal((await history.read({ source, cut })).item.text, 'committed partial answer');
    const latest = await history.page();
    assert.equal(latest.entries.filter((entry) => entry.type === 'assistant').length, 2);
    assert.equal(
      latest.entries.find(
        (entry) => entry.type === 'assistant' && entry.completeness === 'complete'
      ).content,
      'later settled answer'
    );
    await sessions.appendAssistant(session, {
      runId: 'open-run',
      identity,
      content: 'later settled answer'
    });
    assert.equal(
      (await history.page()).entries.filter((entry) => entry.type === 'assistant').length,
      2,
      'mirror cannot duplicate authoritative output'
    );
    assert.equal((await history.read({ source })).item.text, 'committed partial answer');
  });
}

test('context validation releases the session queue and accepted queued input makes its capture stale', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ id: 'responsive', binding });
  const first = await sessions.appendInput(session, { runId: 'first', task: 'first' });
  await sessions.recordRunFinalization(session, terminal('first'));
  let release;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const context = new ContextService({
    artifacts: new InMemoryArtifactRepository(),
    repository: sessions,
    session,
    policy: { maxSourceBytes: 8192 }
  });
  const agent = new AgentSession({
    descriptor: session,
    expectedBinding: binding,
    repository: sessions,
    context,
    runs: new AgentRunCoordinator(
      new InMemoryEventRepository(agentEventCodec),
      new InMemoryArtifactRepository()
    ),
    configuration: { provider: 'test', model: 'test' },
    createRuntime() {
      throw new Error('No runtime needed');
    }
  });
  const changing = context.transition(
    {
      expectedWindowId: null,
      idempotencyKey: 'pending',
      reason: 'capture',
      selection: { strategy: 'sources', retained: [sourceRef(session.id, first)] }
    },
    {
      admit: async () => {
        entered();
        await gate;
        return { compiledInputIdentity: 'captured-request', capabilityRevision: 'fixture' };
      }
    }
  );
  await ready;
  assert.equal(
    await agent.abort('No active run'),
    false,
    'abort uses the serial queue while validation awaits external work'
  );
  await sessions.enqueueSubmission(session, {
    submissionId: 'queued',
    runId: 'queued',
    input: { task: 'accepted during validation' },
    configuration: { provider: 'test', model: 'test' }
  });
  release();
  await assert.rejects(changing, /boundary changed/u);
  assert.equal((await sessions.loadReplayState(session)).contextWindow, undefined);
});

test('small UTF-8 ranges fail explicitly instead of returning an endless empty cursor', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  const entry = await sessions.appendInput(session, { runId: 'run', task: '改正😀' });
  const history = new HistoryReader({ repository: sessions, session });
  await assert.rejects(
    history.read({ source: sourceRef(session.id, entry), maxBytes: 1 }),
    /UTF-8/u
  );
  const range = await history.read({ source: sourceRef(session.id, entry), maxBytes: 4 });
  assert.equal(range.item.text, '改');
  assert.equal(range.nextOffset, 3);
});

test('rebuildable lexical index reports partial coverage and scans new source identities', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  await sessions.appendInput(session, { runId: 'one', task: 'old alpha constraint' });
  await sessions.appendInput(session, { runId: 'two', task: 'beta constraint' });
  const history = new HistoryReader({ repository: sessions, session });
  assert.equal((await history.rebuildIndex({ maxScanned: 1 })).coverage, 'partial');
  assert.equal((await history.search({ query: 'beta' })).items.length, 1);
  assert.equal((await history.rebuildIndex()).coverage, 'complete');
  await sessions.appendInput(session, { runId: 'three', task: 'new gamma correction' });
  const fresh = await history.search({ query: 'gamma' });
  assert.equal(fresh.items.length, 1);
  assert.equal(fresh.index.coverage, 'complete');
  assert.equal(fresh.coverage, 'complete', 'incremental refresh includes the new source');
});

test('original accepted whitespace and relationship survive JSONL restart independently of scheduling', async () => {
  const { root, sessions } = await backend('jsonl');
  const session = await sessions.create({ id: 'relationship', binding });
  await sessions.enqueueSubmission(session, {
    submissionId: 'original',
    runId: 'run',
    input: { task: '  original\n\n', relationship: { kind: 'side_question' } },
    configuration: { provider: 'test', model: 'test' }
  });
  await sessions.appendInput(session, { runId: 'run', task: 'original' });
  const reopened = new JsonlSessionRepository(path.join(root, 'sessions'));
  const read = await reopened.loadReplayState(await reopened.open(session.id, binding));
  assert.equal(read.branch[0].originalInput.task, '  original\n\n');
  assert.equal(read.branch[0].originalInput.relationship.kind, 'side_question');
  await assert.rejects(
    sessions.enqueueSubmission(session, {
      submissionId: 'invalid',
      runId: 'invalid',
      input: { task: 'valid', contextItems: [{ unexpected: true }] },
      configuration: { provider: 'test', model: 'test' }
    }),
    /prompt context/iu
  );
});

test('assistant media bytes persist losslessly and protocol payloads stay out of history tools', async () => {
  const { root, sessions } = await backend('jsonl');
  const session = await sessions.create({ binding });
  await sessions.appendInput(session, { runId: 'run', task: 'render image' });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const state = await createProviderContextState({
    protocolRevision: 'fixture-v1',
    provider: 'test',
    endpoint: 'https://test',
    request: { model: 'model', messages: [{ role: 'user', content: 'render image' }] },
    requestId: 'request',
    kind: 'signed',
    data: { opaque: 'hidden-provider-payload' }
  });
  const entry = await sessions.appendAssistant(session, {
    runId: 'run',
    identity,
    content: '',
    output: [
      {
        type: 'media',
        part: { type: 'image', image: { type: 'bytes', data: bytes, mediaType: 'image/png' } }
      },
      { type: 'protocol', state }
    ]
  });
  bytes[0] = 99;
  const reopened = new JsonlSessionRepository(path.join(root, 'sessions'));
  const view = await new HistoryReader({
    repository: reopened,
    session: await reopened.open(session.id, binding)
  }).page();
  const image = view.entries.find((item) => item.type === 'assistant').output[0].part.image;
  assert.equal(image.type, 'base64');
  assert.deepEqual([...Buffer.from(image.data, 'base64')], [1, 2, 3, 4]);
  const read = await new HistoryReader({ repository: reopened, session }).read({
    source: sourceRef(session.id, entry)
  });
  assert.equal(read.status, 'available');
  assert.match(read.item.text, /image\/png/u);
  assert.equal(JSON.stringify(read).includes('hidden-provider-payload'), false);
  assert.equal(
    (
      await new HistoryReader({ repository: reopened, session }).search({
        query: 'hidden-provider-payload'
      })
    ).items.length,
    0
  );
});

test('active accepted input and tool-result dependencies cannot be omitted', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  const input = await sessions.appendInput(session, {
    runId: 'run',
    task: 'mandatory current task'
  });
  const observation = await sessions.appendObservation(session, {
    runId: 'run',
    identity: { ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call', toolAttempt: 1 },
    toolName: 'read',
    observation: { kind: 'result', summary: 'result', output: {} }
  });
  const context = new ContextService({
    artifacts: new InMemoryArtifactRepository(),
    repository: sessions,
    session,
    policy: { maxSourceBytes: 8192 }
  });
  await assert.rejects(
    context.transition({
      expectedWindowId: null,
      idempotencyKey: 'orphan',
      reason: 'test',
      selection: {
        strategy: 'sources',
        retained: [sourceRef(session.id, input), sourceRef(session.id, observation)]
      }
    }),
    /no matching original call/u
  );
  await assert.rejects(
    context.transition({
      expectedWindowId: null,
      idempotencyKey: 'omit-active',
      reason: 'test',
      selection: {
        strategy: 'sources',
        retained: []
      }
    }),
    /active accepted or protected input is mandatory/u
  );
});

test('native context selection binds only validated host state and rejects caller-supplied state', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  const input = await sessions.appendInput(session, {
    runId: 'run',
    task: 'original native input'
  });
  await sessions.recordRunFinalization(session, terminal('run'));
  const state = {
    artifact: { id: 'host-validated-artifact', sha256: 'a'.repeat(64) },
    invocationId: 'native-invocation'
  };
  const context = new ContextService({
    artifacts: new InMemoryArtifactRepository(),
    repository: sessions,
    session,
    policy: { maxSourceBytes: 8192 }
  });
  const selection = {
    strategy: 'provider',
    retained: [sourceRef(session.id, input)]
  };
  await assert.rejects(
    context.transition({
      expectedWindowId: null,
      idempotencyKey: 'forged',
      reason: 'test',
      selection: { ...selection, providerState: { authority: 'forged' } }
    }),
    /governed host validation/u
  );
  const committed = await context.transition(
    {
      expectedWindowId: null,
      idempotencyKey: 'native',
      reason: 'test',
      selection
    },
    {
      admit: async () => ({
        compiledInputIdentity: 'native-request',
        capabilityRevision: 'fixture',
        providerState: state
      })
    }
  );
  state.artifact.id = 'mutated';
  assert.equal(committed.window.selection.providerState.artifact.id, 'host-validated-artifact');
  assert.equal(Object.isFrozen(committed.window.selection.providerState.artifact), true);
  assert.equal(
    (await context.inspect()).window.selection.providerState,
    undefined,
    'ordinary context inspection exposes references without opaque state payload'
  );
});

test('ledger source refs survive delayed mirrors and event heads decide transition tails', async () => {
  const sessions = new InMemorySessionRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  const session = await sessions.create({ binding });
  await sessions.appendInput(session, { runId: 'run', task: 'original' });
  const receipt = await events.append('run', {
    type: 'assistant.ended',
    ...identity,
    content: 'committed before mirror',
    modelOutput: {
      status: 'complete',
      message: 'committed before mirror',
      source: 'content',
      turnIndex: 1
    }
  });
  const reader = new HistoryReader({ repository: sessions, session, events });
  const captured = await reader.page();
  const answer = captured.entries.find((entry) => entry.type === 'assistant');
  const source = sourceRef(session.id, answer);
  assert.equal(
    await sourceAfter(reader, answer, captured.cut),
    false,
    'a missing mirror is still covered by the captured ledger head'
  );
  await sessions.appendAssistant(session, {
    runId: 'run',
    identity,
    content: answer.content,
    completeness: 'complete',
    source: {
      runId: 'run',
      eventId: receipt.eventId,
      sequence: receipt.sequence,
      hash: receipt.hash
    }
  });
  const plain = new HistoryReader({ repository: sessions, session });
  assert.equal((await plain.read({ source })).item.text, answer.content);
  assert.equal((await reader.read({ source })).item.text, answer.content);
  await events.append('run', {
    type: 'assistant.ended',
    ...identity,
    turnId: 'next-turn',
    turnIndex: 2,
    content: 'new tail',
    modelOutput: { status: 'complete', message: 'new tail', source: 'content', turnIndex: 2 }
  });
  const latest = await reader.page();
  assert.equal(
    await sourceAfter(
      reader,
      latest.entries.find((entry) => entry.type === 'assistant' && entry.turnId === 'next-turn'),
      captured.cut
    ),
    true
  );
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: steering acceptance survives uncertain delivery and deduplicates exact late mirrors`, async () => {
    const { sessions, events } = await backend(kind);
    const session = await sessions.create({ binding });
    await sessions.appendInput(session, { runId: 'run', task: 'original task' });
    const receipt = await events.append('run', {
      type: 'input.steering.accepted',
      deliveryId: 'correction',
      content: '  corrected identifier  '
    });
    const reader = new HistoryReader({ repository: sessions, session, events });
    const before = await reader.page();
    const source = sourceRef(
      session.id,
      before.entries.find((entry) => entry.type === 'steering')
    );
    assert.equal(source.event.eventId, receipt.eventId);
    const originalInput = {
      task: '  corrected identifier  ',
      instructions: ['Keep the attachment.'],
      contextItems: []
    };
    const mirrorInput = {
      runId: 'run',
      deliveryId: 'correction',
      content: originalInput.task,
      originalInput,
      relationship: { kind: 'correct' }
    };
    const mirror = await sessions.appendSteering(session, mirrorInput);
    assert.equal((await sessions.appendSteering(session, mirrorInput)).id, mirror.id);
    await assert.rejects(
      () => sessions.appendSteering(session, { ...mirrorInput, content: 'different' }),
      /conflicting/u
    );
    const reopened = new HistoryReader({
      repository: sessions,
      session: await sessions.open(session.id, binding),
      events
    });
    const after = await reopened.page();
    const steering = after.entries.filter((entry) => entry.type === 'steering');
    assert.equal(steering.length, 1);
    assert.deepEqual(sourceRef(session.id, steering[0]), source);
    assert.deepEqual(steering[0].originalInput, originalInput);
    assert.equal(await sourceAfter(reopened, steering[0], before.cut), false);
    assert.match((await reopened.read({ source })).item.text, /corrected identifier/u);
  });

  test(`${kind}: session-only cuts retain newly visible sourced assistant records`, async () => {
    const { sessions, events } = await backend(kind);
    const session = await sessions.create({ binding });
    await sessions.appendInput(session, { runId: 'run', task: 'original task' });
    const reader = new HistoryReader({ repository: sessions, session });
    const openCut = await reader.capture();
    await sessions.recordRunFinalization(session, terminal('run'));
    const finalizedCut = await reader.capture();
    const receipt = await events.append('run', {
      type: 'assistant.ended',
      ...identity,
      content: 'late source',
      modelOutput: { status: 'complete', message: 'late source', source: 'content', turnIndex: 1 }
    });
    await sessions.appendAssistant(session, {
      runId: 'run',
      identity,
      content: 'late source',
      source: {
        runId: 'run',
        eventId: receipt.eventId,
        sequence: receipt.sequence,
        hash: receipt.hash
      }
    });
    const view = await reader.page();
    const assistant = view.entries.find((entry) => entry.type === 'assistant');
    assert.equal(await sourceAfter(reader, assistant, openCut), true);
    assert.equal(await sourceAfter(reader, assistant, finalizedCut), true);
    const { ledgerHeads, ...noLedgerCut } = openCut;
    assert.equal(await sourceAfter(reader, assistant, noLedgerCut), true);
  });

  test(`${kind}: canonical tool arguments retain content beyond normalization limits`, async () => {
    const { sessions } = await backend(kind);
    const session = await sessions.create({ binding });
    await sessions.appendInput(session, {
      runId: 'run',
      task: 'read complete tool arguments later'
    });
    const text = `${'x'.repeat(100000)} exact final constraint`;
    const call = await sessions.appendToolCall(session, {
      runId: 'run',
      identity: { ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call' },
      call: { id: 'call', name: 'write', input: { kind: 'json', value: { text } } }
    });
    const history = new HistoryReader({ repository: sessions, session });
    const read = await history.read({ source: sourceRef(session.id, call), maxBytes: 128 * 1024 });
    assert.equal(JSON.parse(read.item.text).input.value.text, text);
    assert.equal((await history.search({ query: 'exact final constraint' })).items.length, 1);
  });
}

test('context discovery advertises provider transformation only while a capable runtime is bound', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  const context = new ContextService({
    artifacts: new InMemoryArtifactRepository(),
    repository: sessions,
    session,
    policy: { maxSourceBytes: 8192 }
  });
  assert.deepEqual((await context.inspect()).legalTransitions, ['sources']);
  const unbind = context.bindRuntime({
    providerTransform: true,
    schedule: async () => ({ requestId: 'request' })
  });
  assert.deepEqual((await context.inspect()).legalTransitions, ['sources', 'provider']);
  unbind();
  assert.deepEqual((await context.inspect()).legalTransitions, ['sources']);
});

async function sourceAfter(reader, source, cut) {
  let page = await reader.entriesAfter(cut);
  for (;;) {
    if (
      page.entries.some(
        (entry) => (entry.source?.eventId ?? entry.id) === (source.source?.eventId ?? source.id)
      )
    )
      return true;
    if (!page.cursor) return false;
    page = await reader.entriesAfter(cut, page.cut, { cursor: page.cursor });
  }
}

for (const kind of ['memory', 'jsonl']) {
}

test('history direct lookup, cut capture and bounded search do not call replay', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'incremental-history-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const sessions = new JsonlSessionRepository(root);
  const session = await sessions.create({ id: 'bounded', binding });
  const entries = [];
  for (let at = 0; at < 120; at++)
    entries.push(
      await sessions.appendInput(session, { runId: `run-${at}`, task: `${at} ${'z'.repeat(2048)}` })
    );
  sessions.loadReplayState = () => {
    throw new Error('History must not load replay state.');
  };
  const history = new HistoryReader({ repository: sessions, session });
  const cut = await history.capture();
  const before = sessions.historyReadMetrics(session.id);
  await history.capture();
  assert.equal(sessions.historyReadMetrics(session.id).bodyRecordsRead, before.bodyRecordsRead);
  const source = sourceRef(session.id, entries[70]);
  const read = await history.read({ source, cut, maxBytes: 100, maxSourceBytes: 4096 });
  assert.equal(read.status, 'available');
  assert.equal(sessions.historyReadMetrics(session.id).bodyRecordsRead - before.bodyRecordsRead, 1);
  const beforeSearch = sessions.historyReadMetrics(session.id);
  const result = await history.search({
    query: 'absent',
    cut,
    maxScanned: 5,
    maxScannedBytes: 8192
  });
  const afterSearch = sessions.historyReadMetrics(session.id);
  assert(afterSearch.bodyRecordsRead - beforeSearch.bodyRecordsRead <= 5);
  assert(afterSearch.bodyBytesRead - beforeSearch.bodyBytesRead <= 8192);
  assert.equal(result.scannedBytes, afterSearch.bodyBytesRead - beforeSearch.bodyBytesRead);
  const oversized = await history.read({ source, maxSourceBytes: 100 });
  assert.equal(oversized.reason, 'source_too_large');
  assert.equal(
    sessions.historyReadMetrics(session.id).bodyRecordsRead,
    afterSearch.bodyRecordsRead
  );
  const filtered = await history.search({ filter: { sourceType: 'observation' }, maxScanned: 5 });
  assert.equal(filtered.scanned, 5);
  assert.equal(
    sessions.historyReadMetrics(session.id).bodyRecordsRead,
    afterSearch.bodyRecordsRead
  );
});
