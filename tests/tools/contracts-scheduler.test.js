import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { adoptToolDefinition, beginToolInvocation, createToolCall, defineTool, parseToolObservation, prepareToolCall, releasePreparedToolCall, releaseToolInvocation, ResourceLeaseCoordinator, startPreparedToolCall } from '@agent-core/tools';
import { issueEffectStartTicket, NO_EFFECT_EXPOSURE, startExternalEffect } from '@agent-core/effects';
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
import { invokePreparedForTest } from '../tool-call-helpers.js';

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
    deriveEffects: () => ({ accesses: [{ mode: 'write', scope: 'workspace/files/a' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'bad', scope: { resources: [], coverage: 'complete' }, output: { value: 'x' } })
  });
  const controller = new AbortController();
  const context = { policy: { allowedRisks: ['read', 'write'] }, signal: controller.signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } };
  const prepared = await prepareToolCall(createToolCall({ name: 'escape', input: { kind: 'json', value: {} } }), [escape], context);
  assert.equal(prepared.ok, false);
  assert.match(prepared.observation.summary, /exceeds the tool effect envelope/u);

  const invalidOutput = defineTool({
    name: 'invalid_output', implementationId: 'tests.invalid-output.v1', description: 'invalid', schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
    effectEnvelope: { accesses: [], lockScopes: [] }, canonicalizeInput: (input) => input,
    deriveEffects: () => ({ accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'bad', scope: { resources: [], coverage: 'complete' }, output: { value: 42 } })
  });
  const validPreparation = await prepareToolCall(createToolCall({ name: 'invalid_output', input: { kind: 'json', value: {} } }), [invalidOutput], context);
  assert.equal(validPreparation.ok, true);
  const observation = await invokePreparedForTest(validPreparation.prepared, context);
  assert.equal(observation.kind, 'failure');
  assert.equal(observation.output.reason, 'invalid_output');
});

test('tool preparation authority transfers once and releases every owned resource', async () => {
  let releases = 0;
  const tool = defineTool({
    name: 'lifetime', implementationId: 'tests.lifetime.v1', description: 'lifetime', schema: z.strictObject({}), outputSchema: z.strictObject({}),
    effectEnvelope: { accesses: [], lockScopes: [] },
    async canonicalizeInput(input, context) {
      await context.preparation.own({ release() { releases += 1; } });
      return input;
    },
    deriveEffects: () => ({ accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'done', scope: { resources: [], coverage: 'complete' }, output: {} })
  });
  const context = { policy: { allowedRisks: [] }, signal: new AbortController().signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } };
  const prepare = () => prepareToolCall(createToolCall({ name: tool.name, input: { kind: 'json', value: {} } }), [tool], context);
  const rejected = await prepare();
  assert.equal(rejected.ok, true);
  const staleEffect = effectFor(rejected.prepared, 1);
  assert.equal(startExternalEffect(staleEffect, staleEffect.ticket, 2).status, 'rejected');
  assert.equal(releases, 0);
  await releasePreparedToolCall(rejected.prepared);
  assert.equal(releases, 1);

  const accepted = await prepare();
  assert.equal(accepted.ok, true);
  const issued = effectFor(accepted.prepared, 3);
  const started = startExternalEffect(issued, issued.ticket, 3);
  assert.equal(started.status, 'started');
  const invocation = await startPreparedToolCall(accepted.prepared, started.state);
  const observation = await beginToolInvocation(invocation, context);
  assert.equal(observation.ok, true);
  assert.throws(() => beginToolInvocation(invocation, context), /single-use/u);
  await releaseToolInvocation(invocation);
  await releaseToolInvocation(invocation);
  assert.equal(releases, 2);
  await releasePreparedToolCall(accepted.prepared);
  const repeated = effectFor(accepted.prepared, 3);
  const repeatedStart = startExternalEffect(repeated, repeated.ticket, 3);
  assert.equal(repeatedStart.status, 'started');
  await assert.rejects(startPreparedToolCall(accepted.prepared, repeatedStart.state), /already transferred or been released/u);
});

