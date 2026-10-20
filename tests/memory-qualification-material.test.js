import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { LocalArtifactRepository } from '@agent-core/persistence/node';
import {
  ContextService, HistoryReader, InMemoryMaterialGrantProvider, InMemoryMaterialRepository,
  InMemorySessionRepository, ScopedMaterialService
} from '@agent-core/runtime';
import { JsonlMaterialRepository, JsonlSessionRepository } from '@agent-core/runtime/node';
import { deferred } from './fixtures/collaboration-provider.mjs';
import { admitContext } from './context-admission-fixtures.js';

const binding = { schemaId: 'tests/memory-qualification-material', schemaVersion: 1,
  subject: { principalId: 'principal-a', conversationId: 'conversation-1' } };
const owner = Object.freeze({ kind: 'scope', scopeId: 'principal-a-private' });
const derivedOwner = Object.freeze({ kind: 'scope', scopeId: 'principal-a-activities' });

async function fixture(t, kind) {
  const directory = kind === 'jsonl' ? await mkdtemp(path.join(tmpdir(), 'memory-material-boundary-')) : undefined;
  const sessions = directory ? new JsonlSessionRepository({ rootDir: path.join(directory, 'sessions') }) : new InMemorySessionRepository();
  const repository = directory ? new JsonlMaterialRepository({ rootDir: path.join(directory, 'materials') }) : new InMemoryMaterialRepository();
  const artifacts = directory ? new LocalArtifactRepository({ rootDir: path.join(directory, 'artifacts') }) : new InMemoryArtifactRepository();
  const session = await sessions.create({ id: 'producer', binding });
  const history = new HistoryReader({ repository: sessions, session, artifacts });
  const grants = new InMemoryMaterialGrantProvider([owner, derivedOwner].map(value => ({
    owner: value, revision: 'grant-1', read: true, write: true
  })));
  const requestRef = await artifacts.storeProtected({ label: 'qualification-inference', content: Buffer.from('{}') });
  const create = (overrides = {}) => new ScopedMaterialService({ repository, artifacts, history,
    sessionRepository: sessions, session, grants,
    assertWrite: async batch => assert.deepEqual(batch.inference.requestRef, requestRef),
    authorizeTransfer: async () => {}, ...overrides });
  const batch = async (idempotencyKey, operations, target = owner) => {
    const cut = await history.capture();
    return { owner: target, idempotencyKey, branchId: cut.branchId, capturedHistoryCut: cut,
      inference: { ownerId: 'inference-owner', invocationId: 'inference-1', requestRef }, operations };
  };
  const reopen = async () => {
    if (!directory) return create();
    const nextSessions = new JsonlSessionRepository({ rootDir: path.join(directory, 'sessions') });
    const nextSession = await nextSessions.open(session.id, binding);
    const nextArtifacts = new LocalArtifactRepository({ rootDir: path.join(directory, 'artifacts') });
    const nextHistory = new HistoryReader({ repository: nextSessions, session: nextSession, artifacts: nextArtifacts });
    return create({ repository: new JsonlMaterialRepository({ rootDir: path.join(directory, 'materials') }),
      artifacts: nextArtifacts, sessionRepository: nextSessions, session: nextSession, history: nextHistory });
  };
  t.after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  return { directory, sessions, session, history, repository, artifacts, grants, create, batch, reopen, service: create() };
}

function qualify(ref, target = owner) { return { ...ref, owner: target }; }
const correction = f => f.sessions.appendSteering(f.session, {
  runId: 'producing-run', content: 'Correction: the preceding interpretation is obsolete.', deliveryId: 'correction-1'
});

