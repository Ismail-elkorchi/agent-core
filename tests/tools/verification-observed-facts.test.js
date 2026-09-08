import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { agentEventCodec, createObservationAccess } from '@agent-core/runtime';

const runId = 'verification-run';
const createEvents = () => new InMemoryEventRepository(agentEventCodec);

async function recordFacts(events, records) {
  const presentation = { title: 'read_files', summary: 'Short presentation', ok: true, results: {} };
  await events.append(runId, {
    type: 'observation.record.created',
    id: 'observation-1',
    turnIndex: 1,
    turnId: 'turn-1',
    requestAttempt: 1,
    toolBatchId: 'batch-1',
    callIndex: 0,
    toolAttempt: 1,
    toolName: 'read_files',
    call: { name: 'read_files', input: { kind: 'json', value: {} } },
    toolCallType: 'function',
    observedFacts: records,
    immediatePresentation: presentation,
    retainedPresentation: presentation
  });
}

function observedFacts(id, summary = 'small') {
  return {
    id,
    observationId: `obs-${id}`,
    toolName: 'read_files',
    createdAt: '2026-08-09T00:00:00.000Z',
    action: 'read',
    resources: [{ uri: `rooted-file:///${id}.txt` }],
    outcome: 'success',
    summary
  };
}

test('verification observedFacts advances over oversized first and final items with bounded stubs', async () => {
  const events = createEvents();
  const mutable = observedFacts('small');
  mutable.resources[0].uri = 'rooted-file:///small.txt';
  await recordFacts(events, [
    observedFacts('large-first', 'x'.repeat(300)),
    mutable,
    observedFacts('large-final', 'y'.repeat(300))
  ]);
  mutable.resources[0].uri = 'rooted-file:///mutated.txt';
  const reader = createObservationAccess({ events, runId }).observedFacts;
  const first = await reader.read({ maxBytes: 220, limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].id, 'large-first');
  assert.equal(first.items[0].truncated, true);
  assert.equal(first.items[0].originalBytes > first.bytes, true);
  assert.equal(first.nextCursor, 'tool:1');

  const middle = await reader.read({ cursor: first.nextCursor, maxBytes: 500, limit: 1 });
  assert.equal(middle.items[0].id, 'small');
  assert.equal(middle.items[0].resources[0].uri, 'rooted-file:///small.txt');
  assert.ok(Object.isFrozen(middle.items[0].resources[0]));
  assert.equal(middle.nextCursor, 'tool:2');
  const final = await reader.read({ cursor: middle.nextCursor, maxBytes: 220, limit: 1 });
  assert.equal(final.items[0].id, 'large-final');
  assert.equal(final.items[0].truncated, true);
  assert.equal(final.nextCursor, undefined);
  assert.equal(final.truncated, true);
});

test('verification owns external pages and routes public artifact ranges locally before external fallback', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const local = await artifacts.store({
    label: 'local',
    content: new TextEncoder().encode('local artifact body'),
    mediaType: 'text/plain'
  });
  let externalArtifactReads = 0;
  const configured = {
    observedFacts: {
      async read() {
        return { items: [{ external: true }], bytes: 17, truncated: false };
      },
      async readArtifact() {
        externalArtifactReads += 1;
        return new TextEncoder().encode('external artifact body');
      }
    }
  };
  const execution = createObservationAccess({ events: createEvents(), runId, artifacts, configured });
  assert.equal(
    new TextDecoder().decode(await execution.observedFacts.readArtifact(local, { maxBytes: 5 })),
    'local'
  );
  assert.equal(externalArtifactReads, 0);

  const external = {
    artifactId: `${'b'.repeat(64)}.txt`,
    sha256: 'b'.repeat(64),
    size: 22,
    mediaType: 'text/plain',
    visibility: 'public'
  };
  assert.equal(
    new TextDecoder().decode(await execution.observedFacts.readArtifact(external, { maxBytes: 8 })),
    'external'
  );
  assert.equal(externalArtifactReads, 1);
  const protectedRef = await artifacts.storeProtected({
    label: 'raw',
    content: new TextEncoder().encode('raw'),
    mediaType: 'text/plain'
  });
  await assert.rejects(execution.observedFacts.readArtifact(protectedRef), /Protected artifacts/u);

  const externalPage = await execution.observedFacts.read();
  assert.deepEqual(externalPage.items, [{ external: true }]);
  const malformed = createObservationAccess({
    events: createEvents(),
    runId,
    configured: {
      observedFacts: {
        async read() {
          return { items: [], bytes: -1, truncated: false };
        },
        async readArtifact() {
          return new Uint8Array();
        }
      }
    }
  });
  await assert.rejects(malformed.observedFacts.read(), /invalid page/u);
});

test('verification reads complete committed facts after durable reopen independently of short presentations', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'committed-facts-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const events = new JsonlEventRepository({ rootDir, codec: agentEventCodec });
  const fact = observedFacts('nine-resources');
  fact.resources = Array.from({ length: 9 }, (_, index) => ({
    uri: `rooted-file:///${index}/${'long-name-'.repeat(60)}`
  }));
  fact.summary = 'Full summary '.repeat(40);
  fact.scope = {
    truncated: false,
    coverage: 'complete',
    filters: { exact: 'scope metadata '.repeat(200) }
  };
  await recordFacts(events, [fact]);
  const first = await createObservationAccess({ events, runId }).observedFacts.read();
  assert.deepEqual(first.items, [fact]);
  assert.equal(first.truncated, false);
  const reopened = new JsonlEventRepository({ rootDir, codec: agentEventCodec });
  const resumed = await createObservationAccess({ events: reopened, runId }).observedFacts.read();
  assert.deepEqual(resumed, first);
});

test('a failed observation recording is explicitly unavailable to verification', async () => {
  const events = createEvents();
  await events.append(runId, {
    type: 'observation.recording.failed',
    id: 'missing',
    turnIndex: 1,
    turnId: 'turn-1',
    requestAttempt: 1,
    toolBatchId: 'batch-1',
    callIndex: 0,
    toolAttempt: 1,
    toolName: 'read_files',
    message: 'artifact storage unavailable'
  });
  await assert.rejects(
    createObservationAccess({ events, runId }).observedFacts.read(),
    /Committed observation missing is unavailable/
  );
});
