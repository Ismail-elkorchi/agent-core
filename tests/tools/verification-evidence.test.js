import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArtifactRepository } from '@agent-core/evidence';
import { ContextManager, contextEvidenceExecution } from '@agent-core/runtime';

function evidence(id, summary = 'small') {
  return {
    id,
    observationId: `obs-${id}`,
    toolName: 'read_files',
    createdAt: '2026-08-09T00:00:00.000Z',
    action: 'read',
    resources: [{ uri: `workspace://${id}.txt` }],
    outcome: 'success',
    summary
  };
}

test('verification evidence advances over oversized first and final items with bounded stubs', async () => {
  const context = new ContextManager();
  const mutable = evidence('small');
  mutable.resources[0].uri = 'workspace://small.txt';
  context.recordEvidence([evidence('large-first', 'x'.repeat(300)), mutable, evidence('large-final', 'y'.repeat(300))]);
  mutable.resources[0].uri = 'workspace://mutated.txt';
  const reader = contextEvidenceExecution({ contextManager: context }).evidence;
  const first = await reader.read({ maxBytes: 220, limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].id, 'large-first');
  assert.equal(first.items[0].truncated, true);
  assert.equal(first.items[0].originalBytes > first.bytes, true);
  assert.equal(first.nextCursor, 'tool:1');

  const middle = await reader.read({ cursor: first.nextCursor, maxBytes: 500, limit: 1 });
  assert.equal(middle.items[0].id, 'small');
  assert.equal(middle.items[0].resources[0].uri, 'workspace://small.txt');
  assert.ok(Object.isFrozen(context.evidenceSnapshot()[1].resources[0]));
  assert.equal(middle.nextCursor, 'tool:2');
  const final = await reader.read({ cursor: middle.nextCursor, maxBytes: 220, limit: 1 });
  assert.equal(final.items[0].id, 'large-final');
  assert.equal(final.items[0].truncated, true);
  assert.equal(final.nextCursor, undefined);
  assert.equal(final.truncated, true);
});

test('verification owns external pages and routes public artifact ranges locally before external fallback', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const local = await artifacts.store({ label: 'local', content: new TextEncoder().encode('local artifact body'), mediaType: 'text/plain' });
  let externalArtifactReads = 0;
  const configured = {
    evidence: {
      async read() { return { items: [{ external: true }], bytes: 17, truncated: false }; },
      async readArtifact() { externalArtifactReads += 1; return new TextEncoder().encode('external artifact body'); }
    }
  };
  const execution = contextEvidenceExecution({ contextManager: new ContextManager(), artifacts, configured });
  assert.equal(new TextDecoder().decode(await execution.evidence.readArtifact(local, { maxBytes: 5 })), 'local');
  assert.equal(externalArtifactReads, 0);

  const external = { artifactId: `${'b'.repeat(64)}.txt`, sha256: 'b'.repeat(64), size: 22, mediaType: 'text/plain', visibility: 'public' };
  assert.equal(new TextDecoder().decode(await execution.evidence.readArtifact(external, { maxBytes: 8 })), 'external');
  assert.equal(externalArtifactReads, 1);
  const protectedRef = await artifacts.storeProtected({ label: 'raw', content: new TextEncoder().encode('raw'), mediaType: 'text/plain' });
  await assert.rejects(execution.evidence.readArtifact(protectedRef), /Protected artifacts/u);

  const externalPage = await execution.evidence.read();
  assert.deepEqual(externalPage.items, [{ external: true }]);
  const malformed = contextEvidenceExecution({
    contextManager: new ContextManager(),
    configured: { evidence: { async read() { return { items: [], bytes: -1, truncated: false }; }, async readArtifact() { return new Uint8Array(); } } }
  });
  await assert.rejects(malformed.evidence.read(), /invalid page/u);
});