for (const kind of ['memory', 'jsonl']) {
  test(`${kind}: correction accepted before shared publication rejects stale save after restart`, { timeout: 30000 }, async t => {
    const f = await fixture(t, kind);
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const original = f.sessions.withMaterialPublication.bind(f.sessions);
    t.mock.method(f.sessions, 'withMaterialPublication', async (...args) => {
      entered.resolve(); await release.promise; return original(...args);
    });
    const command = await f.batch('stale-save', [{ kind: 'create', text: 'An interpretation before correction' }]);
    const saving = f.service.save(command);
    // Attach rejection handling immediately: gates, not elapsed time, establish the order.
    const rejected = assert.rejects(saving, /correction|accepted input|stale/i);
    await entered.promise;
    await correction(f);
    release.resolve();
    await rejected;
    assert.equal((await (await f.reopen()).list(owner)).items.length, 0);
    await assert.rejects((await f.reopen()).save(command), /correction|accepted input|stale/i);
  });

  test(`${kind}: shared save committed before correction keeps its exact attributable prior revision`, { timeout: 30000 }, async t => {
    const f = await fixture(t, kind);
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const save = f.repository.save.bind(f.repository);
    const order = [];
    t.mock.method(f.repository, 'save', async value => {
      entered.resolve(); await release.promise;
      const receipt = await save(value); order.push('saved'); return receipt;
    });
    const command = await f.batch('prior-save', [{ kind: 'create', text: 'A historically attributed interpretation' }]);
    const saving = f.service.save(command);
    await entered.promise;
    const correcting = correction(f).then(() => { order.push('corrected'); });
    release.resolve();
    const receipt = await saving;
    await correcting;
    assert.deepEqual(order, ['saved', 'corrected']);
    const reopened = await f.reopen();
    const retained = await reopened.read(qualify(receipt.revisions[0]));
    assert.equal(retained.text, 'A historically attributed interpretation');
    const revision = await f.repository.read(qualify(receipt.revisions[0]));
    assert.deepEqual(revision.capturedHistoryCut, command.capturedHistoryCut);
    assert.deepEqual(await reopened.save(command), receipt, 'Lost receipt replay must not invent a corrected revision');
  });

  test(`${kind}: denied owner is checked before inventory, read, and dependency metadata`, async t => {
    const f = await fixture(t, kind);
    const saved = await f.service.save(await f.batch('private', [{ kind: 'create', text: 'Private relationship detail' }]));
    const ref = qualify(saved.revisions[0]);
    await f.grants.withdraw(owner, (await f.grants.get(owner)).revision);
    for (const method of ['list', 'read', 'revocationRevision', 'assertUsable']) {
      t.mock.method(f.repository, method, async () => assert.fail(`Unauthorized ${method} reached retained metadata`));
    }
    await assert.rejects(f.service.list(owner), /grant|access|unavailable|authorized/i);
    await assert.rejects(f.service.read(ref), /grant|access|unavailable|authorized/i);
    await assert.rejects(f.service.captureDependencies([ref]), /grant|access|unavailable|authorized/i);
    const scopes = await f.service.listScopes();
    assert.ok(scopes.items.every(item => item.owner.scopeId !== owner.scopeId));
    assert.doesNotMatch(JSON.stringify(scopes), /Private relationship detail/);
  });

  test(`${kind}: declared cross-scope derivatives inherit revocation through restart`, async t => {
    const f = await fixture(t, kind);
    const source = qualify((await f.service.save(await f.batch('source', [
      { kind: 'create', text: 'An earlier observation', subject: { personId: 'person-1', name: 'Alex' } }
    ]))).revisions[0]);
    const derivative = qualify((await f.service.save(await f.batch('derivative', [
      { kind: 'create', text: 'An interpretation based on that observation', dependencies: [source],
        subject: { personId: 'person-2', name: 'Alex' } }
    ], derivedOwner))).revisions[0], derivedOwner);
    const dependencies = await f.service.captureDependencies([derivative]);
    await f.service.assertDependencies(dependencies);
    await f.service.revoke({ owner, expectedRevision: 0, operationId: 'withdraw-source',
      refs: [{ itemId: source.itemId, revisionId: source.revisionId }] });
    const reopened = await f.reopen();
    await assert.rejects(reopened.read(derivative), /revo|access|unavailable/i);
    await assert.rejects(reopened.assertDependencies(dependencies), /revo|grant|access|unavailable|changed/i);
    await assert.rejects(reopened.list(derivedOwner), /revo|access|unavailable/i,
      'The derivative preview cannot disclose content whose declared source was revoked');
  });

  test(`${kind}: shared save-and-activate and mixed-owner batches reject before artifact writes`, async t => {
    const f = await fixture(t, kind);
    let writes = 0;
    const store = f.artifacts.storeProtected.bind(f.artifacts);
    t.mock.method(f.artifacts, 'storeProtected', async input => { writes++; return store(input); });
    const context = new ContextService({ repository: f.sessions, session: f.session, artifacts: f.artifacts,
      history: f.history, materials: { repository: f.repository, artifacts: f.artifacts, grants: f.grants },
      assertStateWrite: async () => {}, policy: { maxSourceBytes: 65536 } });
    await assert.rejects(context.stageSessionState(await f.batch('invalid-combined', [
      { kind: 'create', text: 'This cannot become a distributed atomic transaction' }
    ])), /owner|scope|atomic|session/i);
    assert.equal(writes, 0);
    await assert.rejects(f.service.save(await f.batch('mixed-owners', [
      { kind: 'create', text: 'First owner' },
      { kind: 'create', text: 'Second owner', owner: derivedOwner }
    ])));
    assert.equal(writes, 0);
    assert.equal((await f.service.list(owner)).items.length, 0);
  });

  test(`${kind}: material pages budget the complete grant-bound cursor and still make progress`, async t => {
    const f = await fixture(t, kind);
    await f.service.save(await f.batch('cursor-envelope', Array.from({ length: 12 }, () => ({ kind: 'create', text: 'x' }))));
    const one = await f.service.list(owner, { limit: 1, maxBytes: 8192 });
    assert.equal(one.items.length, 1);
    assert.equal(one.coverage, 'partial');
    const maxBytes = Buffer.byteLength(JSON.stringify(one));
    assert.ok(maxBytes >= 512);
    const first = await f.service.list(owner, { limit: 12, maxBytes });
    assert.ok(first.items.length > 0, 'A page known to fit one exact entry cannot report zero progress');
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= maxBytes);
    const seen = new Set(first.items.map(item => item.itemId));
    let page = first;
    while (page.coverage === 'partial') {
      assert.ok(page.cursor);
      page = await f.service.list(owner, { limit: 12, maxBytes, cursor: page.cursor });
      assert.ok(page.items.length > 0);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= maxBytes);
      for (const item of page.items) {
        assert.equal(seen.has(item.itemId), false, 'Pagination cannot duplicate a material item');
        seen.add(item.itemId);
      }
    }
    assert.equal(seen.size, 12);
  });

  test(`${kind}: omitting optional scope services on restart cannot resurrect revoked session material`, async t => {
    const f = await fixture(t, kind);
    const context = new ContextService({ repository: f.sessions, session: f.session, artifacts: f.artifacts,
      history: f.history, materials: { repository: f.repository, artifacts: f.artifacts, grants: f.grants },
      assertStateWrite: async () => {}, policy: { maxSourceBytes: 65536 } });
    const cut = await f.history.capture();
    const sessionOwner = { kind: 'session', sessionId: cut.sessionId, branchId: cut.branchId };
    const ref = (await context.saveSessionState(await f.batch('revoked-local', [
      { kind: 'create', text: 'REVOKED-LOCAL-PRIVATE-TEXT' }
    ], sessionOwner))).revisions[0];
    await f.service.revoke({ owner: sessionOwner, expectedRevision: 0, operationId: 'revoke-local-for-restart', refs: [ref] });
    const sessions = f.directory ? new JsonlSessionRepository({ rootDir: path.join(f.directory, 'sessions') }) : f.sessions;
    const session = await sessions.open(f.session.id, binding);
    const artifacts = f.directory ? new LocalArtifactRepository({ rootDir: path.join(f.directory, 'artifacts') }) : f.artifacts;
    const restarted = new ContextService({ repository: sessions, session, artifacts,
      policy: { maxSourceBytes: 65536 } });
    for (const operation of [() => restarted.readSessionState(ref), () => restarted.listSessionState(),
      () => restarted.searchSessionState({ query: 'REVOKED-LOCAL-PRIVATE-TEXT' }),
      () => restarted.selectedSessionState([ref])]) {
      const result = await operation().then(value => ({ value }), error => ({ error }));
      if (result.error) assert.match(result.error.message, /revoked|material|grant|authority|unavailable|scope/i);
      else {
        assert.doesNotMatch(JSON.stringify(result.value), /REVOKED-LOCAL-PRIVATE-TEXT/);
        assert.ok(!(result.value.items ?? result.value.matches ?? []).some(value => value.revisionId === ref.revisionId));
        assert.notEqual(result.value.revisionId, ref.revisionId);
      }
    }
  });

  test(`${kind}: revoking an inherited revision survives an earlier-leaf fork and owner aliases`, async t => {
    const f = await fixture(t, kind);
    const contextOptions = { repository: f.sessions, session: f.session, artifacts: f.artifacts,
      history: f.history, assertStateWrite: async () => {}, policy: { maxSourceBytes: 65536 } };
    const materialOptions = { repository: f.repository, artifacts: f.artifacts, grants: f.grants };
    const context = new ContextService({ ...contextOptions, materials: materialOptions });
    const cut = await f.history.capture();
    const originalOwner = { kind: 'session', sessionId: cut.sessionId, branchId: cut.branchId };
    const receipt = await context.saveSessionState(await f.batch('inherited-revocation', [
      { kind: 'create', text: 'REVOKED-INHERITED-PRIVATE-TEXT' }
    ], originalOwner));
    const ref = receipt.revisions[0];
    await f.sessions.branchFrom(f.session, receipt.entryId, 'Inherited before revocation');
    const childCut = await f.history.capture();
    const childOwner = { kind: 'session', sessionId: childCut.sessionId, branchId: childCut.branchId };
    assert.notEqual(childOwner.branchId, originalOwner.branchId);
    assert.equal((await f.service.read(qualify(ref, childOwner))).text, 'REVOKED-INHERITED-PRIVATE-TEXT');
    await f.service.revoke({ owner: childOwner, expectedRevision: 0,
      operationId: 'revoke-inherited-from-child', refs: [ref] });
    // The immutable revision predates both this revocation and the new branch marker.
    await f.sessions.branchFrom(f.session, receipt.entryId, 'Earlier leaf after revocation');
    const sessions = f.directory ? new JsonlSessionRepository({ rootDir: path.join(f.directory, 'sessions') }) : f.sessions;
    const session = await sessions.open(f.session.id, binding);
    const artifacts = f.directory ? new LocalArtifactRepository({ rootDir: path.join(f.directory, 'artifacts') }) : f.artifacts;
    const history = new HistoryReader({ repository: sessions, session, artifacts });
    const siblingCut = await history.capture();
    const siblingOwner = { kind: 'session', sessionId: siblingCut.sessionId, branchId: siblingCut.branchId };
    assert.notEqual(siblingOwner.branchId, childOwner.branchId);
    const reopened = await f.reopen();
    for (const alias of [originalOwner, childOwner, siblingOwner]) {
      await assert.rejects(reopened.read(qualify(ref, alias)), /revoked|material|grant|authority|unavailable|scope/i);
    }
    for (const includeMaterials of [false, true]) {
      const restarted = new ContextService({ repository: sessions, session, artifacts, history,
        ...(includeMaterials ? { materials: { ...materialOptions,
          repository: f.directory ? new JsonlMaterialRepository({ rootDir: path.join(f.directory, 'materials') }) : f.repository } } : {}),
        policy: { maxSourceBytes: 65536 } });
      for (const operation of [() => restarted.readSessionState(ref), () => restarted.listSessionState(),
        () => restarted.searchSessionState({ query: 'REVOKED-INHERITED-PRIVATE-TEXT' }),
        () => restarted.selectedSessionState([ref])]) {
        const result = await operation().then(value => ({ value }), error => ({ error }));
        if (result.error) assert.match(result.error.message, /revoked|material|grant|authority|unavailable|scope/i);
        else {
          const serialized = JSON.stringify(result.value);
          assert.doesNotMatch(serialized, /REVOKED-INHERITED-PRIVATE-TEXT/);
          assert.equal(serialized.includes(ref.revisionId), false, 'A branch alias cannot disclose revoked revision metadata');
        }
      }
    }
  });

  test(`${kind}: a branch change between dependency inspection and use invalidates the old local owner`, { timeout: 30000 }, async t => {
    const f = await fixture(t, kind);
    const context = new ContextService({ repository: f.sessions, session: f.session, artifacts: f.artifacts,
      history: f.history, assertStateWrite: async () => {}, policy: { maxSourceBytes: 65536 } });
    const cut = await f.history.capture();
    const originalOwner = { kind: 'session', sessionId: cut.sessionId, branchId: cut.branchId };
    const receipt = await context.saveSessionState(await f.batch('branch-use-boundary', [
      { kind: 'create', text: 'The exact local branch revision' }
    ], originalOwner));
    const ref = receipt.revisions[0];
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const original = f.sessions.withMaterialRevocations.bind(f.sessions);
    let intercepted = false;
    t.mock.method(f.sessions, 'withMaterialRevocations', async (...args) => {
      if (!intercepted) { intercepted = true; entered.resolve(); await release.promise; }
      return original(...args);
    });
    const reading = f.service.read(qualify(ref, originalOwner));
    const rejected = assert.rejects(reading, /branch|boundary|revoked|material|grant|authority|unavailable|scope/i);
    await entered.promise;
    await f.sessions.branchFrom(f.session, receipt.entryId, 'New branch invalidates old owner');
    release.resolve();
    await rejected;
    const next = await f.history.capture();
    assert.equal((await f.service.read(qualify(ref, {
      kind: 'session', sessionId: next.sessionId, branchId: next.branchId
    }))).text, 'The exact local branch revision', 'A fresh current-branch reference remains usable');
  });

  for (const publication of ['local save', 'activation']) {
    test(`${kind}: shared revocation winning before ${publication} prevents any partial publication`, { timeout: 30000 }, async t => {
      const f = await fixture(t, kind);
      const source = qualify((await f.service.save(await f.batch('publication-source', [
        { kind: 'create', text: 'Shared source for a future local publication' }
      ]))).revisions[0]);
      const context = new ContextService({ repository: f.sessions, session: f.session, artifacts: f.artifacts,
        history: f.history, assertStateWrite: async () => {}, policy: { maxSourceBytes: 65536 },
        materials: { repository: f.repository, artifacts: f.artifacts, grants: f.grants,
          authorizeTransfer: async () => {} } });
      const entered = deferred(), release = deferred();
      t.after(() => release.resolve());
      const method = publication === 'local save' ? 'saveSessionState' : 'commitContextTransition';
      const commit = f.sessions[method].bind(f.sessions);
      t.mock.method(f.sessions, method, async (...args) => {
        entered.resolve(); await release.promise; return commit(...args);
      });
      const cut = await f.history.capture();
      const sessionOwner = { kind: 'session', sessionId: cut.sessionId, branchId: cut.branchId };
      const publishing = publication === 'local save'
        ? context.saveSessionState(await f.batch('derived-local-publication', [
          { kind: 'create', text: 'Local interpretation of the shared source', dependencies: [source] }
        ], sessionOwner))
        : context.transition({ expectedWindowId: null, expectedSourceRevision: cut.sourceRevision,
          idempotencyKey: 'activation-loses-revocation', reason: 'Admit the exact shared material', renewal: true,
          selection: { retained: [], materials: [source] } }, { admit: admitContext });
      const rejected = assert.rejects(publishing, /revoked|revocation|unavailable|access|grant/i);
      await entered.promise;
      await f.service.revoke({ owner, expectedRevision: 0, operationId: 'publication-source-revoked',
        refs: [{ itemId: source.itemId, revisionId: source.revisionId }] });
      release.resolve();
      await rejected;
      assert.equal((await f.sessions.listSessionState(f.session)).items.length, 0);
      assert.equal(await f.history.selectedContext(), undefined);
      const reopened = await f.reopen();
      assert.equal((await reopened.list(sessionOwner)).items.length, 0);
    });
  }
}

