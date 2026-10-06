import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { LocalArtifactRepository } from '@agent-core/persistence/node';
import {
  AgentRuntime,
  ContextService,
  HistoryReader,
  InMemorySessionRepository,
  InferenceService,
  agentEventCodec,
  createHistoryTools,
  createWorkingStateTool
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'tests/working-state', schemaVersion: 1, subject: {} };
async function fixture(t, kind = 'memory', maxSourceBytes = 1024 * 1024) {
  const root = await mkdtemp(path.join(tmpdir(), 'working-state-'));
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
  const history = new HistoryReader({ repository: sessions, session, artifacts });
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
      JSON.stringify({ workingStateRevisionId: null, logical: { model: 'fixture', messages: [] } })
    )
  });
  const inference = { ownerId: 'owner', invocationId: 'inference', requestRef };
  const update = async (id, revisionId, text) => {
    const cut = await history.capture();
    return context.updateWorkingState({
      id,
      revisionId,
      text,
      inference,
      sessionId: session.id,
      branchId: cut.branchId
    });
  };
  return { root, artifacts, sessions, session, context, history, inference, update };
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
    const head = await f.sessions.currentWorkingState(f.session);
    assert.equal(head.previousRevisionId, 'first');
    assert.equal(
      (await f.context.workingState()).text,
      head.id === 'left' ? 'Left interpretation' : 'Right interpretation'
    );
    assert.deepEqual(await f.update('first', null, 'Purpose 文😀'), first);
    await assert.rejects(
      f.update('first', null, 'Changed retry'),
      /different content/
    );
    const snapshot = await f.sessions.sourceSnapshot(f.session);
    assert.equal(snapshot.entries.filter((x) => x.type === 'working_state').length, 2);
    assert.equal((await f.sessions.readConversation(f.session)).length, 0);
    assert.equal(await f.artifacts.resolve(head.contentRef.artifactId), undefined);
    const unrelated = await f.sessions.create({ binding });
    const outsider = new HistoryReader({
      repository: f.sessions,
      session: unrelated,
      artifacts: f.artifacts
    });
    const source = (await f.context.inspect()).workingState.source;
    assert.equal((await outsider.read({ source })).reason, 'outside_scope');

    assert.equal((await f.update('stale', null, 'Lost constraints')).status, 'conflict');
  });

  test(`${kind}: forks inherit understanding at the selected historical point`, async (t) => {
    const f = await fixture(t, kind);
    await f.update('old', null, 'Original constraints');
    const point = await f.context.request({
      idempotencyKey: 'point',
      reason: 'Historical boundary'
    });
    await f.update('later', 'old', 'Later interpretation');
    const laterCut = await f.history.capture();
    await f.sessions.branchFrom(f.session, point.entry.id, 'Historical fork');
    const childCut = await f.history.capture();
    const inheritedCut = point.entry.window.historyPosition;
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
    assert.equal((await f.context.workingState()).text, 'Original constraints');
    await f.update('child', 'old', 'Independent child');
    assert.equal((await f.sessions.currentWorkingState(f.session, 'later')).id, 'later');
    assert.equal((await f.context.workingState()).text, 'Independent child');
    const replay = await f.sessions.loadReplayState(f.session);
    assert.equal(replay.workingState.id, 'child');
    assert.ok(!replay.branch.some((x) => x.id === 'later'));
    const nestedPoint = await f.context.request({
      idempotencyKey: 'nested-point', reason: 'Nested historical boundary'
    });
    await f.sessions.branchFrom(f.session, nestedPoint.entry.id, 'Nested fork');
    const repository = kind === 'jsonl'
      ? new JsonlSessionRepository(path.join(f.root, 'sessions')) : f.sessions;
    const reopened = new HistoryReader({ repository, session: f.session, artifacts: f.artifacts });
    assert.equal(await reopened.extendsCut(inheritedCut, await reopened.capture()), true);
    assert.ok((await reopened.page({ after: inheritedCut })).entries.length > 0);
    assert.equal((await reopened.selectedContext(await reopened.capture())).windowId,
      nestedPoint.entry.window.windowId);
  });

  test(`${kind}: state and renewed window publish together only after admission`, async (t) => {
    const f = await fixture(t, kind);
    await f.update('old', null, 'Keep constraints');
    const previous = await f.context.request({
      idempotencyKey: 'old-window',
      reason: 'Initial window'
    });
    const candidate = await f.context.stageWorkingState({
      id: 'renewed',
      revisionId: 'old',
      inference: f.inference,
      text: 'Keep constraints; correction confirmed'
    });
    const request = {
      expectedWindowId: previous.entry.window.windowId,
      idempotencyKey: 'renew',
      selection: { strategy: 'sources', retained: [] },
      reason: 'Renewal'
    };
    await assert.rejects(
      f.context.transition(request, {
        workingState: candidate,
        admit: async () => {
          throw new Error('Rejected next request');
        }
      }),
      /Rejected next request/
    );
    assert.equal((await f.context.workingState()).revision.id, 'old');
    assert.equal((await f.context.inspect()).window.windowId, previous.entry.window.windowId);
    const committed = await f.context.transition(request, {
      workingState: candidate,
      admit: async (input) => {
        assert.equal(input.workingState.text, 'Keep constraints; correction confirmed');
        return { compiledInputIdentity: 'new-input', capabilityRevision: 'test' };
      }
    });
    assert.equal((await f.context.workingState()).revision.id, committed.id);
    assert.equal((await f.context.inspect()).window.windowId, committed.window.windowId);
    const inspection = await f.context.inspect();
    const historical = await f.history.read({
      source: inspection.workingState.source,
      maxBytes: 1024
    });
    assert.equal(historical.item.text, 'Keep constraints; correction confirmed');
    assert.equal(historical.item.generated, true);
    assert.equal(historical.item.type, 'context_transition');
    if (kind === 'jsonl') {
      const reopened = new JsonlSessionRepository(path.join(f.root, 'sessions'));
      assert.equal((await reopened.currentWorkingState(f.session)).id, committed.id);
    }

    const unchanged = await f.context.stageWorkingState({
      id: 'no-change',
      revisionId: 'renewed',
      inference: f.inference,
      text: 'Keep constraints; correction confirmed'
    });
    assert.equal(unchanged.status, 'unchanged');
    await f.context.request({
      idempotencyKey: 'unchanged-window',
      reason: 'Drop unnecessary originals'
    });
    assert.equal((await f.context.workingState()).revision.id, 'renewed');
  });

  test(`${kind}: bounded original history recovers generated revisions without a notebook`, async (t) => {
    const f = await fixture(t, kind);
    const body = 'Useful rationale 文😀. '.repeat(500);
    await f.update('revision', null, body);
    const source = (await f.context.inspect()).workingState.source;
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
    assert.equal(text, body);
    const search = await f.history.search({
      query: 'rationale',
      filter: { sourceType: 'working_state' },
      maxScannedBytes: 64 * 1024
    });
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0].role, 'control');
    f.sessions.loadReplayState = () => {
      throw new Error('Routine state reads must not replay history');
    };
    for (let i = 0; i < 30; i++)
      assert.equal((await f.context.workingState()).revision.id, 'revision');
  });
}

