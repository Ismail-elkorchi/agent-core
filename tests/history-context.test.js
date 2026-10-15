import * as z from 'zod';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseToolObservation, encodeToolObservation, serializeToolModelContent } from '@agent-core/tools';
import { createProviderContextState } from '@agent-core/model';
import { hashJson, InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { LocalArtifactRepository, JsonlEventRepository } from '@agent-core/persistence/node';
import {
  AgentSession,
  AgentRunCoordinator,
  ContextService,
  HistoryReader,
  InMemorySessionRepository,
  agentEventCodec,
  createHistoryTools,
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
// Service tests provide deterministic compiled admission; runtime tests compile the actual request.
function renew(context, request, options = {}) {
  const selection = request.selection;
  return context.transition({ ...request, selection: { ...selection,
    continuity: selection.continuity ?? { kind: 'fresh', resetId: request.idempotencyKey,
      model: { provider: 'fixture', model: 'context' }, sources: selection.retained }
  } }, { admit: async () => ({ compiledInputIdentity: 'fixture-input', capabilityRevision: 'fixture' }), ...options });
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
  test(`${kind}: inherited cuts cannot expose a parent's ledger beyond the fork boundary`, async () => {
    const { sessions, artifacts, events } = await backend(kind);
    const session = await sessions.create({ binding });
    await sessions.appendInput(session, { runId: 'open-run', task: 'Original requirement' });
    const answer = (content, turnIndex) => ({
      type: 'assistant.ended', ...identity, turnId: `turn-${turnIndex}`, turnIndex, content,
      modelOutput: { status: 'complete', message: content, source: 'content', turnIndex }
    });
    await events.append('open-run', answer('Before the fork', 1));
    const history = new HistoryReader({ repository: sessions, session, events, artifacts });
    const ancestor = await history.capture();
    const context = new ContextService({ repository: sessions, session, artifacts, history,
      policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } }
    });
    const point = await renew(context, {
      expectedWindowId: (await context.inspect()).window?.windowId ?? null,
      expectedSourceRevision: (await context.history.capture()).sourceRevision,
      selection: { retained: await context.protectedSources() },
 idempotencyKey: 'fork-point', reason: 'Historical point'
    });
    await events.append('open-run', answer('Later parent answer', 2));
    const later = await history.capture();
    await sessions.recordRunFinalization(session, terminal('open-run'));
    await events.append('open-run', { type: 'run.ended', terminal: terminal('open-run') });
    assert.deepEqual((await history.capture()).ledgerHeads, []);
    await sessions.branchFrom(session, point.id, 'Independent child');
    const child = await history.capture();
    assert.equal(await history.extendsCut(ancestor, child), true);
    assert.deepEqual(child.ledgerHeads, ancestor.ledgerHeads);
    await assert.rejects(history.validateCut(later), /exceeds the inherited fork boundary/);
    await assert.rejects(
      history.validateCut({ ...ancestor, ledgerHeads: later.ledgerHeads }),
      /exceeds the inherited fork boundary/
    );
    const old = await history.page({ cut: ancestor });
    assert.deepEqual(old.entries.filter((entry) => entry.type === 'assistant')
      .map((entry) => entry.content), ['Before the fork']);
    const incremental = await history.page({ after: point.window.historyPosition, cut: child });
    assert.deepEqual(incremental.entries.map((entry) => entry.type), ['context_transition', 'branch']);
  });

  test(`${kind}: history excerpts budget the complete model presentation and preserve exact retrievable sources`, async () => {
    const { sessions } = await backend(kind);
    const session = await sessions.create({ binding });
    const output = { text: `needle ${'"\\\n\t改正😀'.repeat(700)}` };
    for (let i = 0; i < 3; i++) {
      await sessions.appendObservation(session, {
        runId: 'run',
        identity: { ...identity, toolBatchId: 'batch', callIndex: i, toolAttempt: 1 },
        toolName: 'read',
        observation: { kind: 'result', summary: 'original read', output }
      });
    }
    const history = new HistoryReader({ repository: sessions, session });
    const sources = [];
    let cursor;
    do {
      const page = await history.search({
        query: 'needle', filter: { sourceType: 'observation' }, limit: 2, maxBytes: 2200, cursor
      });
      assert(page.items.length > 0);
      assert(page.bytes <= 2200);
      const search = createHistoryTools({ history }).find((tool) => tool.name === 'history_search');
      const content = await search.buildModelContent({ observation: { kind: 'result', output: page } });
      assert.equal(page.bytes, Buffer.byteLength(serializeToolModelContent(content)));
      for (const item of page.items) {
        assert.equal(item.truncated, true);
        assert.match(item.text, /needle/);
        assert(!item.text.includes('\uFFFD'));
        const original = await history.read({ source: item.source, maxBytes: 32768 });
        assert.equal(original.status, 'available');
        assert.equal(original.item.truncated, false);
        assert.equal(JSON.parse(original.item.text).output.text, output.text);
        assert(original.item.text.startsWith(item.text));
        sources.push(item.source.entryId);
      }
      cursor = page.cursor;
    } while (cursor);
    assert.equal(sources.length, 3);
    assert.equal(new Set(sources).size, 3);
  });

  test(`${kind}: history filters precede original hydration and unread sources retain exact identities`, async () => {
    const { sessions, events, artifacts } = await backend(kind);
    const session = await sessions.create({ binding });
    await sessions.appendInput(session, { runId: 'run', task: 'history' });
    const original = parseToolObservation({ outputSchema: z.json() }, { kind: 'result', summary: 'large original', scope: { resources: [], coverage: 'complete' },
      output: { text: 'x'.repeat(50000) + 'needle' } });
    const artifact = await artifacts.store({ label: 'history-original', content: Buffer.from(JSON.stringify(encodeToolObservation(original))),
      mediaType: 'application/json' });
    for (const [callIndex, toolName] of ['other_tool', 'wanted_tool'].entries()) {
      await events.append('run', { type: 'tool.ended', ...identity, toolBatchId: 'batch', callIndex,
        toolAttempt: 1, toolName,
        observation: { storage: 'artifact', kind: original.kind, summary: original.summary,
          digest: hashJson(encodeToolObservation(original)), coverage: 'complete', artifact } });
    }
    await events.append('run', { type: 'tool.ended', ...identity, toolBatchId: 'batch', callIndex: 2,
      toolAttempt: 1, toolName: 'small_tool',
      observation: { storage: 'inline', kind: 'result', summary: 'small', coverage: 'complete',
        digest: hashJson(encodeToolObservation(parseToolObservation({ outputSchema: z.json() }, { ...original, summary: 'small', output: { text: 'needle' } }))),
        observation: parseToolObservation({ outputSchema: z.json() }, { ...original, summary: 'small', output: { text: 'needle' } }) } });
    const history = new HistoryReader({ repository: sessions, session, events, artifacts });
    const small = await history.search({ query: 'needle', filter: { toolName: 'small_tool' }, maxScannedBytes: 10000 });
    assert.equal(small.items.length, 1);
    assert.equal(small.unread, undefined, 'unrelated originals cannot exhaust hydration or produce diagnostics');
    const limited = await history.search({ query: 'needle', filter: { toolName: 'wanted_tool' }, maxScannedBytes: 10000, maxBytes: 2200 });
    assert.equal(limited.coverage, 'partial');
    assert.equal(limited.unread.length, 1);
    assert.equal(limited.unread[0].reason, 'source_byte_limit');
    assert(limited.bytes <= 2200, 'coverage and cursor share the presentation budget');
    const exact = await history.read({ source: limited.unread[0].source, maxSourceBytes: 100000, maxBytes: 100000 });
    assert.equal(exact.status, 'available');
    assert.match(exact.item.text, /needle/);
    const next = await history.search({ query: 'needle', filter: { toolName: 'wanted_tool' }, cursor: limited.cursor,
      maxScannedBytes: 10000, maxBytes: 2200 });
    assert.equal(next.unread, undefined);
    assert.equal(next.coverage, 'complete');
  });

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
    await sessions.admitSubmission(session, {
      submissionId: 'submission',
      claimId: 'claim',
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
    await sessions.transitionSubmission(session, 'submission', { state: 'completed', claimId: 'claim' });
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
  const changing = renew(context,
    {
      expectedWindowId: null,
      idempotencyKey: 'pending',
      reason: 'capture',
      selection: { retained: [sourceRef(session.id, first)] }
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
  await sessions.admitSubmission(session, {
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

test('bounded search reports partial coverage and scans new source identities', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  await sessions.appendInput(session, { runId: 'one', task: 'old alpha constraint' });
  await sessions.appendInput(session, { runId: 'two', task: 'beta constraint' });
  const history = new HistoryReader({ repository: sessions, session });
  assert.equal((await history.search({ maxScanned: 1 })).coverage, 'partial');
  assert.equal((await history.search({ query: 'beta' })).items.length, 1);
  assert.equal((await history.search()).coverage, 'complete');
  await sessions.appendInput(session, { runId: 'three', task: 'new gamma correction' });
  const fresh = await history.search({ query: 'gamma' });
  assert.equal(fresh.items.length, 1);
  assert.equal(fresh.coverage, 'complete', 'incremental refresh includes the new source');
});

test('original accepted whitespace and relationship survive JSONL restart independently of scheduling', async () => {
  const { root, sessions } = await backend('jsonl');
  const session = await sessions.create({ id: 'relationship', binding });
  await sessions.admitSubmission(session, {
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
    sessions.admitSubmission(session, {
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
    requiresExactPrefix: true,
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
    renew(context, {
      expectedWindowId: null,
      idempotencyKey: 'orphan',
      reason: 'test',
      selection: {
        retained: [sourceRef(session.id, input), sourceRef(session.id, observation)]
      }
    }),
    /no matching original call/u
  );
  await assert.rejects(
    renew(context, {
      expectedWindowId: null,
      idempotencyKey: 'omit-active',
      reason: 'test',
      selection: {
        retained: []
      }
    }),
    /active accepted or protected input is mandatory/u
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

test('context discovery advertises fresh renewal only', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding });
  const context = new ContextService({ artifacts: new InMemoryArtifactRepository(), repository: sessions,
    session, policy: { maxSourceBytes: 8192 } });
  assert.deepEqual((await context.inspect()).legalTransitions, ['fresh']);
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

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: repeated captures refresh unfinished runs, not the finalized archive`, async () => {
    const { sessions, events } = await backend(kind);
    const session = await sessions.create({ binding });
    const history = new HistoryReader({ repository: sessions, session, events });
    const lookups = [];
    const tails = [];
    const latest = events.latestOfType.bind(events);
    const tail = events.tail.bind(events);
    events.latestOfType = async (runId, type) => {
      lookups.push(runId);
      return latest(runId, type);
    };
    events.tail = async runId => {
      tails.push(runId);
      return tail(runId);
    };
    for (let at = 0; at < 140; at++) {
      const runId = `completed-${at}`;
      await sessions.appendInput(session, { runId, task: 'done' });
      await sessions.recordRunFinalization(session, terminal(runId));
      await events.append(runId, { type: 'run.ended', terminal: terminal(runId) });
    }
    assert.deepEqual((await history.capture()).ledgerHeads, []);
    assert.equal(lookups.length, 140);
    lookups.length = 0;
    tails.length = 0;
    await history.capture();
    assert.deepEqual(lookups, []);
    assert.deepEqual(tails, []);

    await sessions.appendInput(session, { runId: 'active', task: 'new work' });
    assert.deepEqual((await history.capture()).ledgerHeads.map(head => head.runId), ['active']);
    assert.deepEqual(lookups, []);
    assert.deepEqual(tails, ['active']);
    await sessions.recordRunFinalization(session, terminal('active'));
    // Session recording precedes the authoritative terminal event.
    assert.equal((await history.capture()).ledgerHeads.length, 1);
    assert.deepEqual(lookups, ['active']);
    await events.append('active', { type: 'run.ended', terminal: terminal('active') });
    assert.deepEqual((await history.capture()).ledgerHeads, []);
    assert.deepEqual(lookups, ['active', 'active']);
    lookups.length = 0;
    tails.length = 0;
    await history.capture();
    await sessions.appendInput(session, { runId: 'next', task: 'next work' });
    await history.capture();
    assert.deepEqual(lookups, []);
    assert.deepEqual(tails, ['next']);

    const reopened = new HistoryReader({ repository: sessions, session, events });
    assert.deepEqual((await reopened.capture()).ledgerHeads.map(head => head.runId), ['next']);
    assert.equal(lookups.length, 0, 'reopening reuses confirmed terminal proofs without walking the finalized archive');
  });
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: indexed lookup verifies only matching originals and extends to new history`, async () => {
    const { sessions } = await backend(kind);
    const session = await sessions.create({ binding });
    for (let i = 0; i < 150; i++) {
      await sessions.appendInput(session, { runId: `indexed-${i}`, task: i === 74 ? 'unique original needle' : `irrelevant original ${i}` });
      await sessions.recordRunFinalization(session, terminal(`indexed-${i}`));
    }
    let reads = 0;
    const read = sessions.readBranchEntry.bind(sessions);
    sessions.readBranchEntry = (...args) => { reads++; return read(...args); };
    const history = new HistoryReader({ repository: sessions, session });
    const populated = await history.search({ query: 'absent term' });
    assert.equal(populated.coverage, 'complete');
    const baseline = reads;
    const found = await history.search({ query: 'unique original needle' });
    assert.equal(found.coverage, 'complete');
    assert.equal(found.items.length, 1);
    assert.equal(reads - baseline, 1, 'warm search verifies a candidate without reading unrelated source bodies');
    const old = found.cut;
    await sessions.appendInput(session, { runId: 'new', task: 'later unique addition' });
    const added = await history.search({ query: 'later unique addition' });
    assert.equal(added.items.length, 1);
    assert.equal((await history.search({ query: 'later unique addition', cut: old })).items.length, 0);
    const restarted = new HistoryReader({ repository: sessions, session });
    let page = await restarted.search({ query: 'irrelevant original', limit: 11, maxScanned: 40 });
    const ids = new Set();
    while (true) {
      for (const item of page.items) { assert(!ids.has(item.source.entryId)); ids.add(item.source.entryId); }
      if (!page.cursor) break;
      page = await new HistoryReader({ repository: sessions, session }).search({
        query: 'irrelevant original', cursor: page.cursor, limit: 11, maxScanned: 40
      });
    }
    assert.equal(ids.size, 149);
  });


}

test('indexed history sees newly settled output before later runs and honors source timestamps', async () => {
  const { sessions, artifacts, events } = await backend('memory');
  const session = await sessions.create({ binding });
  const input = await sessions.appendInput(session, { runId: 'older-open', task: 'match original' });
  await sessions.appendInput(session, { runId: 'later', task: 'match later input' });
  const history = new HistoryReader({ repository: sessions, session, artifacts, events });
  assert.equal((await history.search({ query: 'match' })).items.length, 2);
  await events.append('older-open', {
    type: 'assistant.ended', ...identity, content: 'match late-arriving result',
    modelOutput: { status: 'complete', message: 'match late-arriving result', source: 'content', turnIndex: 1 }
  });
  const extended = await history.search({ query: 'match' });
  assert.equal(extended.coverage, 'complete');
  assert.deepEqual(extended.items.map(item => item.text), ['match original', 'match late-arriving result', 'match later input']);
  const before = await history.search({ query: 'match', filter: { beforeTime: input.timestamp } });
  assert.equal(before.items.length, 0);
  const after = await history.search({ query: 'match', filter: { afterTime: input.timestamp } });
  assert.equal(after.items.length, 3);
});

for (const kind of ['memory', 'jsonl']) {
  for (const authoritative of [false, true]) {
    for (const storage of ['inline', 'artifact']) {
      test(`${kind}/${authoritative ? 'ledger' : 'session'}/${storage}: metadata rejects irrelevant payloads before byte admission`, async () => {
        const f = await backend(kind);
        const session = await f.sessions.create({ binding });
        await f.sessions.appendInput(session, { runId: 'run', task: 'history' });
        let relevant;
        for (const [callIndex, toolName, text] of [[0, 'other', 'x'.repeat(50000)], [1, 'wanted', 'needle'], [2, 'large', 'needle' + 'y'.repeat(50000)]]) {
          const observation = parseToolObservation({ outputSchema: z.json() }, {
            kind: 'result', summary: toolName, output: { text }, scope: { resources: [], coverage: 'complete' }
          });
          const artifact = storage === 'artifact' ? await f.artifacts.store({ label: toolName,
            content: Buffer.from(JSON.stringify(encodeToolObservation(observation))), mediaType: 'application/json' }) : undefined;
          const stored = { kind: 'result', summary: toolName, digest: hashJson(encodeToolObservation(observation)), coverage: 'complete',
            ...(artifact ? { storage: 'artifact', artifact } : { storage: 'inline', observation }) };
          if (authoritative) {
            const receipt = await f.events.append('run', { type: 'tool.ended', ...identity,
              toolBatchId: 'batch', callIndex, toolAttempt: 1, toolName, observation: stored });
            if (toolName === 'large') relevant = receipt.eventId;
          } else {
            const entry = await f.sessions.appendObservation(session, { runId: 'run',
              identity: { ...identity, toolBatchId: 'batch', callIndex, toolAttempt: 1 }, toolName,
              observation: artifact ? { kind: 'result', summary: toolName, originalArtifact: artifact } : observation });
            if (toolName === 'large') relevant = entry.id;
          }
        }
        for (const cold of [false, true]) {
          let events = f.events, repository = f.sessions;
          if (kind === 'jsonl' && cold) {
            await rm(path.join(f.root, 'events', 'run-run.index'), { recursive: true, force: true });
            events = new JsonlEventRepository({ rootDir: path.join(f.root, 'events'), codec: agentEventCodec });
            if (authoritative) {
              await assert.rejects(events.tail('run', { metadataOnly: true }), error => error.code === 'index_recovery_required');
              await events.rebuild('run');
            }
            repository = new JsonlSessionRepository(path.join(f.root, 'sessions'));
          }
          const history = new HistoryReader({ repository, session, artifacts: f.artifacts,
            ...(authoritative ? { events } : {}) });
          const request = { query: 'needle', filter: { toolName: 'wanted' }, maxScannedBytes: 10000, maxScanned: 1000, maxBytes: 5000 };
          const page = await history.search(request);
          assert.equal(page.items.length, 1, JSON.stringify(page));
          assert.equal(page.coverage, 'complete');
          assert.equal(page.unread, undefined);
          assert(page.scannedBytes < 10000);
          const bounded = await history.search({ ...request, filter: { toolName: 'large' } });
          assert.equal(bounded.coverage, 'partial');
          assert.equal(bounded.unread.length, 1);
          assert(bounded.unread[0].source.entryId.includes(relevant));
          assert.equal((await history.read({ source: bounded.unread[0].source, maxSourceBytes: 200000 })).status, 'available');
          // Record limits still count filtered records and the cursor retains its exact capture.
          const sources = [];
          let cursor;
          do {
            const next = await history.search({ ...request, maxScanned: 1, ...(cursor ? { cursor } : {}) });
            sources.push(...next.items);
            assert.equal(next.unread, undefined);
            assert(next.scanned <= 1);
            cursor = next.cursor;
          } while (cursor);
          assert.equal(sources.length, 1);
        }
        if (f.root) await rm(f.root, { recursive: true, force: true });
      });
    }
  }
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: metadata pages preserve source identity without hydrating oversized originals`, async () => {
    const { sessions, events, artifacts, root } = await backend(kind);
    try {
      const session = await sessions.create({ binding });
      const input = await sessions.appendInput(session, { runId: 'inventory', task: 'x'.repeat(850000) });
      const receipt = await events.append('inventory', {
        type: 'assistant.ended', ...identity, content: 'y'.repeat(850000),
        modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }
      });
      const history = new HistoryReader({ repository: sessions, session, events, artifacts });
      const cut = await history.capture();
      const readBranchEntry = sessions.readBranchEntry;
      const readRange = events.readRange;
      const readReference = events.readReference;
      sessions.readBranchEntry = async () => { throw new Error('Metadata must not hydrate session bodies'); };
      events.readRange = async () => { throw new Error('Metadata must not hydrate event bodies'); };
      events.readReference = async () => { throw new Error('Metadata must not read event references'); };
      let cursor;
      const items = [];
      do {
        const page = await history.metadataPage({ cut, cursor, limit: 1, maxBytes: 4096 });
        assert(page.bytes <= 4096);
        items.push(...page.items);
        cursor = page.cursor;
      } while (cursor);
      assert.equal(items.length, 2);
      assert.deepEqual(items[0].source, sourceRef(session.id, input));
      assert.equal(items[1].source.sha256, receipt.hash);
      assert.equal(items[1].source.event.sequence, receipt.sequence);
      assert(items.every(item => item.sourceBytes > 850000 && item.description.length <= 200));
      assert.deepEqual(await history.metadata(items[1].source, cut), items[1]);
      await assert.rejects(history.metadata({ ...items[1].source, sha256: '0'.repeat(64) }, cut), /identity mismatch/);
      const outside = { ...items[1].source, sessionId: 'another-session' };
      assert.equal(await history.metadata(outside, cut), undefined);
      sessions.readBranchEntry = readBranchEntry;
      events.readRange = readRange;
      events.readReference = readReference;
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  });
}

test('direct exchange reads hydrate only matching sources after a large run history', async () => {
  const { sessions, events, artifacts } = await backend('memory');
  const session = await sessions.create({ binding });
  await sessions.appendInput(session, { runId: 'long-run', task: 'Original' });
  for (let i = 0; i < 12; i++) {
    await events.append('long-run', {
      type: 'assistant.ended', ...identity, turnId: `past-${i}`, content: 'x'.repeat(800000),
      modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }
    });
  }
  const receipt = await events.append('long-run', {
    type: 'assistant.ended', ...identity, turnId: 'wanted', content: 'Selected answer',
    modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }
  });
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const cut = await history.capture();
  const source = { sessionId: session.id, entryId: `event:${receipt.eventId}`, sha256: receipt.hash,
    event: { runId: 'long-run', eventId: receipt.eventId, sequence: receipt.sequence, hash: receipt.hash } };
  const readRange = events.readRange.bind(events);
  const readSequences = [];
  events.readRange = async (runId, request) => {
    readSequences.push(request.afterSequence + 1);
    return readRange(runId, request);
  };
  const exchange = await history.exchange(source, cut);
  assert.equal(exchange.length, 1);
  assert.equal(exchange[0].content, 'Selected answer');
  assert.deepEqual(readSequences, [receipt.sequence]);
});

test('a one-item context inventory page visits only its next metadata source', async () => {
  const sessions = new InMemorySessionRepository();
  const artifacts = new InMemoryArtifactRepository();
  const session = await sessions.create({ binding });
  for (let i = 0; i < 200; i++) {
    const runId = `inventory-${i}`;
    await sessions.appendInput(session, { runId, task: `Original ${i}` });
    await sessions.recordRunFinalization(session, terminal(runId));
  }
  const history = new HistoryReader({ repository: sessions, session, artifacts });
  const context = new ContextService({ repository: sessions, session, artifacts, history,
    policy: { maxSourceBytes: 1024, historyRead: { history, isAvailable: () => true } } });
  const cut = await history.capture();
  sessions.readBranchEntry = async () => { throw new Error('Inventory must not hydrate originals'); };
  const metadataPage = history.metadataPage.bind(history);
  let scanned = 0;
  history.metadataPage = async request => {
    const page = await metadataPage(request);
    scanned += page.scanned;
    return page;
  };
  const first = await context.inspect(cut, { limit: 1, maxBytes: 4096 });
  assert.equal(first.activeSelection.manifest.items.length, 1);
  assert.equal(scanned, 1);
  assert.equal(first.activeSelection.manifest.coverage, 'partial');
  const next = await context.inspect(cut, { limit: 1, maxBytes: 4096, cursor: first.activeSelection.manifest.cursor });
  assert.equal(scanned, 2);
  assert.equal(next.activeSelection.manifest.items[0].description, 'Original 1');
});

for (const contextRecovery of [false, true]) {
  test(`canonical source transition ${contextRecovery ? 'can omit recovery control output' : 'rejects omitted unfinished ordinary calls'}`, async () => {
    const sessions = new InMemorySessionRepository();
    const artifacts = new InMemoryArtifactRepository();
    const session = await sessions.create({ binding });
    const input = await sessions.appendInput(session, { runId: 'pending', task: 'Keep the original requirement' });
    await sessions.appendAssistant(session, {
      runId: 'pending', identity, content: '', ...(contextRecovery ? { contextRecovery: true } : {}),
      output: [{ type: 'tool_call', toolCall: {
        id: 'unexecuted', type: 'function', name: 'lookup', input: { kind: 'json', value: {} }
      } }]
    });
    const history = new HistoryReader({ repository: sessions, session, artifacts });
    const context = new ContextService({ repository: sessions, session, artifacts, history,
      policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
    const cut = await history.capture();
    const transition = renew(context, {
      expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
      idempotencyKey: 'omit-unexecuted', reason: 'Explicit selection',
      selection: { retained: [sourceRef(session.id, input)] }
    });
    if (contextRecovery) {
      const result = await transition;
      assert.equal(result.type, 'context_transition');
    } else {
      await assert.rejects(transition, /unfinished tool exchange cannot be released/);
      await assert.rejects(renew(context, { expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
        idempotencyKey: 'fresh-cannot-drop-pending', reason: 'Explicit fresh continuation still owes its result',
        selection: { retained: [sourceRef(session.id, input)], continuity: {
          kind: 'fresh', resetId: 'fresh-pending', model: { provider: 'fixture', model: 'context' }, sources: [sourceRef(session.id, input)]
        } } }), /unfinished tool exchange cannot be released/);
      assert.equal(await history.selectedContext(), undefined);
    }
  });
}

test('raw transition cannot reintroduce a partial historical exchange outside the active window', async () => {
  const sessions = new InMemorySessionRepository();
  const artifacts = new InMemoryArtifactRepository();
  const session = await sessions.create({ binding });
  const input = await sessions.appendInput(session, { runId: 'historical', task: 'Original obligation' });
  const assistant = await sessions.appendAssistant(session, { runId: 'historical', identity, content: '',
    output: [{ type: 'tool_call', toolCall: { id: 'call', type: 'function', name: 'lookup', input: { kind: 'json', value: {} } } }] });
  await sessions.appendToolCall(session, { runId: 'historical', identity: { ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call' }, call: {} });
  await sessions.appendObservation(session, { runId: 'historical', identity: { ...identity, toolBatchId: 'batch', callIndex: 0, callId: 'call', toolAttempt: 1 },
    toolName: 'lookup', observation: { kind: 'result', summary: 'Done', output: {} } });
  const history = new HistoryReader({ repository: sessions, session, artifacts });
  const context = new ContextService({ repository: sessions, session, artifacts, history,
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const first = await renew(context, { expectedWindowId: null, expectedSourceRevision: (await history.capture()).sourceRevision,
    idempotencyKey: 'remove-complete', reason: 'Remove complete exchange', selection: { retained: [sourceRef(session.id, input)] } });
  await assert.rejects(renew(context, { expectedWindowId: first.window.windowId, expectedSourceRevision: (await history.capture()).sourceRevision,
    idempotencyKey: 'partial-add', reason: 'Partial historical add', selection: { retained: [sourceRef(session.id, input), sourceRef(session.id, assistant)] } }), /complete tool exchange/);
});

test('explicit replacement can release more than ten thousand completed exchanges', async () => {
  const sessions = new InMemorySessionRepository();
  const artifacts = new InMemoryArtifactRepository();
  const session = await sessions.create({ binding });
  const input = await sessions.appendInput(session, { runId: 'many-exchanges', task: 'Keep the obligation' });
  for (let i = 0; i < 10001; i++)
    await sessions.appendAssistant(session, { runId: 'many-exchanges', identity: { ...identity, turnId: `turn-${i}` }, content: 'Completed answer' });
  const history = new HistoryReader({ repository: sessions, session, artifacts });
  const context = new ContextService({ repository: sessions, session, artifacts, history,
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const cut = await history.capture();
  const read = sessions.readBranchEntry.bind(sessions);
  sessions.readBranchEntry = async (descriptor, boundary, id) => {
    assert.equal(id, input.id, 'replacement must not hydrate discarded exchange bodies');
    return read(descriptor, boundary, id);
  };
  const result = await renew(context, { expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'bounded-replacement', reason: 'Replace the oversized source plan',
    selection: { retained: [sourceRef(session.id, input)] } });
  assert.equal(result.type, 'context_transition');
  assert.deepEqual(result.window.selection.retained, [sourceRef(session.id, input)]);
});

test('ledger-only native prefix and pending call facts remain visible before a session mirror exists', async () => {
  const { sessions, events, artifacts } = await backend('memory');
  const session = await sessions.create({ binding });
  await sessions.appendInput(session, { runId: 'native-pending', task: 'Keep original prefix' });
  await events.append('native-pending', { type: 'assistant.ended', ...identity, nativePrefixBound: true, content: '',
    modelOutput: { status: 'complete', message: 'Tool request', source: 'content', turnIndex: 1 },
    toolCalls: [{ id: 'pending', name: 'lookup', input: { kind: 'json', value: {} } }] });
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const context = new ContextService({ repository: sessions, session, artifacts, history,
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  events.readRange = async () => { throw new Error('Inventory must not read ledger payloads'); };
  const inspected = await context.inspect(await history.capture(), { limit: 10, maxBytes: 8192 });
  const assistant = inspected.activeSelection.manifest.items.find(item => item.type === 'assistant');
  assert.equal(assistant.group.prefixBound, true);
  assert.equal(assistant.group.release, 'unfinished_exchange');
});

test('whole native prefix release requires a new explicit fresh continuation', async () => {
  const sessions = new InMemorySessionRepository();
  const artifacts = new InMemoryArtifactRepository();
  const session = await sessions.create({ binding });
  const input = await sessions.appendInput(session, { runId: 'native-release', task: 'Preserve this requirement' });
  const native = await createProviderContextState({ protocolRevision: 'fixture-v1', provider: 'fixture',
    endpoint: 'fixture://native', request: { model: 'context', messages: [{ role: 'user', content: input.task }] },
    requestId: 'native-release-request', kind: 'signed', requiresExactPrefix: true, data: { opaque: 'preserved-native-state' } });
  const response = await sessions.appendAssistant(session, { runId: 'native-release', identity, content: 'Native answer', output: [{ type: 'protocol', state: native }] });
  const history = new HistoryReader({ repository: sessions, session, artifacts });
  const context = new ContextService({ repository: sessions, session, artifacts, history,
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const inputRef = sourceRef(session.id, input);
  const cut = await history.capture();
  await assert.rejects(context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'silent-native-drop', reason: 'Release all native sources', selection: { retained: [inputRef] } },
    { admit: async () => ({ compiledInputIdentity: 'fixture', capabilityRevision: 'fixture' }) }), /new fresh continuation/);
  assert.equal(await history.selectedContext(), undefined);
  await assert.rejects(renew(context, { expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'fresh-cannot-drop-input', reason: 'Fresh continuity still owes the accepted input',
    selection: { retained: [], continuity: { kind: 'fresh', resetId: 'fresh-without-input', model: { provider: 'fixture', model: 'context' }, sources: [] } } }), /active accepted or protected input is mandatory/);
  const preserved = await renew(context, { expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'preserve-native', reason: 'Preserve native prefix',
    selection: { retained: [inputRef, sourceRef(session.id, response)] } });
  const fresh = await renew(context, { expectedWindowId: preserved.window.windowId, expectedSourceRevision: (await history.capture()).sourceRevision,
    idempotencyKey: 'explicit-native-reset', reason: 'Explicit fresh continuation',
    selection: { retained: [inputRef], continuity: { kind: 'fresh', resetId: 'new-explicit-reset', model: { provider: 'fixture', model: 'context' }, sources: [inputRef] } } });
  assert.deepEqual(fresh.window.selection.retained, [inputRef]);
  assert.equal(fresh.window.selection.continuity.resetId, 'new-explicit-reset');
});

test('fresh renewal can release a completed older native prefix tail', async () => {
  const { sessions, events, artifacts } = await backend('memory');
  const session = await sessions.create({ binding });
  const earlierInput = await sessions.appendInput(session, { runId: 'earlier-open', task: 'Earlier obligation' });
  await events.append('earlier-open', { type: 'assistant.ended', ...identity, content: 'Earlier answer',
    modelOutput: { status: 'complete', message: 'Earlier answer', source: 'content', turnIndex: 1 } });
  await sessions.appendInput(session, { runId: 'later-native', task: 'Later obligation' });
  await events.append('later-native', { type: 'assistant.ended', ...identity, nativePrefixBound: true, content: 'Native answer',
    modelOutput: { status: 'complete', message: 'Native answer', source: 'content', turnIndex: 1 } });
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const context = new ContextService({ repository: sessions, session, artifacts, history,
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  const cut = await history.capture();
  const selection = await context.selectSources(cut, {});
  assert(selection.retained.some(source => source.entryId === earlierInput.id));
  const prior = await renew(context, { expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
    idempotencyKey: 'native-order-initial', reason: 'Preserve current prefix', selection });
  await events.append('earlier-open', { type: 'assistant.ended', ...identity, turnId: 'late-earlier-response', content: 'Earlier run acquired a tail',
    modelOutput: { status: 'complete', message: 'Earlier run acquired a tail', source: 'content', turnIndex: 1 } });
  const renewed = await renew(context, { expectedWindowId: prior.window.windowId, expectedSourceRevision: (await history.capture()).sourceRevision,
    idempotencyKey: 'omit-earlier-tail', reason: 'Omit the completed earlier-run tail', selection });
  assert.deepEqual(renewed.window.selection.retained, selection.retained);
});

test('metadata continuation carries only a cut fingerprint and resumes across readers', async () => {
  const { sessions, events, artifacts } = await backend('memory');
  const session = await sessions.create({ binding });
  for (let i = 0; i < 50; i++)
    await sessions.appendInput(session, { runId: `open-${i}`, task: `Original ${i}` });
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const cut = await history.capture();
  const page = await history.metadataPage({ cut, limit: 1 });
  assert(page.cursor.length < 512);
  const position = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8'));
  assert.equal('cut' in position, false);
  assert.equal(position.cutHash, hashJson(cut));
  const reopened = new HistoryReader({ repository: sessions, session, events, artifacts });
  const next = await reopened.metadataPage({ cut, cursor: page.cursor, limit: 2 });
  assert.equal(next.items[0].description, 'Original 1');
  await assert.rejects(reopened.metadataPage({ cursor: page.cursor }), /requires its captured cut/);
  await assert.rejects(reopened.metadataPage({ cut: { ...cut, sourceRevision: cut.sourceRevision + 1 }, cursor: page.cursor }), /cursor cut mismatch/);
});

test('manifest byte backtracking preserves the last fitting page across skipped tail records', async () => {
  const sessions = new InMemorySessionRepository();
  const artifacts = new InMemoryArtifactRepository();
  const session = await sessions.create({ binding });
  const retained = [];
  for (let i = 0; i < 6; i++) {
    const input = await sessions.appendInput(session, { runId: `retained-${i}`, task: `Original ${i} ${'detail '.repeat(40)}` });
    retained.push(sourceRef(session.id, input));
  }
  const history = new HistoryReader({ repository: sessions, session, artifacts });
  const context = new ContextService({ repository: sessions, session, artifacts, history,
    policy: { maxSourceBytes: 65536, historyRead: { history, isAvailable: () => true } } });
  await renew(context, { expectedWindowId: null, expectedSourceRevision: (await history.capture()).sourceRevision,
    idempotencyKey: 'retained-tail-boundary', reason: 'Keep the retained inputs', selection: { retained } });
  await sessions.appendInput(session, { runId: 'new-tail', task: 'A new tail original' });
  const cut = await history.capture();
  const six = (await context.inspect(cut, { limit: 6, maxBytes: 8192 })).activeSelection.manifest;
  assert.equal(six.items.length, 6);
  const maxBytes = Buffer.byteLength(JSON.stringify(six)) + 32;
  const bounded = (await context.inspect(cut, { limit: 100, maxBytes })).activeSelection.manifest;
  assert.equal(bounded.items.length, 6);
  assert(Buffer.byteLength(JSON.stringify(bounded)) <= maxBytes);
  assert.equal(bounded.coverage, 'partial');
  const next = (await context.inspect(cut, { limit: 100, maxBytes: 8192, cursor: bounded.cursor })).activeSelection.manifest;
  assert.deepEqual(next.items.map(item => item.description), ['A new tail original']);
  assert.equal(next.coverage, 'complete');
});