test('aborted and failed preparation release resources before returning control', async () => {
  for (const mode of ['abort', 'invalid']) {
    let releases = 0;
    const controller = new AbortController();
    const tool = defineTool({
      name: `preparation_${mode}`, implementationId: `tests.preparation-${mode}.v1`, description: mode, schema: z.strictObject({}), outputSchema: z.strictObject({}),
      effectEnvelope: { accesses: [], lockScopes: [] },
      async canonicalizeInput(input, context) {
        await context.preparation.own({ release() { releases += 1; } });
        if (mode === 'abort') controller.abort('preparation cancelled');
        else throw new Error('canonicalization failed');
        return input;
      },
      deriveEffects: () => ({ accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }),
      invoke: async () => ({ kind: 'result', ok: true, summary: 'unused', scope: { resources: [], coverage: 'complete' }, output: {} })
    });
    const preparation = prepareToolCall(createToolCall({ name: tool.name, input: { kind: 'json', value: {} } }), [tool], {
      policy: { allowedRisks: [] }, signal: controller.signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' }
    });
    if (mode === 'abort') await assert.rejects(preparation, /preparation cancelled/u);
    else assert.equal((await preparation).ok, false);
    assert.equal(releases, 1, mode);
  }
});

function effectFor(prepared, generation) {
  const issued = issueEffectStartTicket({
    intent: {
      effectId: `effect-${String(generation)}`,
      operationId: 'operation',
      implementationId: prepared.toolImplementationId,
      parametersDigest: prepared.fingerprint,
      recovery: prepared.effects.recovery,
      exposure: NO_EFFECT_EXPOSURE
    },
    ticketId: `ticket-${String(generation)}`,
    settlementPermitId: `permit-${String(generation)}`,
    driverGeneration: generation,
    currentDriverGeneration: generation
  });
  assert.equal(issued.status, 'issued');
  return issued.state;
}

