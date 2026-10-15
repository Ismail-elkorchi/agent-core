import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { conservativeProtocolCapabilities } from '@agent-core/model';
import { hashJson, InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { LocalArtifactRepository } from '@agent-core/persistence/node';
import {
  AgentRuntime,
  ContextService,
  HistoryReader,
  InMemorySessionRepository,
  InferenceService,
  agentEventCodec,
  createHistoryTools,
  decodeSessionStateContent,
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'tests/session-state', schemaVersion: 1, subject: {} };
const admission = { admit: async () => ({ compiledInputIdentity: 'test-input', capabilityRevision: 'fixture' }) };
const selectionFor = (retained = []) => ({ retained, continuity: { kind: 'fresh', resetId: randomUUID(), model: { provider: 'fixture', model: 'fixture' }, sources: retained } });
const contentFor = text => text ? { working: [{ id: 'notes', text }] } : {};
const stateText = state => state.content.working?.[0]?.text ?? '';
async function stageState(f, { id, revisionId, inference, text }) {
  const current = await f.context.sessionState();
  if ((current.revision?.id ?? null) !== revisionId) return { status: 'conflict' };
  if (stateText(current) === text) return { status: 'unchanged' };
  return { id, previousRevisionId: revisionId, inference,
    capturedHistoryCut: await f.context.history.capture(),
    content: contentFor(text) };
}
async function fixture(t, kind = 'memory', maxSourceBytes = 1024 * 1024) {
  const root = await mkdtemp(path.join(tmpdir(), 'session-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts =
    kind === 'memory'
      ? new InMemoryArtifactRepository()
      : new LocalArtifactRepository(path.join(root, 'artifacts'));
  const sessions =
    kind === 'memory'
      ? new InMemorySessionRepository()
      : new JsonlSessionRepository(path.join(root, 'sessions'));
  const session = await sessions.create({ binding });
  const events = new InMemoryEventRepository(agentEventCodec);
  const history = new HistoryReader({ repository: sessions, session, artifacts, events });
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    artifacts,
    policy: { maxSourceBytes, historyRead: { history, isAvailable: () => true } }
  });
  const requestRef = await artifacts.storeProtected({
    label: 'test-inference',
    mediaType: 'application/json',
    content: new TextEncoder().encode(
      JSON.stringify({ sessionStateRevisionId: null, logical: { model: 'fixture', messages: [] } })
    )
  });
  const inference = { ownerId: 'owner', invocationId: 'inference', requestRef };
  const requests = new Map();
  const update = async (id, revisionId, text) => {
    const cut = await history.capture();
    let request = requests.get(id);
    if (request && request.text !== text) throw new Error('Session-state retry has different content');
    if (!request) {
      const sessionState = await stageState({ context, artifacts }, { id, revisionId, text, inference });
      if ('status' in sessionState) return sessionState;
      request = { text, transition: {
        expectedCut: cut, expectedSourceRevision: cut.sourceRevision,
        expectedWindowId: (await history.selectedContext(cut))?.windowId ?? null,
        expectedSessionStateRevisionId: revisionId, sessionState,
        idempotencyKey: id, reason: 'Update interpretation',
        selection: selectionFor()
      } };
      requests.set(id, request);
    }
    try {
      const entry = await context.transition(request.transition, {
        admit: async () => ({ compiledInputIdentity: `test-${id}`, capabilityRevision: 'fixture' })
      });
      return { status: 'committed', revisionId: entry.id };
    } catch (error) {
      if (error.name !== 'PersistenceConflictError') throw error;
      return { status: 'conflict' };
    }
  };
  return { root, artifacts, sessions, session, context, history, inference, update, events };
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: one head, full replacement, publication conflict and durable retry`, async (t) => {
    const f = await fixture(t, kind);
    const first = await f.update('first', null, 'Purpose 文😀');
    assert.equal(first.status, 'committed');
    const concurrent = await Promise.all([
      f.update('left', 'first', 'Left interpretation'),
      f.update('right', 'first', 'Right interpretation')
    ]);
    assert.deepEqual(concurrent.map((x) => x.status).sort(), ['committed', 'conflict']);
    const head = await f.sessions.currentSessionState(f.session);
    assert.equal(head.previousRevisionId, 'first');
    assert.equal(
      stateText(await f.context.sessionState()),
      head.id === 'left' ? 'Left interpretation' : 'Right interpretation'
    );
    assert.deepEqual(await f.update('first', null, 'Purpose 文😀'), first);
    await assert.rejects(
      f.update('first', null, 'Changed retry'),
      /different content/
    );
    const snapshot = await f.sessions.sourceSnapshot(f.session);
    assert.equal((await Array.fromAsync(snapshot.entries)).filter((x) => x.type === 'context_transition').length, 2);
    assert.equal((await f.sessions.readConversation(f.session)).length, 0);
    assert.equal(head.contentRef, undefined);
    assert.equal(await f.artifacts.resolve(head.inference.requestRef.artifactId), undefined);
    const unrelated = await f.sessions.create({ binding });
    const outsider = new HistoryReader({
      repository: f.sessions,
      session: unrelated,
      artifacts: f.artifacts
    });
    const source = (await f.context.inspect()).sessionState.source;
    assert.equal((await outsider.read({ source })).reason, 'outside_scope');

    assert.equal((await f.update('stale', null, 'Lost constraints')).status, 'conflict');
  });

  test(`${kind}: forks inherit understanding at the selected historical point`, async (t) => {
    const f = await fixture(t, kind);
    await f.update('old', null, 'Original constraints');
    const point = await f.context.transition({
      expectedWindowId: (await f.context.inspect()).window?.windowId ?? null,
      expectedSourceRevision: (await f.context.history.capture()).sourceRevision,
      selection: selectionFor(await f.context.protectedSources()),

      idempotencyKey: 'point',
      reason: 'Historical boundary'

    }, admission);
    await f.update('later', 'old', 'Later interpretation');
    const laterCut = await f.history.capture();
    await f.sessions.branchFrom(f.session, point.id, 'Historical fork');
    const childCut = await f.history.capture();
    const inheritedCut = point.window.historyPosition;
    assert.notEqual(childCut.branchId, inheritedCut.branchId);
    assert.equal(await f.history.extendsCut(inheritedCut, childCut), true);
    const page = await f.history.page({ after: inheritedCut, cut: childCut, limit: 10 });
    assert.ok(page.entries.some((entry) => entry.type === 'branch'));
    assert.ok(!page.entries.some((entry) => entry.id === 'later'));
    await assert.rejects(f.history.validateCut(laterCut), /outside the authorized branch/);
    await assert.rejects(
      f.history.validateCut({ ...inheritedCut, branchId: childCut.branchId }),
      /branch at its captured boundary/
    );
    await assert.rejects(
      f.history.page({ cut: inheritedCut, after: childCut }),
      /not an ancestor/
    );
    assert.equal(stateText(await f.context.sessionState()), 'Original constraints');
    await f.update('child', 'old', 'Independent child');
    assert.equal((await f.sessions.currentSessionState(f.session, 'later')).id, 'later');
    assert.equal(stateText(await f.context.sessionState()), 'Independent child');
    const replay = await f.sessions.loadReplayState(f.session);
    assert.equal(replay.sessionState.id, 'child');
    assert.ok(!replay.branch.some((x) => x.id === 'later'));
    const nestedPoint = await f.context.transition({
      expectedWindowId: (await f.context.inspect()).window?.windowId ?? null,
      expectedSourceRevision: (await f.context.history.capture()).sourceRevision,
      selection: selectionFor(await f.context.protectedSources()),

      idempotencyKey: 'nested-point', reason: 'Nested historical boundary'

    }, admission);
    await f.sessions.branchFrom(f.session, nestedPoint.id, 'Nested fork');
    const repository = kind === 'jsonl'
      ? new JsonlSessionRepository(path.join(f.root, 'sessions')) : f.sessions;
    const reopened = new HistoryReader({ repository, session: f.session, artifacts: f.artifacts, events: f.events });
    assert.equal(await reopened.extendsCut(inheritedCut, await reopened.capture()), true);
    assert.ok((await reopened.page({ after: inheritedCut })).entries.length > 0);
    assert.equal((await reopened.selectedContext(await reopened.capture())).windowId,
      nestedPoint.window.windowId);
  });

  test(`${kind}: state and renewed window publish together only after admission`, async (t) => {
    const f = await fixture(t, kind);
    await f.update('old', null, 'Keep constraints');
    const previous = await f.context.transition({
      expectedWindowId: (await f.context.inspect()).window?.windowId ?? null,
      expectedSourceRevision: (await f.context.history.capture()).sourceRevision,
      selection: selectionFor(await f.context.protectedSources()),

      idempotencyKey: 'old-window',
      reason: 'Initial window'

    }, admission);
    const candidate = await stageState(f, {
      id: 'renewed',
      revisionId: 'old',
      inference: f.inference,
      text: 'Keep constraints; correction confirmed'
    });
    const request = {
      expectedWindowId: previous.window.windowId,
      idempotencyKey: 'renew',
      selection: selectionFor(),
      reason: 'Renewal'
    };
    await assert.rejects(
      f.context.transition({ ...request, sessionState: candidate }, {
        admit: async () => {
          throw new Error('Rejected next request');
        }
      }),
      /Rejected next request/
    );
    assert.equal((await f.context.sessionState()).revision.id, 'old');
    assert.equal((await f.context.inspect()).window.windowId, previous.window.windowId);
    const committed = await f.context.transition({ ...request, sessionState: candidate }, {
      admit: async (input) => {
        assert.equal(stateText(input.sessionState), 'Keep constraints; correction confirmed');
        return { compiledInputIdentity: 'new-input', capabilityRevision: 'test' };
      }
    });
    assert.equal((await f.context.sessionState()).revision.id, committed.id);
    assert.equal((await f.context.inspect()).window.windowId, committed.window.windowId);
    const inspection = await f.context.inspect();
    const historical = await f.history.read({
      source: inspection.sessionState.source,
      maxBytes: 1024
    });
    assert.deepEqual(JSON.parse(historical.item.text), contentFor('Keep constraints; correction confirmed'));
    assert.equal(historical.item.generated, true);
    assert.equal(historical.item.type, 'context_transition');
    if (kind === 'jsonl') {
      const reopened = new JsonlSessionRepository(path.join(f.root, 'sessions'));
      assert.equal((await reopened.currentSessionState(f.session)).id, committed.id);
    }

    const unchanged = await stageState(f, {
      id: 'no-change',
      revisionId: 'renewed',
      inference: f.inference,
      text: 'Keep constraints; correction confirmed'
    });
    assert.equal(unchanged.status, 'unchanged');
    await f.context.transition({
      expectedWindowId: (await f.context.inspect()).window?.windowId ?? null,
      expectedSourceRevision: (await f.context.history.capture()).sourceRevision,
      selection: selectionFor(await f.context.protectedSources()),

      idempotencyKey: 'unchanged-window',
      reason: 'Drop unnecessary originals'

    }, admission);
    assert.equal((await f.context.sessionState()).revision.id, 'renewed');
  });

  test(`${kind}: bounded original history recovers generated revisions without a notebook`, async (t) => {
    const f = await fixture(t, kind);
    const body = 'Useful rationale 文😀. '.repeat(500);
    await f.update('revision', null, body);
    const source = (await f.context.inspect()).sessionState.source;
    let offset = 0;
    let text = '';
    do {
      const result = await f.history.read({ source, offset, maxBytes: 96 });
      assert.equal(result.status, 'available');
      assert.equal(result.item.generated, true);
      assert.ok(Buffer.byteLength(result.item.text) <= 96);
      text += result.item.text;
      offset = result.nextOffset;
      if (offset === result.totalBytes) break;
    } while (true);
    assert.deepEqual(JSON.parse(text), contentFor(body));
    const search = await f.history.search({
      query: 'rationale',
      filter: { sourceType: 'context_transition' },
      maxScannedBytes: 64 * 1024
    });
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0].role, 'control');
    const journalOnly = new HistoryReader({ repository: f.sessions, session: f.session });
    const original = await journalOnly.read({ source, maxBytes: 64 * 1024 });
    assert.equal(original.status, 'available');
    assert.equal(original.item.generated, true);
    assert.deepEqual(JSON.parse(original.item.text), contentFor(body));
    f.sessions.loadReplayState = () => {
      throw new Error('Routine state reads must not replay history');
    };
    for (let i = 0; i < 30; i++)
      assert.equal((await f.context.sessionState()).revision.id, 'revision');
  });
}

test('incompatible working-state sessions are rejected without a version bump or data deletion', async (t) => {
  const f = await fixture(t, 'jsonl');
  const file = f.sessions.location(f.session.id);
  const header = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(header.version, 1);
  assert.equal(header.format, 'agent-core.session/2');
  delete header.sessionStateStorage;
  header.workingStateStorage = 'session';
  const old = `${JSON.stringify(header)}\n`;
  await writeFile(file, old);
  await assert.rejects(
    new JsonlSessionRepository(path.join(f.root, 'sessions')).open(f.session.id, binding),
    /Incompatible session format|saved messages/
  );
  assert.equal(await readFile(file, 'utf8'), old);
});

test('normal inference supplies expected revision and exact request attribution to the admitted context transition', async (t) => {
  const f = await fixture(t);
  const requests = [];
  const events = f.events;
  const provider = {
    id: 'fixture',
    implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture' }),
    describeModel: async () => ({
      id: 'fixture',
      provider: 'fixture',
      capabilities: {
        protocol: conservativeProtocolCapabilities('https://fixture.example', { contextReset: 'fresh_request', inputKinds: ['text', 'tool_call', 'tool_result'], toolChoice: ['auto', 'none', 'required', 'named'] }),
        streaming: false,
        toolCalling: true,
        supportedToolInputs: [{ kind: 'json' }],
        jsonMode: false,
        jsonSchema: false,
        logprobs: false,
        temperature: false,
        topP: false
      },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 100_000, outputTokens: 1024 },
      supportedParameters: ['tools', 'maxOutputTokens']
    }),
    complete: async (request) => {
      requests.push(request);
      return requests.length === 1
        ? {
            provider: 'fixture',
            model: 'fixture',
            content: '',
            terminationReason: 'tool_calls',
            toolCalls: [
              {
                type: 'function',
                id: 'update',
                name: 'context_transition',
                input: { kind: 'json', value: { sessionState: contentFor('Purpose and scoped feedback'), reason: 'Useful understanding' } }
              }
            ]
          }
        : {
            provider: 'fixture',
            model: 'fixture',
            content: 'Answered the current question.',
            terminationReason: 'stop'
          };
    }
  };
  const inference = InferenceService.inMemory({ provider });
  const runtime = new AgentRuntime({
    provider,
    model: 'fixture',
    context: f.context,
    inferenceService: inference,
    tools: [...f.context.toolDefinitions(), ...createHistoryTools({ history: f.history })],
    maxOutputTokens: 512,
    repositories: {
      events,
      artifacts: f.artifacts,
      session: { repository: f.sessions, descriptor: f.session }
    },
    toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
    toolPolicy: { allowedRisks: ['read', 'write'] }
  });
  const result = await runtime.run({ task: 'Explain the proposal.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.ok(requests[1].messages.some((x) => x.content?.includes('Purpose and scoped feedback')), JSON.stringify(requests[1].messages));
  const state = await f.context.sessionState();
  const original = JSON.parse(
    new TextDecoder().decode(
      await inference.options.artifacts.readVerified(state.revision.inference.requestRef)
    )
  );
  assert.equal(original.sessionStateRevisionId, null);
  assert.equal(
    original.logical.messages.some((x) => x.content === 'Explain the proposal.'),
    true
  );
  assert.equal(stateText(state), 'Purpose and scoped feedback');
  for await (const record of events.read(result.runId)) {
    if (record.event.type !== 'inference.request.fingerprinted') continue;
    const { sessionStateRevisionId, ...incompatible } = record.event.fingerprint;
    assert.ok(sessionStateRevisionId === null || typeof sessionStateRevisionId === 'string');
    assert.throws(
      () => agentEventCodec.decode({ ...record.event, fingerprint: incompatible }),
      /sessionStateRevisionId/
    );
  }
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: failed journal publication preserves state without staging artifacts`, async (t) => {
    const f = await fixture(t, kind);
    await f.update('old', null, 'Useful understanding');
    f.artifacts.storeProtected = async () => { throw new Error('State publication must not stage an artifact'); };
    const commit = f.sessions.commitContextTransition.bind(f.sessions);
    f.sessions.commitContextTransition = async () => {
      throw new Error('Journal append failed');
    };
    await assert.rejects(
      f.update('new', 'old', 'Correction'),
      /Journal append failed/
    );
    assert.equal(stateText(await f.context.sessionState()), 'Useful understanding');
    f.sessions.commitContextTransition = commit;
    assert.equal(
      (await f.update('new', 'old', 'Correction')).status,
      'committed'
    );
    assert.equal(stateText(await f.context.sessionState()), 'Correction');
  });
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: a fork before journal publication cannot publish a parent update on the child`, async (t) => {
    const f = await fixture(t, kind);
    await f.update('parent', null, 'Parent understanding');
    const branchPoint = await f.context.transition({
      expectedWindowId: (await f.context.inspect()).window?.windowId ?? null,
      expectedSourceRevision: (await f.context.history.capture()).sourceRevision,
      selection: selectionFor(await f.context.protectedSources()),

      idempotencyKey: 'stable-branch-point',
      reason: 'Stable boundary'

    }, admission);
    const stored = Promise.withResolvers();
    const release = Promise.withResolvers();
    const commit = f.sessions.commitContextTransition.bind(f.sessions);
    f.sessions.commitContextTransition = async (...args) => {
      stored.resolve();
      await release.promise;
      return commit(...args);
    };
    const update = f.update(
      'late-parent',
      'parent',
      'Unauthorized child understanding'
    );
    await stored.promise;
    await f.sessions.branchFrom(f.session, branchPoint.id, 'New child');
    release.resolve();
    assert.equal((await update).status, 'conflict');
    assert.equal((await f.context.sessionState()).revision.id, 'parent');
    assert.equal(stateText(await f.context.sessionState()), 'Parent understanding');
  });
}

test('captured state attribution validates its binding without imposing tool-JSON quotas on recorded input', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const requestRef = await artifacts.storeProtected({
    label: 'large-recorded-inference',
    mediaType: 'application/json',
    content: new TextEncoder().encode(
      JSON.stringify({
        sessionStateRevisionId: null,
        capturedHistoryCut: { format: 'agent-core.history/1', sessionId: 'session', branchId: 'session', throughEntryId: null, sourceRevision: 0, ledgerCoverage: 'session' },
        body: Array.from({ length: 25000 }, (_, i) => ({ original: i }))
      })
    )
  });
  const inference = new InferenceService({
    provider: {},
    artifacts,
    repository: { load: async () => ({ invocation: { start: { requestRef } } }) }
  });
  const origin = await inference.sessionStateOrigin('owner', 'invocation');
  assert.equal(origin.revisionId, null);
  assert.equal(origin.inference.requestRef, requestRef);
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: replacement removes obsolete claims, permits clearing, and leaves history intact`, async t => {
    const f = await fixture(t, kind);
    const obsolete = 'Earlier assumption\nUnverified guess';
    const corrected = 'Purpose 文😀\nConfirmed correction\nUnresolved question';
    await f.update('obsolete', null, obsolete);
    await f.update('corrected', 'obsolete', corrected);
    assert.equal(stateText(await f.context.sessionState()), corrected);
    assert.equal((await f.update('unchanged', 'corrected', corrected)).status, 'unchanged');
    assert.equal((await f.update('cleared', 'corrected', '')).status, 'committed');
    assert.equal(stateText(await f.context.sessionState()), '');
    const original = await f.sessions.currentSessionState(f.session, 'obsolete');
    assert.equal(original.content, undefined);
    assert.equal(original.contentSha256, hashJson(contentFor(obsolete)));
    const tools = f.context.toolDefinitions();
    assert.ok(tools.some(tool => tool.name === 'context_transition'));
    assert.ok(!tools.some(tool => tool.name === 'update_working_state'));
  });
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: idle selection cannot publish attributed session state without admission`, async t => {
    const f = await fixture(t, kind);
    const sessionState = await stageState(f, { id: 'unadmitted', revisionId: null,
      inference: f.inference, text: 'Not yet admitted' });
    const request = { expectedWindowId: null, idempotencyKey: 'unadmitted', reason: 'Attempt idle publication',
      selection: selectionFor(), sessionState };
    await assert.rejects(f.context.transition(request), /requires compiled next-request admission/);
    assert.equal((await f.context.sessionState()).revision, null);
    const { sessionState: _unadmitted, ...sourceOnly } = request;
    await assert.rejects(f.context.transition(sourceOnly), /requires compiled next-request admission/);
    assert.equal((await f.context.inspect()).window, null);
  });
}

test('standalone persisted working_state records are rejected without rewriting original data', async t => {
  const f = await fixture(t, 'jsonl');
  const file = f.sessions.location(f.session.id);
  const source = await readFile(file, 'utf8');
  const old = { type: 'working_state', id: 'retired-state', parentId: null, timestamp: new Date().toISOString(),
    previousRevisionId: null, inference: f.inference,
    contentRef: await f.artifacts.storeProtected({ label: 'old-state', mediaType: 'text/plain', content: new TextEncoder().encode('Original bytes') }) };
  const incompatible = source + JSON.stringify(old) + '\n';
  await writeFile(file, incompatible);
  await assert.rejects(new JsonlSessionRepository(path.join(f.root, 'sessions')).open(f.session.id, binding));
  assert.equal(await readFile(file, 'utf8'), incompatible);
});


test('session-state content is owned, immutable, optional-layered, and rejects legacy shapes', () => {
  const source = { sessionId: 's', entryId: 'e', sha256: 'a'.repeat(64) };
  const input = { interaction: [{ id: 'request', text: 'Answer the question', sources: [source] }],
    working: [{ id: 'notes', text: 'Freeform notes\nNo mandatory workflow', status: 'Still exploring', scope: 'This request' }] };
  const content = decodeSessionStateContent(input);
  input.working[0].text = 'Mutated';
  source.entryId = 'changed';
  assert.equal(content.working[0].text, 'Freeform notes\nNo mandatory workflow');
  assert.equal(content.interaction[0].sources[0].entryId, 'e');
  assert.ok(Object.isFrozen(content));
  assert.ok(Object.isFrozen(content.working));
  assert.ok(Object.isFrozen(content.working[0]));
  assert.ok(Object.isFrozen(content.interaction[0].sources));
  assert.deepEqual(decodeSessionStateContent({}), {});
  for (const invalid of ['old plain text', { text: 'old shape' }, { working: 'freeform string' },
    { working: [{ id: 'x', text: 'x', authority: true }] },
    { working: [{ id: 'x', text: 'x' }], trajectory: [{ id: 'x', text: 'duplicate' }] },
    { working: [{ id: 'x', text: 'x', status: 's'.repeat(257) }] }]) {
    assert.throws(() => decodeSessionStateContent(invalid));
  }
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: persisted session-state JSON remains structured with exact runtime attribution`, async t => {
    const f = await fixture(t, kind);
    const captured = await f.history.capture();
    await f.update('structured', null, 'Current interpretation');
    const state = await f.context.sessionState();
    assert.deepEqual(state.revision.capturedHistoryCut, captured);
    assert.deepEqual(state.revision.inference, f.inference);
    assert.equal(state.revision.contentRef, undefined);
    assert.equal(state.revision.inference.requestRef.visibility, 'protected');
    assert.equal(state.revision.content, undefined);
    assert.equal(state.revision.contentSha256, hashJson(state.content));
    assert.equal(state.revision.contentBytes, Buffer.byteLength(JSON.stringify(state.content)));
    assert.deepEqual(state.content,
      { working: [{ id: 'notes', text: 'Current interpretation' }] });
    assert.equal(state.revision.id, (await f.sessions.loadReplayState(f.session)).sessionState.id);
  });
}

