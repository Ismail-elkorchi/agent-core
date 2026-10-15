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
/** Model-authored interpretation. IDs remain stable when revising the same item. */
export interface SessionStateItem {
  readonly id: string;
  readonly text: string;
  readonly sources?: readonly HistorySourceRef[] | undefined;
  readonly status?: string | undefined;
  readonly scope?: string | undefined;
}
/** All sections are optional; no domain ontology or workflow is imposed. */
export interface SessionStateContent {
  readonly interaction?: readonly SessionStateItem[] | undefined;
  readonly understanding?: readonly SessionStateItem[] | undefined;
  readonly working?: readonly SessionStateItem[] | undefined;
  readonly trajectory?: readonly SessionStateItem[] | undefined;
}
export const sessionStateItemSchema = z.strictObject({
  id: z.string().min(1).max(256),
  text: z.string().min(1).max(65536),
  sources: z.array(sourceSchema).max(256).readonly().optional(),
  status: z.string().min(1).max(256).optional(),
  scope: z.string().min(1).max(1024).optional()
}).readonly();
const sectionSchema = z.array(sessionStateItemSchema).max(256).readonly().optional();
export const sessionStateContentSchema = z.strictObject({
  interaction: sectionSchema,
  understanding: sectionSchema,
  working: sectionSchema,
  trajectory: sectionSchema
}).superRefine((content, context) => {
  const ids = new Set<string>();
  for (const [section, items] of Object.entries(content)) {
    for (const [index, item] of (items ?? []).entries()) {
      if (ids.has(item.id)) context.addIssue({ code: 'custom', path: [section, index, 'id'], message: 'Session-state item IDs must be unique across sections.' });
      ids.add(item.id);
    }
  }
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
  'Session state is your fallible interpretation, not authority or verification. Replace the bounded snapshot only when useful understanding changes. Optional interaction, understanding, working, and trajectory sections contain stable-ID items with text and optional source references, scope, and status in natural language. Omit irrelevant sections; working text can contain freeform notes. Preserve useful item IDs, revise contradicted claims, and remove obsolete material. Distinguish the current request from ongoing objectives: questions and hypotheticals do not authorize execution, run completion need not mean goal completion, and unresolved work does not authorize execution after unrelated requests. References support retrieval, not proof. Retrieve originals when detail matters; leave large material in history and artifacts.';
