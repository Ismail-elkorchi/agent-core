import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { defineTool, invokePreparedToolCall, parseToolObservation, prepareToolCall, ResourceLeaseCoordinator, validateToolDefinition } from '@agent-core/tools';
import { scheduleToolCalls } from '@agent-core/runtime';
import {
  applyPatchTool,
  execCommandTool,
  findFilesTool,
  listDirectoryTool,
  readArtifactTool,
  readFilesTool,
  searchTextTool,
  stopProcessTool,
  viewImageTool,
  writeStdinTool
} from '@agent-core/tools-local';

const builtins = [listDirectoryTool, findFilesTool, readFilesTool, searchTextTool, applyPatchTool, execCommandTool, writeStdinTool, stopProcessTool, viewImageTool, readArtifactTool];

test('every built-in has a strict output schema and the final tool set is exact', () => {
  assert.deepEqual(builtins.map((tool) => tool.name), ['list_directory', 'find_files', 'read_files', 'search_text', 'apply_patch', 'exec_command', 'write_stdin', 'stop_process', 'view_image', 'read_artifact']);
  for (const tool of builtins) {
    assert.equal(typeof tool.outputSchema.safeParse, 'function', tool.name);
    assert.equal('risk' in tool, false, tool.name);
    assert.equal('declaredEffects' in tool, false, tool.name);
  }
});

test('derived effects cannot exceed their envelope and output is validated before persistence', async () => {
  const escape = defineTool({
    name: 'escape', implementationId: 'tests.escape.v1', description: 'escape', schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
    canonicalizeInput: (input) => input,
    deriveEffects: () => ({ accesses: [{ mode: 'write', scope: 'workspace/files/a' }], lockScopes: [], idempotency: 'pure' }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'bad', scope: { resources: [], coverage: 'complete' }, output: { value: 'x' } })
  });
  const controller = new AbortController();
  const context = { policy: { allowedRisks: ['read', 'write'] }, signal: controller.signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } };
  const prepared = await prepareToolCall({ name: 'escape', input: { kind: 'json', value: {} } }, [escape], context);
  assert.equal(prepared.ok, false);
  assert.match(prepared.observation.summary, /exceeds the tool effect envelope/u);

  const invalidOutput = defineTool({
    name: 'invalid_output', implementationId: 'tests.invalid-output.v1', description: 'invalid', schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
    effectEnvelope: { accesses: [], lockScopes: [] }, canonicalizeInput: (input) => input,
    deriveEffects: () => ({ accesses: [], lockScopes: [], idempotency: 'pure' }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'bad', scope: { resources: [], coverage: 'complete' }, output: { value: 42 } })
  });
  const validPreparation = await prepareToolCall({ name: 'invalid_output', input: { kind: 'json', value: {} } }, [invalidOutput], context);
  assert.equal(validPreparation.ok, true);
  const observation = await invokePreparedToolCall(validPreparation.prepared, context);
  assert.equal(observation.kind, 'failure');
  assert.equal(observation.output.reason, 'invalid_output');
});

test('scheduler uses resource accesses and locks, never idempotency, for conflicts', () => {
  const call = (callIndex, accesses, lockScopes = [], idempotency = 'pure', dependsOnCallIndices) => ({
    callIndex,
    effects: { accesses, lockScopes, idempotency, ...(dependsOnCallIndices ? { dependsOnCallIndices } : {}) },
    value: callIndex
  });
  const waves = scheduleToolCalls([
    call(0, [{ mode: 'read', scope: 'workspace/files/a' }], [], 'non_idempotent'),
    call(1, [{ mode: 'read', scope: 'workspace/files/a' }], [], 'non_idempotent'),
    call(2, [{ mode: 'write', scope: 'workspace/files/a' }]),
    call(3, [{ mode: 'read', scope: 'workspace/files/b' }], ['database/index']),
    call(4, [{ mode: 'read', scope: 'workspace/files/c' }], ['database/index']),
    call(5, [{ mode: 'read', scope: 'workspace/files/d' }], [], 'pure', [2])
  ], 8);
  assert.deepEqual(waves.map((wave) => wave.map((item) => item.callIndex)), [[0, 1, 3], [2, 4], [5]]);
});

