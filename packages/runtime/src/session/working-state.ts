import { parseJsonObject } from '@agent-core/json';
import {
  decodeOwnedArtifactRef,
  hashJson,
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
export type SessionWorkingStateEntry = BaseSessionEntry &
  WorkingStateChange & {
    readonly type: 'working_state';
  };
export interface WorkingStateSnapshot {
  readonly revision: SessionWorkingStateEntry | null;
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
export const workingStateEntrySchema = workingStateChangeSchema
  .extend({
    type: z.literal('working_state'),
    parentId: z.string().min(1).nullable(),
    timestamp: z.string().min(1)
  })
  .readonly();

/** Context renewal shares the session entry identity with its working-state publication. */
export function workingStateAtEntry(
  entry: SessionBranchEntry,
  inherited: SessionWorkingStateEntry | null = null
): SessionWorkingStateEntry | null {
  if (entry.type === 'working_state') return entry;
  if (entry.type === 'context_transition' && entry.workingState)
    return Object.freeze({
      ...entry.workingState,
      id: entry.id,
      type: 'working_state',
      parentId: entry.parentId,
      timestamp: entry.timestamp
    });
  return inherited;
}

export function latestWorkingState(
  branch: readonly SessionBranchEntry[]
): SessionWorkingStateEntry | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    const revision = entry && workingStateAtEntry(entry);
    if (revision) return revision;
  }
  return null;
}

/** Retry identities are session entry identities; a retry never overwrites another interpretation. */
export function workingStateRetry(
  branch: readonly SessionBranchEntry[],
  change: WorkingStateChange
): SessionWorkingStateEntry | undefined {
  const existing = branch.find((entry) => entry.id === change.id);
  if (!existing) return undefined;
  const revision = workingStateAtEntry(existing);
  if (
    !revision ||
    hashJson({
      id: revision.id,
      previousRevisionId: revision.previousRevisionId,
      contentRef: revision.contentRef,
      inference: revision.inference
    }) !== hashJson(change)
  )
    throw new PersistenceConflictError(
      'Working-state publication identity has conflicting content.'
    );
  return revision;
}

export function assertWorkingStateBranch(
  branch: readonly SessionBranchEntry[],
  sessionId: string,
  expectedBranchId: string
): void {
  let current = sessionId;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === 'branch') {
      current = entry.id;
      break;
    }
  }
  if (current !== expectedBranchId)
    throw new PersistenceConflictError('Session branch changed during working-state publication.');
}

export function assertWorkingStateRevision(
  current: SessionWorkingStateEntry | null,
  expected: string | null
): void {
  if ((current?.id ?? null) !== expected)
    throw new PersistenceConflictError('Working state changed after the originating inference.');
}

export const WORKING_STATE_GUIDANCE =
  'Working state is your current fallible interpretation, not authority or verification. Update it only when useful understanding changes: purpose, constraints, decisions and reasons, feedback with its scope, findings with their evidence, unresolved work and useful references. No required sections or update after every exchange. Preserve useful relationships between immediate work and broader purposes without a fixed goal hierarchy. Distinguish the current conversational request from ongoing objectives; questions and hypotheticals do not authorize execution, run completion need not mean goal completion. A status request need not cancel unresolved work; unresolved work does not authorize execution after unrelated requests. Revise contradicted interpretations. Retrieve originals when detail matters; keep large material in history and artifacts.';
