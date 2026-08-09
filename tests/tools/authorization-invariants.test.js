import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { defineTool, enforceAllowedEffects, prepareToolCall } from '@agent-core/tools';
import { applyPatchTool, DEFAULT_LOCAL_TOOL_CONFIGURATION } from '@agent-core/tools-local';

const boundary = { authorizationPolicyId: 'tests/authorization@1', executionTargetId: 'workspace' };
const signal = new AbortController().signal;

async function prepared(call, tools, policy, services = {}) {
  const result = await prepareToolCall(call, tools, { policy, services, signal, boundary });
  assert.equal(result.ok, true, result.ok ? '' : result.observation.summary);
  return result.prepared;
}

function request(call, preparedCall, policy, services = {}) {
  return { call, tool: preparedCall.tool, input: preparedCall.canonicalInput, effects: preparedCall.effects, fingerprint: preparedCall.fingerprint, context: { policy, services, signal, boundary } };
}

test('a read-only policy denies a writing apply_patch call before approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-authorization-'));
  const call = { name: 'apply_patch', input: { kind: 'text', value: '*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch' } };
  const policy = { allowedRisks: ['read'] };
  const services = { workspaceRoot: root, localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION };
  const preparedCall = await prepared(call, [applyPatchTool], policy, services);
  const denial = enforceAllowedEffects(request(call, preparedCall, policy, services));
  assert.deepEqual(denial.decision, 'deny');
  assert.match(denial.reason, /write/u);
});

test('an allowed write may require approval but approval never adds a denied risk', async () => {
  const writeTool = defineTool({
    name: 'write', implementationId: 'tests/write@1', description: 'write', schema: z.strictObject({}), outputSchema: z.strictObject({}),
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'workspace/files/a' }], lockScopes: [] },
    canonicalizeInput: (input) => input,
    deriveEffects: () => ({ accesses: [{ mode: 'write', scope: 'workspace/files/a' }], lockScopes: [], idempotency: 'idempotent', idempotencyKey: 'write-a' }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'written', scope: { resources: ['workspace/files/a'], coverage: 'complete' }, output: {} })
  });
  const call = { name: 'write', input: { kind: 'json', value: {} } };
  const allowedPolicy = { allowedRisks: ['read', 'write'] };
  const allowed = await prepared(call, [writeTool], allowedPolicy);
  assert.equal(enforceAllowedEffects(request(call, allowed, allowedPolicy)), undefined);
  const approvalDecision = enforceAllowedEffects(request(call, allowed, allowedPolicy)) ?? { decision: 'require_approval', reason: 'confirm write' };
  assert.equal(approvalDecision.decision, 'require_approval');

  const deniedPolicy = { allowedRisks: ['read'] };
  const denied = enforceAllowedEffects(request(call, allowed, deniedPolicy));
  assert.equal(denied.decision, 'deny');
});

test('delete may require approval only when destructive authority is already allowed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-delete-approval-'));
  const call = { name: 'apply_patch', input: { kind: 'text', value: '*** Begin Patch\n*** Delete File: delete.txt\n*** End Patch' } };
  const services = { workspaceRoot: root, localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION };
  const allowedPolicy = { allowedRisks: ['read', 'write', 'destructive'] };
  const allowed = await prepared(call, [applyPatchTool], allowedPolicy, services);
  assert.equal(enforceAllowedEffects(request(call, allowed, allowedPolicy, services)), undefined);
  const approval = enforceAllowedEffects(request(call, allowed, allowedPolicy, services)) ?? { decision: 'require_approval', reason: 'confirm delete' };
  assert.equal(approval.decision, 'require_approval');

  const writeOnlyPolicy = { allowedRisks: ['read', 'write'] };
  const denial = enforceAllowedEffects(request(call, allowed, writeOnlyPolicy, services));
  assert.equal(denial.decision, 'deny');
  assert.match(denial.reason, /delete|destructive/iu);
});

test('a mixed-access call is denied when any one derived access is prohibited', async () => {
  const mixed = defineTool({
    name: 'mixed', implementationId: 'tests/mixed@1', description: 'mixed', schema: z.strictObject({}), outputSchema: z.strictObject({}),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files/a' }, { mode: 'network', scope: 'network/example.com' }], lockScopes: [] },
    canonicalizeInput: (input) => input,
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'workspace/files/a' }, { mode: 'network', scope: 'network/example.com' }], lockScopes: [], idempotency: 'non_idempotent' }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'done', scope: { resources: ['workspace/files/a'], coverage: 'complete' }, output: {} })
  });
  const call = { name: 'mixed', input: { kind: 'json', value: {} } };
  const policy = { allowedRisks: ['read'] };
  const preparedCall = await prepared(call, [mixed], policy);
  const denial = enforceAllowedEffects(request(call, preparedCall, policy));
  assert.equal(denial.decision, 'deny');
  assert.match(denial.reason, /network/u);
});
