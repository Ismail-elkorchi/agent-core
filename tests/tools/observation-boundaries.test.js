import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { InMemoryArtifactRepository } from '@agent-core/evidence';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ObservationStore } from '@agent-core/runtime';
import { defineTool, parseToolObservation } from '@agent-core/tools';

const tool = defineTool({
  name: 'large_observation', implementationId: 'tests/large-observation@1', description: 'large observation',
  schema: z.strictObject({}), outputSchema: z.strictObject({ chunks: z.array(z.string()) }),
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] }, canonicalizeInput: input => input,
  deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [], idempotency: 'pure' }),
  invoke: async () => ({ kind: 'result', ok: true, summary: 'unused', scope: { resources: ['memory'], coverage: 'complete' }, output: { chunks: [] } })
});
const call = { name: tool.name, input: { kind: 'json', value: {} } };

test('canonical result observations share one 8 MiB boundary before artifact extraction', async () => {
  for (const bytes of [0.5 * 1024 * 1024, 4.5 * 1024 * 1024, 7.5 * 1024 * 1024]) {
    const artifacts = new LocalArtifactRepository({ rootDir: await mkdtemp(path.join(tmpdir(), 'agent-core-observation-result-')) });
    const store = new ObservationStore({ artifacts });
    const chunks = chunksOf(Math.floor(bytes));
    const record = await commitAndProject(store, {
      turnIndex: 1, call, tool, modelInputModalities: ['text'],
      observation: { kind: 'result', ok: true, summary: 'large result', scope: { resources: ['memory'], coverage: 'complete' }, output: { chunks } }
    });
    assert.equal(record.durableObservation.kind, 'result');
    assert.equal(record.durableObservation.output.truncatedForPersistence, true);
    assert.ok(record.durableObservation.metadata.durableObservation.originalBytes >= bytes);
    const ref = record.durableObservation.metadata.durableObservation.artifact;
    assert.ok(ref.size >= bytes);
  }
  const store = new ObservationStore({ artifacts: new InMemoryArtifactRepository() });
  await assert.rejects(() => commitAndProject(store, {
    turnIndex: 1, call, tool, modelInputModalities: ['text'],
    observation: { kind: 'result', ok: true, summary: 'too large', scope: { resources: ['memory'], coverage: 'complete' }, output: { chunks: chunksOf(Math.floor(8.25 * 1024 * 1024)) } }
  }), /total byte limit|exceeds/iu);
});

test('oversized failure observations retain blocked semantics, recovery, reason, artifact, and original bytes', async () => {
  for (const bytes of [0.5 * 1024 * 1024, 4.5 * 1024 * 1024, 7.5 * 1024 * 1024]) {
    const artifacts = new LocalArtifactRepository({ rootDir: await mkdtemp(path.join(tmpdir(), 'agent-core-observation-failure-')) });
    const store = new ObservationStore({ artifacts });
    const record = await commitAndProject(store, {
      turnIndex: 1, call, tool: undefined, modelInputModalities: ['text'],
      observation: {
        kind: 'failure', ok: false, summary: 'large failure', scope: { resources: ['memory'], coverage: 'partial', causes: ['failure'] },
        output: { blocked: true, reason: 'runtime_error', error: 'effect returned a failure observation', recovery: 'Inspect the durable artifact.', details: { chunks: chunksOf(Math.floor(bytes)) } }
      }
    });
    assert.equal(record.durableObservation.output.blocked, true);
    assert.equal(record.durableObservation.output.reason, 'runtime_error');
    assert.equal(record.durableObservation.output.recovery, 'Inspect the durable artifact.');
    assert.equal(record.durableObservation.output.error, 'effect returned a failure observation');
    assert.ok(record.durableObservation.metadata.durableObservation.originalBytes >= bytes);
    assert.equal(record.durableObservation.metadata.durableObservation.artifact.visibility, 'public');
  }
  const store = new ObservationStore({ artifacts: new InMemoryArtifactRepository() });
  await assert.rejects(() => commitAndProject(store, {
    turnIndex: 1, call, tool: undefined,
    observation: { kind: 'failure', ok: false, summary: 'too large', scope: { resources: ['memory'], coverage: 'partial', causes: ['failure'] }, output: { blocked: true, reason: 'runtime_error', error: 'large', recovery: 'retry', details: { chunks: chunksOf(Math.floor(8.25 * 1024 * 1024)) } } }
  }), /total byte limit|exceeds/iu);
});

test('artifact-storage failure leaves a bounded terminal observation with an explicit degraded diagnostic', async () => {
  class FailingArtifacts extends InMemoryArtifactRepository { async store() { throw new Error('artifact disk unavailable'); } }
  const record = await commitAndProject(new ObservationStore({ artifacts: new FailingArtifacts() }), {
    turnIndex: 1, call, tool,
    observation: { kind: 'result', ok: true, summary: 'effect completed', scope: { resources: ['memory'], coverage: 'complete' }, output: { chunks: chunksOf(512 * 1024) } }
  });
  assert.match(record.durableStorageDegraded.message, /disk unavailable/u);
  assert.equal(record.durableObservation.metadata.durableStorage.status, 'degraded');
  assert.equal(record.durableObservation.output.truncatedForPersistence, true);
  assert.equal(record.durableObservation.metadata.durableObservation.storedAsArtifact, false);
});

test('observation projection invokes domain presenters independently for immediate and retained modes', async () => {
  const calls = [];
  const modeTool = defineTool({
    name: 'mode_presenter', implementationId: 'tests/mode-presenter@1', description: 'mode presenter',
    schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
    effectEnvelope: { accesses: [], lockScopes: [] },
    canonicalizeInput: input => input,
    deriveEffects: () => ({ accesses: [], lockScopes: [], idempotency: 'pure' }),
    invoke: async () => ({ kind: 'result', ok: true, summary: 'unused', scope: { resources: [], coverage: 'complete' }, output: { value: 'unused' } }),
    presentObservation(request) {
      calls.push({ mode: request.mode, maxTokens: request.maxTokens });
      return { ok: true, title: request.mode, summary: request.mode, results: { value: request.observation.output.value }, coverage: 'complete' };
    }
  });
  const store = new ObservationStore({ budgets: { immediate: 321, retained: 123 } });
  const modeCall = { name: modeTool.name, input: { kind: 'json', value: {} } };
  const record = await commitAndProject(store, {
    turnIndex: 1, call: modeCall, tool: modeTool,
    observation: { kind: 'result', ok: true, summary: 'done', scope: { resources: [], coverage: 'complete' }, output: { value: 'owned' } }
  });
  assert.deepEqual(calls, [{ mode: 'immediate', maxTokens: 321 }, { mode: 'retained', maxTokens: 123 }]);
  assert.equal(record.immediatePresentation.title, 'immediate');
  assert.equal(record.retainedPresentation.title, 'retained');
});

async function commitAndProject(store, input) {
  const { modelInputModalities, ...commitInput } = input;
  const committed = await store.commitToolObservation({
    ...commitInput,
    observation: parseToolObservation(commitInput.tool, commitInput.observation)
  });
  return store.projectToolObservation(committed, modelInputModalities);
}

function chunksOf(total) {
  const chunks = [];
  let remaining = total;
  while (remaining > 0) {
    const length = Math.min(3 * 1024 * 1024, remaining);
    chunks.push('x'.repeat(length));
    remaining -= length;
  }
  return chunks;
}
