import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { InMemoryNoteRepository, createNotesTools } from '@agent-core/runtime';
import { readArtifactTool } from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from './tool-call-helpers.js';

test('a known artifact ID cannot bypass the host-bound note scope', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const notes = new InMemoryNoteRepository({ artifacts });
  const scope = { sessionId: 'notes-session', branchId: 'parent' };
  const result = await notes.write({
    scope,
    noteId: 'private-rationale',
    title: 'Branch rationale',
    mediaType: 'text/plain',
    content: 'This rationale belongs only to the parent branch.',
    expectedRevision: null,
    idempotencyKey: 'write-rationale',
    authorId: 'working-model',
    invocationId: 'parent-invocation'
  });
  assert.equal(result.status, 'committed');
  const artifact = result.revision.contentArtifact;
  assert.ok(artifact);

  const scoped = await invokeToolCall(
    jsonToolCall('notes_read', { noteId: 'private-rationale' }),
    createNotesTools({ repository: notes, scope }),
    { policy: { allowedRisks: ['read'] } }
  );
  assert.equal(scoped.kind, 'result');
  assert.match(JSON.stringify(scoped.output), /belongs only to the parent branch/u);
  assert.equal(
    (
      await notes.read({
        scope: { ...scope, branchId: 'unrelated' },
        noteId: 'private-rationale',
        revisionId: result.revision.revisionId
      })
    ).status,
    'missing'
  );

  const unscoped = await invokeToolCall(
    jsonToolCall('read_artifact', { artifactId: artifact.artifactId }),
    [readArtifactTool],
    { policy: { allowedRisks: ['read'] }, services: { artifactRepository: artifacts } }
  );
  assert.equal(
    unscoped.kind,
    'failure',
    'An artifact identifier does not grant access to a scoped note.'
  );
  assert.doesNotMatch(JSON.stringify(unscoped), /belongs only to the parent branch/u);
});
