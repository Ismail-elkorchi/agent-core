import assert from 'node:assert/strict';
import test from 'node:test';
import { materialRpcMethods } from '@agent-core/rpc';

const owner = { kind: 'scope', scopeId: 'private:person-1' };
const ref = { owner, itemId: 'item', revisionId: 'revision' };

test('material RPC uses the host-bound service and exact correction target without a second inventory', async () => {
  const calls = [];
  const methods = materialRpcMethods({
    materialService: () => ({
      currentSessionOwner: async () => ({ kind: 'session', sessionId: 'session', branchId: 'branch' }),
      listScopes: async page => { calls.push(['scopes', page]); return { items: [], coverage: 'complete' }; },
      list: async (...input) => { calls.push(['list', ...input]); return { items: [ref], coverage: 'complete', revocationRevision: 2 }; },
      read: async (...input) => { calls.push(['read', ...input]); return { ...ref, text: 'Original evidence' }; },
      revoke: async input => { calls.push(['revoke', input]); return { ...input, revision: 3 }; },
      erase: async () => { throw new Error('Physical material erasure is unsupported by this host'); }
    }),
    submitMaterialCorrection: async (...input) => { calls.push(['correct', ...input]); return { status: 'correction_submitted' }; }
  });
  assert.deepEqual(await methods['material.owner'].invoke({}), { kind: 'session', sessionId: 'session', branchId: 'branch' });
  await methods['material.scopes'].invoke({ limit: 2, maxBytes: 2048 });
  await methods['material.list'].invoke({ owner });
  assert.equal((await methods['material.read'].invoke({ ref, maxBytes: 4096 })).text, 'Original evidence');
  assert.deepEqual(await methods['material.correct'].invoke({ sessionId: 'session', ref, text: 'The event moved to Friday.' }), { status: 'correction_submitted' });
  assert.deepEqual(calls.at(-1), ['correct', ref, 'The event moved to Friday.', 'session']);
  await methods['material.revoke'].invoke({ owner, operationId: 'revoke-1', expectedRevision: 2, refs: [{ itemId: 'item', revisionId: 'revision' }] });
  assert.equal(calls.at(-1)[1].expectedRevision, 2);
  await assert.rejects(methods['material.erase'].invoke({ targets: [ref] }), /unsupported/);
  assert(!Object.keys(methods).some(name => /forget|wake|grant/.test(name)));
});

test('material RPC rejects unbounded and invented authority fields before invoking the host', async () => {
  let calls = 0;
  const methods = materialRpcMethods({ materialService: () => { calls++; throw new Error('should not run'); }, submitMaterialCorrection: async () => { calls++; } });
  for (const [name, value] of [
    ['material.scopes', { limit: 257 }],
    ['material.list', { owner: { kind: 'scope', scopeId: 'private', read: true } }],
    ['material.read', { ref, maxBytes: 2 ** 30 }],
    ['material.correct', { ref, text: 'Missing current session identity' }],
    ['material.erase', { targets: [] }],
    ['material.revoke', { owner, expectedRevision: -1, operationId: 'x', refs: [ref] }]
  ]) await assert.rejects(methods[name].invoke(value), error => error.code === -32602);
  assert.equal(calls, 0);
});