test('incompatible notes-backed sessions are rejected without a version bump or data deletion', async (t) => {
  const f = await fixture(t, 'jsonl');
  const file = f.sessions.location(f.session.id);
  const header = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(header.version, 1);
  assert.equal(header.format, 'agent-core.session/2');
  delete header.workingStateStorage;
  const old = `${JSON.stringify(header)}\n`;
  await writeFile(file, old);
  await assert.rejects(
    new JsonlSessionRepository(path.join(f.root, 'sessions')).open(f.session.id, binding),
    /Incompatible session format/
  );
  assert.equal(await readFile(file, 'utf8'), old);
});

test('normal inference supplies expected revision and exact request attribution to the single update tool', async (t) => {
  const f = await fixture(t);
  const requests = [];
  const events = new InMemoryEventRepository(agentEventCodec);
  const provider = {
    id: 'fixture',
    implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture' }),
    describeModel: async () => ({
      id: 'fixture',
      provider: 'fixture',
      capabilities: {
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
                name: 'update_working_state',
                input: { kind: 'json', value: { text: 'Purpose and scoped feedback' } }
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
    tools: [createWorkingStateTool(f.context), ...createHistoryTools({ history: f.history })],
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
  assert.ok(requests[1].messages.some((x) => x.content?.includes('Purpose and scoped feedback')));
  const state = await f.context.workingState();
  const original = JSON.parse(
    new TextDecoder().decode(
      await inference.options.artifacts.readVerified(state.revision.inference.requestRef)
    )
  );
  assert.equal(original.workingStateRevisionId, null);
  assert.equal(
    original.logical.messages.some((x) => x.content === 'Explain the proposal.'),
    true
  );
  assert.equal(state.text, 'Purpose and scoped feedback');
  for await (const record of events.read(result.runId)) {
    if (record.event.type !== 'inference.request.fingerprinted') continue;
    const { workingStateRevisionId, ...incompatible } = record.event.fingerprint;
    assert.ok(workingStateRevisionId === null || typeof workingStateRevisionId === 'string');
    assert.throws(
      () => agentEventCodec.decode({ ...record.event, fingerprint: incompatible }),
      /workingStateRevisionId/
    );
  }
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: failed content storage or publication preserves the preceding usable state`, async (t) => {
    const f = await fixture(t, kind);
    await f.update('old', null, 'Useful understanding');
    const store = f.artifacts.storeProtected.bind(f.artifacts);
    f.artifacts.storeProtected = async () => {
      throw new Error('Artifact unavailable');
    };
    await assert.rejects(
      f.update('new', 'old', 'Correction'),
      /Artifact unavailable/
    );
    f.artifacts.storeProtected = store;
    const commit = f.sessions.commitWorkingState.bind(f.sessions);
    f.sessions.commitWorkingState = async () => {
      throw new Error('Journal append failed');
    };
    await assert.rejects(
      f.update('new', 'old', 'Correction'),
      /Journal append failed/
    );
    assert.equal((await f.context.workingState()).text, 'Useful understanding');
    f.sessions.commitWorkingState = commit;
    assert.equal(
      (await f.update('new', 'old', 'Correction')).status,
      'committed'
    );
    assert.equal((await f.context.workingState()).text, 'Correction');
  });
}

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: a fork during artifact storage cannot publish an authorized parent update on the child`, async (t) => {
    const f = await fixture(t, kind);
    await f.update('parent', null, 'Parent understanding');
    const branchPoint = await f.context.request({
      idempotencyKey: 'stable-branch-point',
      reason: 'Stable boundary'
    });
    const stored = Promise.withResolvers();
    const release = Promise.withResolvers();
    const store = f.artifacts.storeProtected.bind(f.artifacts);
    f.artifacts.storeProtected = async (input) => {
      const ref = await store(input);
      stored.resolve();
      await release.promise;
      return ref;
    };
    const update = f.update(
      'late-parent',
      'parent',
      'Unauthorized child understanding'
    );
    await stored.promise;
    await f.sessions.branchFrom(f.session, branchPoint.entry.id, 'New child');
    release.resolve();
    assert.equal((await update).status, 'conflict');
    assert.equal((await f.context.workingState()).revision.id, 'parent');
    assert.equal((await f.context.workingState()).text, 'Parent understanding');
  });
}

test('captured state attribution validates its binding without imposing tool-JSON quotas on recorded input', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const requestRef = await artifacts.storeProtected({
    label: 'large-recorded-inference',
    mediaType: 'application/json',
    content: new TextEncoder().encode(
      JSON.stringify({
        workingStateRevisionId: null,
        body: Array.from({ length: 25000 }, (_, i) => ({ original: i }))
      })
    )
  });
  const inference = new InferenceService({
    provider: {},
    artifacts,
    repository: { load: async () => ({ invocation: { start: { requestRef } } }) }
  });
  const origin = await inference.workingStateOrigin('owner', 'invocation');
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
    assert.equal((await f.context.workingState()).text, corrected);
    assert.equal((await f.update('unchanged', 'corrected', corrected)).status, 'unchanged');
    assert.equal((await f.update('cleared', 'corrected', '')).status, 'committed');
    assert.equal((await f.context.workingState()).text, '');
    const original = await f.sessions.currentWorkingState(f.session, 'obsolete');
    assert.equal(new TextDecoder().decode(await f.artifacts.readVerified(original.contentRef)), obsolete);
    const tool = createWorkingStateTool(f.context);
    assert.deepEqual(Object.keys(tool.jsonSchema.properties), ['text']);
  });
}
