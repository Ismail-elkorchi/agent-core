import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { defineTool, invokePreparedToolCall, prepareToolCall } from '@agent-core/tools';
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