test('runtime resource leases span batches until a running process exits', async () => {
  const coordinator = new ResourceLeaseCoordinator();
  const command = await coordinator.acquire({ accesses: [{ mode: 'execute', scope: 'workspace/processes/p1' }], lockScopes: ['workspace/files'], recovery: { kind: 'unknown' } }, 'batch-1');
  command.transferToProcess('p1', 'workspace/processes/p1');
  assert.doesNotThrow(() => command.transferToProcess('p1', 'workspace/processes/p1'));
  assert.throws(() => command.transferToProcess('p1', 'workspace/processes/p2'), /already been transferred/u);
  let acquired = false;
  const blocked = coordinator.acquire({ accesses: [{ mode: 'read', scope: 'workspace/files/a' }], lockScopes: [], recovery: { kind: 'unknown' } }, 'batch-2').then((lease) => { acquired = true; return lease; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(acquired, false);

  const control = await coordinator.acquire({ accesses: [{ mode: 'execute', scope: 'workspace/processes/p1' }], lockScopes: ['workspace/processes/p1'], recovery: { kind: 'unknown' } }, 'batch-3');
  control.release();
  command.release();
  const released = await blocked;
  assert.equal(acquired, true);
  released.release();
  assert.equal(coordinator.activeCount(), 0);
});

test('resource lease queue is fair, batches compatible readers, and removes aborted waiters', async () => {
  const coordinator = new ResourceLeaseCoordinator();
  const read = { accesses: [{ mode: 'read', scope: 'workspace/files/a' }], lockScopes: [], recovery: { kind: 'unknown' } };
  const write = { accesses: [{ mode: 'write', scope: 'workspace/files/a' }], lockScopes: ['workspace/files/a'], recovery: { kind: 'unknown' } };
  const first = await coordinator.acquire(read, 'reader-1');
  const order = [];
  const writerPromise = coordinator.acquire(write, 'writer').then(lease => { order.push('writer'); return lease; });
  const laterReaderPromise = coordinator.acquire(read, 'reader-2').then(lease => { order.push('reader-2'); return lease; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(order, []);
  first.release();
  const writer = await writerPromise;
  assert.deepEqual(order, ['writer']);
  writer.release();
  const laterReader = await laterReaderPromise;
  assert.deepEqual(order, ['writer', 'reader-2']);
  laterReader.release();

  const compatibleA = await coordinator.acquire(read, 'compatible-a');
  const compatibleB = await coordinator.acquire(read, 'compatible-b');
  assert.equal(coordinator.activeCount(), 2);
  compatibleA.release(); compatibleB.release();

  const blocker = await coordinator.acquire(read, 'blocker');
  const controller = new AbortController();
  const aborted = coordinator.acquire(write, 'aborted-writer', controller.signal);
  const unblockedReader = coordinator.acquire(read, 'reader-after-abort');
  controller.abort('cancel waiter');
  await assert.rejects(aborted, /cancel waiter/u);
  const reader = await unblockedReader;
  blocker.release(); reader.release();
  assert.equal(coordinator.activeCount(), 0);
});

test('a queued writer cannot starve behind a continuing stream of readers', async () => {
  const coordinator = new ResourceLeaseCoordinator();
  const read = { accesses: [{ mode: 'read', scope: 'workspace/files/a' }], lockScopes: [], recovery: { kind: 'unknown' } };
  const write = { accesses: [{ mode: 'write', scope: 'workspace/files/a' }], lockScopes: ['workspace/files/a'], recovery: { kind: 'unknown' } };
  const initial = await coordinator.acquire(read, 'initial');
  let writerAcquired = false;
  const writerPromise = coordinator.acquire(write, 'writer').then(lease => { writerAcquired = true; return lease; });
  const laterReaders = Array.from({ length: 20 }, (_, index) => coordinator.acquire(read, `later-${index}`));
  initial.release();
  const writer = await writerPromise;
  assert.equal(writerAcquired, true);
  assert.equal(coordinator.activeCount(), 1);
  writer.release();
  for (const lease of await Promise.all(laterReaders)) lease.release();
});

test('one observation parser validates complete results, failures, artifacts, and returns an immutable snapshot', () => {
  const tool = defineTool({
    name: 'observation', implementationId: 'tests/observation@1', description: 'observation', schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
    effectEnvelope: { accesses: [], lockScopes: [] }, canonicalizeInput: (input) => input, deriveEffects: () => ({ accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }),
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
  assert.throws(() => parseToolObservation(tool, {
    ...source,
    evidence: { items: [{ action: 'read', outcome: 'success', resources: [{ uri: '' }], scope: { coverage: 'complete' } }] }
  }), /evidence.*URI|resource.*URI/iu);
  assert.throws(() => parseToolObservation(tool, {
    ...source,
    evidence: { items: [{ action: 'search', outcome: 'success', resources: [], scope: { coverage: 'complete', truncated: true } }] }
  }), /complete and truncated/iu);
  let outputGetterCalls = 0;
  const hostileOutput = Object.defineProperty({}, 'value', { enumerable: true, get() { outputGetterCalls += 1; return 'stolen'; } });
  assert.throws(() => parseToolObservation(tool, { ...source, output: hostileOutput }), /accessor/iu);
  assert.equal(outputGetterCalls, 0);
});

test('dynamic tool adoption snapshots mutable consumer definition contracts', () => {
  const accesses = [{ mode: 'read', scope: 'workspace/files' }];
  const requirements = ['workspaceRoot'];
  const definition = defineTool({
    name: 'snapshot', implementationId: 'tests/snapshot@1', description: 'snapshot', schema: z.strictObject({}), outputSchema: z.strictObject({}), requirements: { services: requirements },
    effectEnvelope: { accesses, lockScopes: [] }, canonicalizeInput: (input) => input, deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'ok', scope: { resources: [], coverage: 'complete' }, output: {} })
  });
  const registered = adoptToolDefinition(definition);
  accesses[0].mode = 'write'; requirements[0] = 'commandExecution';
  assert.equal(registered.effectEnvelope.accesses[0].mode, 'read');
  assert.deepEqual(registered.requirements.services, ['workspaceRoot']);
  assert.equal(Object.isFrozen(registered.effectEnvelope.accesses), true);
});

test('every effect and observation resource scope uses the strict canonical scope grammar', async () => {
  const malformedScopes = ['workspace/files//a', 'workspace/files/./a', 'workspace/files/../a', 'workspace\\files\\a', 'workspace/files/a/'];
  for (const scope of malformedScopes) {
    assert.throws(() => adoptToolDefinition({
      name: 'bad_scope', implementationId: 'tests/bad-scope@1', description: 'bad', jsonSchema: { type: 'object' }, outputSchema: z.strictObject({}),
      effectEnvelope: { accesses: [{ mode: 'read', scope }], lockScopes: [] }, decodeInput() { return { ok: true, input: {} }; },
      canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return { accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }; },
      async invoke() { return { kind: 'result', ok: true, summary: 'bad', scope: { resources: [], coverage: 'complete' }, output: {} }; }
    }), /scope/iu, scope);
  }
  const duplicate = defineTool({
    name: 'duplicate_scope', implementationId: 'tests/duplicate-scope@1', description: 'duplicate', schema: z.strictObject({}), outputSchema: z.strictObject({}),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files/a' }], lockScopes: [] }, canonicalizeInput: input => input,
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'workspace/files/a' }, { mode: 'read', scope: 'workspace/files/a' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'duplicate', scope: { resources: [], coverage: 'complete' }, output: {} })
  });
  const prepared = await prepareToolCall(createToolCall({ name: duplicate.name, input: { kind: 'json', value: {} } }), [duplicate], { policy: { allowedRisks: ['read'] }, signal: new AbortController().signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } });
  assert.equal(prepared.ok, false);
  assert.match(prepared.observation.summary, /unique/iu);
  assert.throws(() => parseToolObservation(duplicate, { kind: 'result', ok: true, summary: 'bad scope', scope: { resources: ['workspace/files//a'], coverage: 'complete' }, output: {} }), /scope/iu);
});