test('runtime resource leases span batches until a running process exits', async () => {
  const coordinator = new ResourceLeaseCoordinator();
  const command = await coordinator.acquire({ accesses: [{ mode: 'execute', scope: 'workspace/processes/p1' }], lockScopes: ['workspace/files'], idempotency: 'non_idempotent' }, 'batch-1');
  command.transferToProcess('p1');
  let acquired = false;
  const blocked = coordinator.acquire({ accesses: [{ mode: 'read', scope: 'workspace/files/a' }], lockScopes: [], idempotency: 'pure' }, 'batch-2').then((lease) => { acquired = true; return lease; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(acquired, false);

  const control = await coordinator.acquire({ accesses: [{ mode: 'execute', scope: 'workspace/processes/p1' }], lockScopes: ['workspace/processes/p1'], idempotency: 'idempotent', idempotencyKey: 'stop:p1' }, 'batch-3');
  control.release();
  command.release();
  const released = await blocked;
  assert.equal(acquired, true);
  released.release();
  assert.equal(coordinator.activeCount(), 0);
});

test('one observation parser validates complete results, failures, artifacts, and returns an immutable snapshot', () => {
  const tool = defineTool({
    name: 'observation', implementationId: 'tests/observation@1', description: 'observation', schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
    effectEnvelope: { accesses: [], lockScopes: [] }, canonicalizeInput: (input) => input, deriveEffects: () => ({ accesses: [], lockScopes: [], idempotency: 'pure' }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'ok', scope: { resources: [], coverage: 'complete' }, output: { value: 'ok' } })
  });
  const source = { kind: 'result', ok: true, summary: 'ok', scope: { resources: ['workspace/files/a'], coverage: 'complete' }, output: { value: 'owned' }, metadata: { nested: ['value'] } };
  const parsed = parseToolObservation(tool, source);
  source.output.value = 'mutated'; source.metadata.nested[0] = 'mutated';
  assert.equal(parsed.output.value, 'owned');
  assert.equal(parsed.metadata.nested[0], 'value');
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.metadata), true);
  assert.throws(() => parseToolObservation(tool, { ...source, output: { value: 42 } }));
  assert.throws(() => parseToolObservation(undefined, { kind: 'failure', ok: false, summary: 'bad', scope: { resources: [], coverage: 'partial' }, output: { reason: 'runtime_error' } }));
  assert.throws(() => parseToolObservation(tool, { ...source, content: [{ type: 'artifact', artifact: { artifactId: 'bad', sha256: 'bad', size: -1, mediaType: 'text/plain' } }] }));
});

test('tool registration snapshots mutable consumer definition contracts', () => {
  const accesses = [{ mode: 'read', scope: 'workspace/files' }];
  const requirements = ['workspaceRoot'];
  const definition = defineTool({
    name: 'snapshot', implementationId: 'tests/snapshot@1', description: 'snapshot', schema: z.strictObject({}), outputSchema: z.strictObject({}), requirements: { services: requirements },
    effectEnvelope: { accesses, lockScopes: [] }, canonicalizeInput: (input) => input, deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [], idempotency: 'pure' }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'ok', scope: { resources: [], coverage: 'complete' }, output: {} })
  });
  accesses[0].mode = 'write'; requirements[0] = 'processManager';
  const registered = validateToolDefinition(definition);
  assert.equal(registered.effectEnvelope.accesses[0].mode, 'read');
  assert.deepEqual(registered.requirements.services, ['workspaceRoot']);
  assert.equal(Object.isFrozen(registered.effectEnvelope.accesses), true);
});