test('large inline state remains journal-owned with bounded point-projection reads', async t => {
  const f = await fixture(t, 'jsonl');
  const body = 'x'.repeat(60000);
  await f.update('large-inline', null, body);
  const reopened = new JsonlSessionRepository(path.join(f.root, 'sessions'));
  const before = reopened.historyReadMetrics(f.session.id);
  const revision = await reopened.currentSessionState(f.session);
  assert.equal(revision.content, undefined);
  const metadata = reopened.historyReadMetrics(f.session.id);
  assert.equal(metadata.bodyRecordsRead - before.bodyRecordsRead, 0);
  const context = new ContextService({ repository: reopened, session: f.session, artifacts: f.artifacts,
    policy: { maxSourceBytes: 1024 * 1024 } });
  const state = await context.sessionState();
  const after = reopened.historyReadMetrics(f.session.id);
  assert.equal(state.content.working[0].text, body);
  assert.ok(after.bodyRecordsRead - before.bodyRecordsRead <= 2, 'Only the current committed entry is loaded');
  const history = new HistoryReader({ repository: reopened, session: f.session });
  const source = (await f.context.inspect()).sessionState.source;
  const original = await history.read({ source, maxBytes: 128 * 1024 });
  assert.equal(original.status, 'available');
  assert.deepEqual(JSON.parse(original.item.text), state.content);
});