test('expired async grant scopes cannot bypass a later held revocation fence', { timeout: 30000 }, async t => {
  const grants = new InMemoryMaterialGrantProvider([{ owner, revision: 'raw-grant', read: true, write: true }]);
  const revision = (await grants.get(owner)).revision;
  const launchChild = deferred(), childAttempted = deferred(), blockerEntered = deferred(), releaseBlocker = deferred();
  t.after(() => { launchChild.resolve(); releaseBlocker.resolve(); });
  let withdrawing;
  const order = [];
  await grants.withGrant(owner, revision, 'read', async () => {
    withdrawing = launchChild.promise.then(async () => {
      childAttempted.resolve();
      await grants.withdraw(owner, revision);
      order.push('withdrawn');
    });
  });
  const blocking = grants.withGrant(owner, revision, 'read', async () => {
    blockerEntered.resolve();
    await releaseBlocker.promise;
    order.push('guard-released');
  });
  await blockerEntered.promise;
  launchChild.resolve();
  await childAttempted.promise;
  // A scheduling barrier drains this in-memory promise chain; no elapsed-time condition controls the race.
  await setImmediate();
  assert.deepEqual([...order], [], 'Inherited async context is not live ownership after its guard returned');
  releaseBlocker.resolve();
  await Promise.all([blocking, withdrawing]);
  assert.deepEqual(order, ['guard-released', 'withdrawn']);
});
