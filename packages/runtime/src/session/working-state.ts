import { parseJsonObject } from '@agent-core/json';
import {
  decodeOwnedArtifactRef,
  PersistenceConflictError,
  type ProtectedArtifactRef
} from '@agent-core/persistence';
import * as z from 'zod';
import type { BaseSessionEntry, SessionBranchEntry } from './contracts.js';

/** Points to the exact already-recorded inference input, including native input extensions. */
export interface WorkingStateInference {
  readonly ownerId: string;
  readonly invocationId: string;
  readonly requestRef: ProtectedArtifactRef;
}
export interface WorkingStateChange {
  readonly id: string;
  readonly previousRevisionId: string | null;
  readonly contentRef: ProtectedArtifactRef;
  readonly inference: WorkingStateInference;
}
/** Derived live revision; only the enclosing context transition is persisted. */
export type WorkingStateRevision = BaseSessionEntry & WorkingStateChange;
export interface WorkingStateSnapshot {
  readonly revision: WorkingStateRevision | null;
  readonly text: string;
}

const protectedRef = z.unknown().transform((value) => {
  const ref = decodeOwnedArtifactRef(parseJsonObject(value));
  if (ref.visibility !== 'protected') throw new Error('Working-state artifacts must be protected.');
  return ref;
});
export const workingStateChangeSchema = z.strictObject({
  id: z.string().min(1),
  previousRevisionId: z.string().min(1).nullable(),
  contentRef: protectedRef,
  inference: z
    .strictObject({
      ownerId: z.string().min(1),
      invocationId: z.string().min(1),
      requestRef: protectedRef
    })
    .readonly()
});
/** Context renewal shares the session entry identity with its working-state publication. */
export function workingStateAtEntry(
  entry: SessionBranchEntry,
  inherited: WorkingStateRevision | null = null
): WorkingStateRevision | null {
  if (entry.type === 'context_transition' && entry.workingState)
    return Object.freeze({
      ...entry.workingState,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp
    });
  return inherited;
}

export function latestWorkingState(
  branch: readonly SessionBranchEntry[]
): WorkingStateRevision | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    const revision = entry && workingStateAtEntry(entry);
    if (revision) return revision;
  }
  return null;
}

export function assertWorkingStateRevision(
  current: WorkingStateRevision | null,
  expected: string | null
): void {
  if ((current?.id ?? null) !== expected)
    throw new PersistenceConflictError('Working state changed after the originating inference.');
}

export const WORKING_STATE_GUIDANCE =
  'Working state is your current fallible interpretation, not authority or verification. Update it only when useful understanding changes: purpose, constraints, decisions and reasons, feedback with its scope, findings with their evidence, unresolved work and useful references. No required sections or update after every exchange. Preserve useful relationships between immediate work and broader purposes without a fixed goal hierarchy. Distinguish the current conversational request from ongoing objectives; questions and hypotheticals do not authorize execution, run completion need not mean goal completion. A status request need not cancel unresolved work; unresolved work does not authorize execution after unrelated requests. Revise contradicted interpretations. Retrieve originals when detail matters; keep large material in history and artifacts.';
