import assert from 'node:assert/strict';
import test from 'node:test';
import { contextRpcMethods } from '@agent-core/rpc';

test('context RPC requires an explicit selection and inspected cut; no renewal endpoint remains', async () => {
  const requests = [];
  const methods = contextRpcMethods({
    inspectContext: async () => ({}),
    freshContext: async () => ({}),
    transitionContext: async (request) => { requests.push(request); return { kind: 'scheduled', requestId: 'request' }; }
  });
  assert.equal(methods['context.renew'], undefined);
  const request = {
    expectedWindowId: null,
    expectedSourceRevision: 42,
    idempotencyKey: 'selection-1',
    reason: 'Explicit user selection',
    selection: { strategy: 'sources', retained: [] }
  };
  assert.deepEqual(await methods['context.transition'].invoke(request), { kind: 'scheduled', requestId: 'request' });
  assert.deepEqual(requests, [request]);
  for (const field of ['selection', 'expectedWindowId', 'expectedSourceRevision', 'idempotencyKey']) {
    const missing = { ...request };
    delete missing[field];
    await assert.rejects(methods['context.transition'].invoke(missing), error => error.code === -32602);
  }
  for (const field of ['toolInvocation', 'expectedCut'])
    await assert.rejects(methods['context.transition'].invoke({ ...request, [field]: {} }), error => error.code === -32602);
  assert.equal(requests.length, 1);
});
