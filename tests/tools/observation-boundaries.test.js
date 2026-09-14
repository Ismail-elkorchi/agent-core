import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import {
  ObservationStore,
  resolveToolObservation,
  resolveToolModelContent,
  agentEventCodec
} from '@agent-core/runtime';
import {
  defineTool,
  parseToolObservation,
  decodeOwnedToolObservationForPersistence,
  createToolCall
} from '@agent-core/tools';

const tool = defineTool({
  name: 'source',
  implementationId: 'tests/source',
  description: 'Read original source',
  schema: z.strictObject({}),
  outputSchema: z.json(),
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'source' }], lockScopes: [] },
  canonicalizeInput: (input) => input,
  deriveEffects: () => ({
    accesses: [{ mode: 'read', scope: 'source' }],
    lockScopes: [],
    recovery: { kind: 'unknown' }
  }),
  invoke: async () => ({
    kind: 'result',
    summary: 'Read',
    scope: { resources: ['source'], coverage: 'complete' },
    output: {}
  })
});
const call = createToolCall({ name: tool.name, input: { kind: 'json', value: {} } });
const observation = (output, extras = {}) =>
  parseToolObservation(tool, {
    kind: 'result',
    summary: 'Original source',
    scope: { resources: ['source'], coverage: 'complete' },
    output,
    ...extras
  });

test('large originals and exact delivered content resolve independently without field guessing', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const store = new ObservationStore({ artifacts });
  const original = {
    unusualDomainField: 'original quotation\n'.repeat(24000),
    other: { detail: 'retained' }
  };
  const committed = await store.commitToolObservation({
    turnIndex: 1,
    call,
    tool,
    observation: observation(original)
  });
  assert.equal(committed.original.storage, 'artifact');
  assert.deepEqual((await resolveToolObservation(committed.original, artifacts)).output, original);
  const projected = await store.projectToolObservation(committed);
  assert.ok(
    projected.modelText.includes(original.unusualDomainField.slice(0, 40).replaceAll('\n', '\\n'))
  );
  assert.deepEqual(
    await resolveToolModelContent({ modelContentRef: committed.modelContentRef }, artifacts),
    committed.modelContent
  );
  await assert.rejects(resolveToolObservation(committed.original), /unavailable/);
  await assert.rejects(
    resolveToolObservation(
      {
        ...committed.original,
        artifact: { ...committed.original.artifact, sha256: 'a'.repeat(64) }
      },
      artifacts
    )
  );
});

test('content is selected once before settlement and reused even when formatter changes', async () => {
  let count = 0;
  const formatter = {
    ...tool,
    buildModelContent: ({ observation }) => [
      { type: 'text', text: `${++count}:${observation.output}` }
    ]
  };
  const store = new ObservationStore();
  const committed = await store.commitToolObservation({
    turnIndex: 1,
    call,
    tool: formatter,
    observation: observation('exact')
  });
  formatter.buildModelContent = () => {
    throw new Error('new formatter');
  };
  assert.equal((await store.projectToolObservation(committed)).modelText, '1:exact');
  assert.equal((await store.projectToolObservation(committed)).modelText, '1:exact');
  assert.equal(count, 1);
});

test('storage and formatter failures preserve the actual observation and known lifecycle', async () => {
  class Unavailable extends InMemoryArtifactRepository {
    async store() {
      throw new Error('disk unavailable');
    }
  }
  const value = observation(
    { diagnostic: 'x'.repeat(300000), outcome: 'uncertain' },
    { execution: { state: 'unknown' } }
  );
  const committed = await new ObservationStore({
    artifacts: new Unavailable()
  }).commitToolObservation({
    turnIndex: 1,
    call,
    tool: {
      ...tool,
      buildModelContent() {
        throw new Error('display');
      }
    },
    observation: value
  });
  assert.equal(committed.original.storage, 'unavailable');
  assert.equal(committed.original.execution.state, 'unknown');
  assert.equal(committed.durableObservation, undefined);
  assert.equal(committed.fullObservation, undefined);
  assert(committed.original.bytes > 300000);
  assert.match(committed.durableStorageDegraded.message, /disk unavailable/);
});

test('obsolete observation and failure contracts are rejected without migration', () => {
  assert.throws(() => parseToolObservation(tool, { ...observation({}), ok: true }), /unsupported/);
  assert.throws(
    () =>
      decodeOwnedToolObservationForPersistence({
        kind: 'failure',
        summary: 'failed',
        scope: { resources: [], coverage: 'partial' },
        output: {
          reason: 'runtime_error',
          error: 'lost response',
          blocked: true,
          recovery: 'retry'
        }
      }),
    /unsupported/
  );
  assert.throws(
    () =>
      agentEventCodec.decode({
        type: 'tool.ended',
        turnIndex: 1,
        turnId: 't',
        requestAttempt: 1,
        toolBatchId: 'b',
        callIndex: 0,
        toolAttempt: 1,
        toolName: 'source',
        observation: {
          kind: 'result',
          summary: 'old',
          scope: { resources: [], coverage: 'complete' },
          output: {}
        }
      }),
    /Incompatible|identity/
  );
});

test('image selection discloses unavailable modality and retains original artifact access', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const artifact = await artifacts.store({
    label: 'image',
    content: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png'
  });
  const store = new ObservationStore({ artifacts });
  const committed = await store.commitToolObservation({
    turnIndex: 1,
    call,
    tool,
    modelInputModalities: ['text'],
    observation: observation(
      { description: 'image' },
      { content: [{ type: 'image', artifact, detail: 'original' }] }
    )
  });
  const record = await store.projectToolObservation(committed);
  assert.equal(record.modelImages.length, 0);
  assert.ok(record.modelContent.some((part) => part.type === 'artifact'));
  assert.match(record.modelText, /image|Image/);
});
