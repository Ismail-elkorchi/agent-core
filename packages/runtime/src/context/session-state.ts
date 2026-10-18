import { decodeUtf8, hashJson, hashArtifactBytes, type ArtifactRepository } from '@agent-core/persistence';
import {
  SESSION_STATE_PREVIEW_BYTES, applySessionStateEdits, assertSessionStateItemRevision, sessionStateBatchSchema, sessionStateBatchStorageBytes, sessionStateLimitError, sessionStateRevisionIdentity, sessionStateItemIdentity,
  type SessionStateBatch, type SessionStateBatchCommit, type SessionStateItemRevision
} from '../session/session-state.js';
import type { HistoryReader } from '../history/reader.js';

/** Materialize only touched items. Publication and conditional checks belong to the repository. */
export async function stageSessionStateBatch(input: {
  readonly batch: SessionStateBatch;
  readonly artifacts: ArtifactRepository;
  readonly history: HistoryReader;
  readonly current: (itemId: string) => Promise<SessionStateItemRevision | undefined>;
  readonly maxMutationBytes: number;
  readonly maxStorageBytes: number;
  readonly committedRetainedBytes: number;
}): Promise<SessionStateBatchCommit> {
  const batch = sessionStateBatchSchema.parse(input.batch);
  if (batch.branchId !== batch.capturedHistoryCut.branchId) throw new Error('Session-state batch branch disagrees with inference capture.');
  await input.history.validateCut(batch.capturedHistoryCut);
  const fingerprint = hashJson(batch);
  const drafts: (Omit<SessionStateItemRevision, 'contentRef'> & { readonly text: string })[] = [];
  const touched = new Set<string>();
  let materializedBytes = Buffer.byteLength(JSON.stringify(batch));
  if (materializedBytes > input.maxMutationBytes) throw sessionStateLimitError('mutation_preparation', input.maxMutationBytes, materializedBytes, 'Session-state batch exceeds the mutation preparation byte limit.');
  for (const [index, operation] of batch.operations.entries()) {
    const itemId = operation.kind === 'create'
      ? sessionStateItemIdentity(batch.branchId, fingerprint, index) : operation.itemId;
    if (touched.has(itemId)) throw new Error('A session-state batch may touch an item only once.');
    touched.add(itemId);
    let text: string;
    let sources;
    if (operation.kind === 'create' || operation.kind === 'replace') {
      text = operation.text;
      sources = operation.sources;
    } else if (operation.kind === 'remove') text = '';
    else {
      const current = await input.current(itemId);
      assertSessionStateItemRevision(current, operation.expectedRevisionId, itemId);
      if (current.contentBytes > input.maxMutationBytes - materializedBytes)
        throw sessionStateLimitError('mutation_preparation', input.maxMutationBytes, materializedBytes + current.contentBytes, 'Session-state edit exceeds the mutation preparation byte limit.');
      materializedBytes += current.contentBytes;
      const prior = decodeUtf8(await input.artifacts.readVerified(current.contentRef));
      text = applySessionStateEdits(prior, operation.edits);
      sources = current.sources;
    }
    if (operation.kind !== 'create') assertSessionStateItemRevision(await input.current(itemId), operation.expectedRevisionId, itemId);
    for (const source of sources ?? [])
      if (!await input.history.metadata(source, batch.capturedHistoryCut))
        throw new Error('Session-state citation is unavailable at its captured inference boundary.');
    materializedBytes += Buffer.byteLength(text);
    if (materializedBytes > input.maxMutationBytes) throw sessionStateLimitError('mutation_preparation', input.maxMutationBytes, materializedBytes, 'Session-state batch exceeds the mutation preparation byte limit.');
    drafts.push(Object.freeze({
      itemId, revisionId: sessionStateRevisionIdentity(fingerprint, index),
      previousRevisionId: operation.kind === 'create' ? null : operation.expectedRevisionId,
      text, ...(text ? { preview: statePreview(text) } : {}), contentSha256: hashArtifactBytes(Buffer.from(text)), contentBytes: Buffer.byteLength(text),
      deleted: operation.kind === 'remove', ...(sources ? { sources } : {}),
      inference: batch.inference, capturedHistoryCut: batch.capturedHistoryCut
    }));
  }
  const metadata = { idempotencyKey: batch.idempotencyKey, branchId: batch.branchId, inference: batch.inference, capturedHistoryCut: batch.capturedHistoryCut };
  const lowerBound = drafts.reduce((sum, revision) => sum + revision.contentBytes, 0) + Buffer.byteLength(JSON.stringify({
    ...metadata, fingerprint, maxStorageBytes: input.maxStorageBytes,
    revisions: drafts.map(draft => Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'text')))
  }));
  if (input.committedRetainedBytes + lowerBound > input.maxStorageBytes)
    throw sessionStateLimitError('committed_retained_state', input.maxStorageBytes, input.committedRetainedBytes + lowerBound, 'Session-state retained revision storage quota exceeded; no content artifacts were staged.');
  const revisions: SessionStateItemRevision[] = [];
  for (const { text, ...revision } of drafts) {
    const contentRef = await input.artifacts.storeProtected({ label: 'session-state-item', mediaType: 'text/plain', content: Buffer.from(text) });
    if (contentRef.sha256 !== revision.contentSha256 || contentRef.size !== revision.contentBytes)
      throw new Error('Stored session-state content does not match the materialized revision.');
    revisions.push(Object.freeze({ ...revision, contentRef }));
  }
  const staged = Object.freeze({ ...metadata, revisions: Object.freeze(revisions), fingerprint, maxStorageBytes: input.maxStorageBytes });
  if (input.committedRetainedBytes + sessionStateBatchStorageBytes(staged) > input.maxStorageBytes)
    throw sessionStateLimitError('committed_retained_state', input.maxStorageBytes, input.committedRetainedBytes + sessionStateBatchStorageBytes(staged), 'Session-state retained revision storage quota exceeded; no items were saved.');
  return staged;
}

function statePreview(text: string): string {
  let preview = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > SESSION_STATE_PREVIEW_BYTES) break;
    preview += character; bytes += size;
  }
  return preview;
}
