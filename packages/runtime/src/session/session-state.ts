import { parseJsonObject } from '@agent-core/json';
import {
  decodeOwnedArtifactRef,
  hashJson,
  PersistenceConflictError,
  type ProtectedArtifactRef
} from '@agent-core/persistence';
import * as z from 'zod';
import type { HistorySourceCut, HistorySourceRef } from '../history/contracts.js';
import { historyCutSchema, sourceSchema } from '../history/schema.js';
import type { BaseSessionEntry, SessionBranchEntry } from './contracts.js';

/** Points to the exact already-recorded inference input, including native input extensions. */
export interface SessionStateInference {
  readonly ownerId: string;
  readonly invocationId: string;
  readonly requestRef: ProtectedArtifactRef;
}
/** A narrative interpretation with optional exact evidence associations. */
export interface SessionStateBlock {
  readonly text: string;
  readonly sources?: readonly HistorySourceRef[] | undefined;
}
/** One ordered narrative body; an empty block sequence explicitly clears it. */
export interface SessionStateContent {
  readonly blocks: readonly SessionStateBlock[];
}
const sessionStateBlockSchema = z.strictObject({
  text: z.string().min(1).max(65536),
  sources: z.array(sourceSchema).max(256).readonly().optional()
}).readonly();
export const sessionStateContentSchema = z.strictObject({
  blocks: z.array(sessionStateBlockSchema).max(1024).readonly()
}).readonly();

/** Establish an owned, immutable snapshot at the external/artifact boundary. */
export function decodeSessionStateContent(value: unknown): SessionStateContent {
  return sessionStateContentSchema.parse(value);
}

export interface SessionStateChange {
  readonly id: string;
  readonly previousRevisionId: string | null;
  readonly content: SessionStateContent;
  readonly inference: SessionStateInference;
  readonly capturedHistoryCut: HistorySourceCut;
  readonly declaredHistoryCut?: HistorySourceCut | undefined;
}
/** Derived live revision; only the enclosing context transition is persisted. */
export type SessionStateRevision = BaseSessionEntry & Omit<SessionStateChange, 'content'> & {
  readonly contentSha256: string;
  readonly contentBytes: number;
};
export interface SessionStateSnapshot {
  readonly revision: SessionStateRevision | null;
  readonly content: SessionStateContent;
}

const protectedRef = z.unknown().transform((value) => {
  const ref = decodeOwnedArtifactRef(parseJsonObject(value));
  if (ref.visibility !== 'protected') throw new Error('Session-state artifacts must be protected.');
  return ref;
});
export const sessionStateChangeSchema = z.strictObject({
  id: z.string().min(1),
  previousRevisionId: z.string().min(1).nullable(),
  content: sessionStateContentSchema,
  capturedHistoryCut: historyCutSchema,
  declaredHistoryCut: historyCutSchema.optional(),
  inference: z
    .strictObject({
      ownerId: z.string().min(1),
      invocationId: z.string().min(1),
      requestRef: protectedRef
    })
    .readonly()
});
/** Context renewal shares the session entry identity with its session-state publication. */
export function sessionStateAtEntry(
  entry: SessionBranchEntry,
  inherited: SessionStateRevision | null = null
): SessionStateRevision | null {
  if (entry.type === 'context_transition' && entry.sessionState) {
    const { content, ...change } = entry.sessionState;
    return Object.freeze({
      ...change,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      contentSha256: hashJson(content),
      contentBytes: Buffer.byteLength(JSON.stringify(content))
    });
  }
  return inherited;
}

export function latestSessionState(
  branch: readonly SessionBranchEntry[]
): SessionStateRevision | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    const revision = entry && sessionStateAtEntry(entry);
    if (revision) return revision;
  }
  return null;
}

export function assertSessionStateRevision(
  current: SessionStateRevision | null,
  expected: string | null
): void {
  if ((current?.id ?? null) !== expected)
    throw new PersistenceConflictError('Session state changed after the originating inference.');
}

export const SESSION_STATE_GUIDANCE =
  'Session state is your fallible interpretation, not authority or verification. Replace the bounded snapshot only when useful understanding changes. Use an ordered blocks array containing narrative text and optional exact source references. Express headings, qualifications, working notes, uncertainties, and trajectory naturally in text. Revise contradicted claims and remove obsolete material through full replacement. Omit sessionState to leave it unchanged; supply {blocks:[]} to clear current interpretation. Distinguish the current request from ongoing objectives: questions and hypotheticals do not authorize execution, run completion need not mean goal completion, and unresolved work does not authorize execution after unrelated requests. References support retrieval, not proof. Retrieve originals when detail matters; leave large material in history and artifacts.';
