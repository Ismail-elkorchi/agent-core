import { admitContext, admittedSelection } from './context-admission-fixtures.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
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
const admission = { admit: admitContext };
const selectionFor = (retained = []) => ({ retained });
const contentFor = text => ({ blocks: text ? [{ text }] : [] });
const stateText = state => state.content.blocks?.[0]?.text ?? '';
async function stageState(f, { id, revisionId, inference, text }) {
  const current = await f.context.sessionState();
  if ((current.revision?.id ?? null) !== revisionId) return { status: 'conflict' };
  if (stateText(current) === text) return { status: 'unchanged' };
  return { id, previousRevisionId: revisionId, inference,
    capturedHistoryCut: await f.context.history.capture(),
    content: contentFor(text) };
}
async function fixture(t, kind = 'memory', maxSourceBytes = 1024 * 1024, continuation = 'fresh') {
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
        ...(continuation === 'fresh' ? { renewal: true } : {}),
        selection: selectionFor()
      } };
      requests.set(id, request);
    }
    try {
      const entry = await context.transition(request.transition, {
        admit: async input => ({ compiledInputIdentity: `test-${id}`, capabilityRevision: 'fixture', selection: admittedSelection(input) })
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
      renewal: true,
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
      renewal: true,
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
      renewal: true,
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
      renewal: true,
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
        return { compiledInputIdentity: 'new-input', capabilityRevision: 'test', selection: admittedSelection(input) };
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
      renewal: true,
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

test('incompatible working-state headers are rejected without modifying original data', async (t) => {
  const f = await fixture(t, 'jsonl');
  const file = f.sessions.location(f.session.id);
  const header = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(header.version, 1);
  assert.equal(header.format, 'agent-core.session/4');
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

test('prior session format is rejected with its populated journal bytes intact', async (t) => {
  const f = await fixture(t, 'jsonl');
  await f.update('preserved-state', null, 'Original interpretation: 文😀\nKeep exact bytes.');
  const file = f.sessions.location(f.session.id);
  const current = await readFile(file);
  const headerEnd = current.indexOf(10);
  assert.ok(headerEnd > 0);
  const header = JSON.parse(current.subarray(0, headerEnd).toString('utf8'));
  assert.equal(header.format, 'agent-core.session/4');
  header.format = 'agent-core.session/3';
  const original = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), current.subarray(headerEnd + 1)]);
  await writeFile(file, original);
  // The existing index must not let an unsupported original header bypass validation.
  const reopened = new JsonlSessionRepository(path.join(f.root, 'sessions'));
  await assert.rejects(reopened.open(f.session.id, binding), /Incompatible session format|saved messages/);
  assert.deepEqual(await readFile(file), original);
  await assert.rejects(reopened.rebuildHistoryIndex(f.session.id, binding), /Incompatible session format|saved messages/);
  assert.deepEqual(await readFile(file), original);
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
      renewal: true,
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
      renewal: true,
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


test('narrative state is owned and immutable and preserves repeated blocks and exact source associations', () => {
  const source = { sessionId: 's', entryId: 'e', sha256: 'a'.repeat(64) };
  const text = 'Current question\n文😀\nQualification: still exploring; no mandatory workflow.';
  const input = { blocks: [{ text, sources: [source] }, { text }, { text }] };
  const content = decodeSessionStateContent(input);
  input.blocks[0].text = 'Mutated';
  source.entryId = 'changed';
  assert.deepEqual(content, { blocks: [{ text, sources: [{ sessionId: 's', entryId: 'e', sha256: 'a'.repeat(64) }] }, { text }, { text }] });
  assert.equal(JSON.parse(JSON.stringify(content)).blocks[0].text, text);
  assert.ok(Object.isFrozen(content));
  assert.ok(Object.isFrozen(content.blocks));
  assert.ok(Object.isFrozen(content.blocks[0]));
  assert.ok(Object.isFrozen(content.blocks[0].sources));
  assert.ok(Object.isFrozen(content.blocks[0].sources[0]));
  assert.deepEqual(decodeSessionStateContent({ blocks: [] }), { blocks: [] });
});

test('narrative state rejects malformed, unknown, and retired schema fields without aliases', () => {
  for (const invalid of [undefined, null, {}, 'old plain text', [], { text: 'old shape' },
    { blocks: 'freeform string' }, { blocks: [null] }, { blocks: [{ text: '' }] }, { blocks: [{ text: 1 }] },
    { blocks: [], unknown: true }, { blocks: [{ text: 'x', id: 'retired' }] },
    { blocks: [{ text: 'x', status: 'active' }] }, { blocks: [{ text: 'x', scope: 'request' }] },
    { blocks: [{ text: 'x', authority: true }] }, { blocks: [{ text: 'x', sources: 'not references' }] },
    ...['interaction', 'understanding', 'working', 'trajectory'].flatMap(section => [
      { [section]: [] }, { [section]: [{ id: 'old', text: 'Retired schema' }] }, { blocks: [], [section]: [] }
    ])]) assert.throws(() => decodeSessionStateContent(invalid));
});

test('narrative state enforces exact block, text, and reference bounds', () => {
  const source = { sessionId: 's', entryId: 'e', sha256: 'a'.repeat(64) };
  assert.equal(decodeSessionStateContent({ blocks: Array.from({ length: 1024 }, () => ({ text: 'Repeated narrative is valid.' })) }).blocks.length, 1024);
  assert.throws(() => decodeSessionStateContent({ blocks: Array.from({ length: 1025 }, () => ({ text: 'Too many blocks.' })) }));
  assert.equal(decodeSessionStateContent({ blocks: [{ text: 'x'.repeat(65536) }] }).blocks[0].text.length, 65536);
  assert.throws(() => decodeSessionStateContent({ blocks: [{ text: 'x'.repeat(65537) }] }));
  assert.equal(decodeSessionStateContent({ blocks: [{ text: 'Exact evidence.', sources: Array.from({ length: 256 }, () => source) }] }).blocks[0].sources.length, 256);
  assert.throws(() => decodeSessionStateContent({ blocks: [{ text: 'Too many references.', sources: Array.from({ length: 257 }, () => source) }] }));
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: aggregate UTF-8 state bound rejects many individually valid narrative blocks atomically`, async t => {
    const f = await fixture(t, kind, 1024);
    await f.update('bounded-initial', null, 'Preserve admitted interpretation.');
    const before = await f.context.inspect();
    const cut = await f.history.capture();
    const content = { blocks: Array.from({ length: 10 }, () => ({ text: '文'.repeat(80) })) };
    assert.doesNotThrow(() => decodeSessionStateContent(content));
    assert.ok(Buffer.byteLength(JSON.stringify(content), 'utf8') > 1024);
    assert.ok(JSON.stringify(content).length < 1024, 'The fixture distinguishes UTF-8 bytes from character count.');
    await assert.rejects(f.context.transition({ expectedWindowId: before.window.windowId,
      expectedSourceRevision: cut.sourceRevision, expectedSessionStateRevisionId: 'bounded-initial',
      renewal: true, selection: { retained: [] }, idempotencyKey: 'oversized-narrative', reason: 'Attempt oversized narrative',
      sessionState: { id: 'oversized-narrative', previousRevisionId: 'bounded-initial', content,
        capturedHistoryCut: cut, inference: f.inference }
    }, admission), /bound|byte|capacity|size/i);
    assert.equal((await f.context.sessionState()).revision.id, 'bounded-initial');
    assert.equal((await f.context.inspect()).window.windowId, before.window.windowId);
    assert.equal((await f.sessions.loadReplayState(f.session)).branch.filter(entry => entry.type === 'context_transition').length, 1);
  });
}

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
      { blocks: [{ text: 'Current interpretation' }] });
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
  assert.equal(state.content.blocks[0].text, body);
  assert.ok(after.bodyRecordsRead - before.bodyRecordsRead <= 2, 'Only the current committed entry is loaded');
  const history = new HistoryReader({ repository: reopened, session: f.session });
  const source = (await f.context.inspect()).sessionState.source;
  const original = await history.read({ source, maxBytes: 128 * 1024 });
  assert.equal(original.status, 'available');
  assert.deepEqual(JSON.parse(original.item.text), state.content);
});


for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: append publication failure before commit preserves state and retry publishes exactly once`, async t => {
    const f = await fixture(t, kind, 1024 * 1024, 'append');
    await f.update('append-initial', null, 'Initial understanding');
    const before = await f.context.inspect();
    const commit = f.sessions.commitContextTransition.bind(f.sessions);
    f.sessions.commitContextTransition = async () => { throw new Error('Crash before append commit'); };
    await assert.rejects(f.update('append-next', 'append-initial', 'Next understanding'), /Crash before append commit/);
    assert.equal((await f.context.sessionState()).revision.id, 'append-initial');
    assert.equal((await f.context.inspect()).window.windowId, before.window.windowId);
    f.sessions.commitContextTransition = commit;
    const published = await f.update('append-next', 'append-initial', 'Next understanding');
    assert.equal(published.status, 'committed');
    assert.deepEqual(await f.update('append-next', 'append-initial', 'Next understanding'), published);
    const records = (await f.sessions.loadReplayState(f.session)).branch.filter(entry => entry.type === 'context_transition');
    assert.equal(records.length, 2);
    assert.equal(records.at(-1).transition.strategy, 'append');
    assert.equal((await f.context.sessionState()).revision.id, 'append-next');
  });

  test(`${kind}: append lost publication receipt reconciles one immutable state revision and notice`, async t => {
    const f = await fixture(t, kind, 1024 * 1024, 'append');
    await f.update('receipt-initial', null, 'Initial interpretation');
    const commit = f.sessions.commitContextTransition.bind(f.sessions);
    let loseReceipt = true;
    f.sessions.commitContextTransition = async (...args) => {
      const result = await commit(...args);
      if (loseReceipt) { loseReceipt = false; throw new Error('Lost durable publication receipt'); }
      return result;
    };
    await assert.rejects(f.update('receipt-next', 'receipt-initial', 'Corrected interpretation'), /Lost durable publication receipt/);
    const afterCommit = await f.context.inspect();
    assert.equal((await f.context.sessionState()).revision.id, 'receipt-next');
    const recovered = await f.update('receipt-next', 'receipt-initial', 'Corrected interpretation');
    assert.equal(recovered.status, 'committed');
    assert.deepEqual(await f.context.inspect(), afterCommit);
    const records = (await f.sessions.loadReplayState(f.session)).branch.filter(entry => entry.type === 'context_transition');
    assert.equal(records.length, 2);
    assert.equal(records.at(-1).transition.strategy, 'append');
    assert.equal(records.filter(entry => entry.id === 'receipt-next' && entry.sessionState).length, 1);
    assert.equal(records.filter(entry => entry.window.stateSequence.notice?.revisionId === 'receipt-next').length, 1);
  });

  test(`${kind}: competing append corrections preserve a single CAS winner`, async t => {
    const f = await fixture(t, kind, 1024 * 1024, 'append');
    await f.update('cas-initial', null, 'Initial understanding');
    const outcomes = await Promise.all([
      f.update('cas-left', 'cas-initial', 'Left correction'),
      f.update('cas-right', 'cas-initial', 'Right correction')
    ]);
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['committed', 'conflict']);
    const records = (await f.sessions.loadReplayState(f.session)).branch.filter(entry => entry.type === 'context_transition');
    assert.equal(records.length, 2);
    assert.equal(records.at(-1).transition.strategy, 'append');
    const current = await f.context.sessionState();
    assert.equal(current.revision.previousRevisionId, 'cas-initial');
    assert.equal(stateText(current), current.revision.id === 'cas-left' ? 'Left correction' : 'Right correction');
  });
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: append successor admission failure and accepted correction cannot publish staged state`, async t => {
    const f = await fixture(t, kind, 1024 * 1024, 'append');
    await f.update('admission-initial', null, 'Original interpretation');
    const before = await f.context.inspect();
    const cut = await f.history.capture();
    const candidate = await stageState(f, { id: 'admission-next', revisionId: 'admission-initial',
      inference: f.inference, text: 'Staged interpretation' });
    const request = { expectedWindowId: before.window.windowId, expectedSourceRevision: cut.sourceRevision,
      expectedSessionStateRevisionId: 'admission-initial', expectedCut: cut, sessionState: candidate,
      idempotencyKey: 'admission-next', reason: 'Stage an append', selection: { retained: [] } };
    await assert.rejects(f.context.transition(request, { admit: async input => {
      assert.equal(input.strategy, 'append');
      assert.equal(stateText(input.sessionState), 'Staged interpretation');
      throw new Error('Exact compiled successor exceeds input limit');
    } }), /Exact compiled successor exceeds input limit/);
    assert.equal((await f.context.sessionState()).revision.id, 'admission-initial');
    assert.deepEqual(await f.context.inspect(), before);
    await assert.rejects(f.context.transition(request, { admit: async input => {
      await f.sessions.appendInput(f.session, { runId: 'correction', task: 'Accepted correction after staging.' });
      return { compiledInputIdentity: 'obsolete-successor', capabilityRevision: 'fixture', selection: admittedSelection(input) };
    } }), /changed|stale|conflict|boundary/i);
    assert.equal((await f.context.sessionState()).revision.id, 'admission-initial');
    const records = (await f.sessions.loadReplayState(f.session)).branch;
    assert.equal(records.filter(entry => entry.type === 'context_transition').length, 1);
    assert.ok(JSON.stringify(await f.sessions.readConversation(f.session)).includes('Accepted correction after staging.'));
  });
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: identical-state explicit renewal retries against its original boundary without creating a revision`, async t => {
    const f = await fixture(t, kind);
    await f.update('identical-initial', null, 'Unchanged interpretation');
    const cut = await f.history.capture();
    const request = {
      expectedWindowId: (await f.context.inspect()).window.windowId,
      expectedSourceRevision: cut.sourceRevision, expectedCut: cut,
      expectedSessionStateRevisionId: 'identical-initial',
      renewal: true, selection: { retained: [] }, idempotencyKey: 'identical-renewal', reason: 'Deliberate fresh continuation',
      sessionState: { id: 'proposed-identical', previousRevisionId: 'identical-initial', inference: f.inference,
        capturedHistoryCut: cut, content: contentFor('Unchanged interpretation') }
    };
    const renewed = await f.context.transition(request, admission);
    assert.equal(renewed.transition.strategy, 'fresh');
    assert.equal(renewed.sessionState, undefined);
    assert.equal((await f.context.sessionState()).revision.id, 'identical-initial');
    assert.deepEqual(await f.context.transition(request, admission), renewed);
    await f.update('identical-later', 'identical-initial', 'Later interpretation');
    assert.deepEqual(await f.context.transition(request, admission), renewed);
    assert.equal((await f.context.sessionState()).revision.id, 'identical-later');
    const records = (await f.sessions.loadReplayState(f.session)).branch.filter(entry => entry.type === 'context_transition');
    assert.equal(records.length, 3);
    assert.equal(records.filter(entry => entry.sessionState).length, 2);
    assert.equal(records.filter(entry => entry.window.stateSequence.notice).length, 0);
  });

  test(`${kind}: identical state cannot bypass the supplied previous-revision fence`, async t => {
    const f = await fixture(t, kind);
    await f.update('fenced-initial', null, 'Stable interpretation');
    const before = await f.context.inspect();
    const cut = await f.history.capture();
    await assert.rejects(f.context.transition({
      expectedWindowId: before.window.windowId, expectedSourceRevision: cut.sourceRevision,
      expectedSessionStateRevisionId: 'fenced-initial', renewal: true,
      selection: { retained: [] }, idempotencyKey: 'wrong-predecessor', reason: 'Attempt identical replacement',
      sessionState: { id: 'wrong-predecessor', previousRevisionId: null, inference: f.inference,
        capturedHistoryCut: cut, content: contentFor('Stable interpretation') }
    }, admission), /revision|conflict|stale/i);
    assert.deepEqual(await f.context.inspect(), before);
    assert.equal((await f.context.sessionState()).revision.id, 'fenced-initial');
  });
}
