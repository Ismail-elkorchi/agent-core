import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeSessionToolEffects } from '@agent-core/runtime';

function fixture() {
  let resolves = 0;
  const authority = { sessionId: 'session', branchId: 'branch', allowArtifactRead: true,
    artifacts: { async resolve(id) { resolves++; return id === 'known' ? { visibility: 'public' } : undefined; },
      readVerified() { assert.fail('Authorization must not read artifact bodies'); } } };
  const request = (accesses, lockScopes = []) => ({ effects: { accesses, lockScopes } });
  return { authority, request, resolves: () => resolves };
}

test('session effect grants are scoped to the exact session and branch', async () => {
  const f = fixture();
  for (const [mode, scope] of [['write', 'context/session/branch'], ['write', 'session_state/session/branch'], ['read', 'history/session/branch/entry']])
    assert.equal((await authorizeSessionToolEffects(f.request([{ mode, scope }]), f.authority)).decision, 'allow');
  for (const [mode, scope] of [['write', 'history/session/branch'], ['read', 'history/session/other'], ['write', 'context/other/branch'], ['write', 'session_state'], ['execute', 'context/session/branch']])
    assert.equal((await authorizeSessionToolEffects(f.request([{ mode, scope }]), f.authority)).decision, 'deny');
  assert.equal((await authorizeSessionToolEffects(f.request([], ['context/session/other']), f.authority)).decision, 'deny');
});

test('artifact selection requires an exact public artifact and explicit host read grant without reading its body', async () => {
  const f = fixture();
  const selection = f.request([{ mode: 'write', scope: 'context/session/branch' }, { mode: 'read', scope: 'artifacts/known' }], ['context/session/branch']);
  assert.equal((await authorizeSessionToolEffects(selection, { ...f.authority, allowArtifactRead: false })).decision, 'deny');
  assert.equal(f.resolves(), 0);
  assert.equal((await authorizeSessionToolEffects(selection, f.authority)).decision, 'allow');
  assert.equal(f.resolves(), 1);
  for (const mode of ['write', 'delete', 'execute', 'network'])
    assert.equal((await authorizeSessionToolEffects(f.request([{ mode, scope: 'artifacts/known' }]), f.authority)).decision, 'deny');
  assert.equal(f.resolves(), 1);
  for (const scope of ['artifacts', 'artifacts/unknown', 'artifacts/known/extra'])
    assert.equal((await authorizeSessionToolEffects(f.request([{ mode: 'read', scope }]), f.authority)).decision, 'deny');
  assert.equal((await authorizeSessionToolEffects(selection, { ...f.authority, artifacts: { resolve: async () => ({ visibility: 'protected' }) } })).decision, 'deny');
});