test('authoritative canonicalization owns input before effects, fingerprinting, and invocation', async () => {
  const callerOwned = { path: 'before.txt', nested: { value: 1 } };
  let invoked;
  const tool = defineTool({
    name: 'owned_input', implementationId: 'tests/owned-input@1', description: 'owned', schema: z.strictObject({}), outputSchema: z.strictObject({ path: z.string(), value: z.number() }),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
    canonicalizeInput() { return Object.freeze({ path: callerOwned.path, nested: Object.freeze({ value: callerOwned.nested.value }) }); },
    deriveEffects(input) { return { accesses: [{ mode: 'read', scope: `workspace/files/${input.path}` }], lockScopes: [], recovery: { kind: 'unknown' } }; },
    async invoke(input) { invoked = input; return { kind: 'result', ok: true, summary: 'owned', scope: { resources: [`workspace/files/${input.path}`], coverage: 'complete' }, output: { path: input.path, value: input.nested.value } }; }
  });
  const context = { policy: { allowedRisks: ['read'] }, signal: new AbortController().signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } };
  const preparation = await prepareToolCall(createToolCall({ name: tool.name, input: { kind: 'json', value: {} } }), [tool], context);
  assert.equal(preparation.ok, true);
  const fingerprint = preparation.prepared.fingerprint;
  callerOwned.path = 'after.txt'; callerOwned.nested.value = 2;
  const observation = await invokePreparedForTest(preparation.prepared, context);
  assert.equal(observation.output.path, 'before.txt');
  assert.equal(observation.output.value, 1);
  assert.equal(preparation.prepared.fingerprint, fingerprint);
  assert.equal(preparation.prepared.effects.accesses[0].scope, 'workspace/files/before.txt');
  assert.equal(Object.isFrozen(invoked), true);
  assert.equal(Object.isFrozen(invoked.nested), true);
});

test('canonicalization rejects accessors and cycles without invoking accessors', async () => {
  let accesses = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'secret', { enumerable: true, get() { accesses += 1; return 'value'; } });
  const cyclic = {}; cyclic.self = cyclic;
  const makeTool = (name, value) => defineTool({
    name, implementationId: `tests/${name}@1`, description: name, schema: z.strictObject({}), outputSchema: z.strictObject({}), effectEnvelope: { accesses: [], lockScopes: [] },
    canonicalizeInput() { return value; }, deriveEffects() { return { accesses: [], lockScopes: [], recovery: { kind: 'unknown' } }; },
    invoke: async () => ({ kind: 'result', ok: true, summary: 'never', scope: { resources: [], coverage: 'complete' }, output: {} })
  });
  for (const [name, value] of [['accessor_input', hostile], ['cyclic_input', cyclic]]) {
    const prepared = await prepareToolCall(createToolCall({ name, input: { kind: 'json', value: {} } }), [makeTool(name, value)], { policy: { allowedRisks: [] }, signal: new AbortController().signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } });
    assert.equal(prepared.ok, false);
  }
  assert.equal(accesses, 0);

  let effectAccesses = 0;
  const hostileEffects = {};
  Object.defineProperty(hostileEffects, 'accesses', { enumerable: true, get() { effectAccesses += 1; return []; } });
  Object.defineProperties(hostileEffects, { lockScopes: { enumerable: true, value: [] }, recovery: { enumerable: true, value: { kind: 'unknown' } } });
  const effectsTool = defineTool({
    name: 'hostile_effects', implementationId: 'tests/hostile-effects@1', description: 'hostile effects', schema: z.strictObject({}), outputSchema: z.strictObject({}),
    effectEnvelope: { accesses: [], lockScopes: [] }, canonicalizeInput: input => input, deriveEffects: () => hostileEffects,
    invoke: async () => ({ kind: 'result', ok: true, summary: 'never', scope: { resources: [], coverage: 'complete' }, output: {} })
  });
  const effectsPreparation = await prepareToolCall(createToolCall({ name: effectsTool.name, input: { kind: 'json', value: {} } }), [effectsTool], { policy: { allowedRisks: [] }, signal: new AbortController().signal, boundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } });
  assert.equal(effectsPreparation.ok, false);
  assert.equal(effectAccesses, 0);
});
