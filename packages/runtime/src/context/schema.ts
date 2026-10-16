import { sessionStateChangeSchema } from '../session/session-state.js';
import { parseModelSelection } from '@agent-core/model';
import * as z from 'zod';
import { historyCutSchema, sourceSchema, sourceExcerptSchema } from '../history/schema.js';
const sourceSelectionShape = {
  excerpts: z.array(sourceExcerptSchema).max(10000).readonly().optional(),
  protected: z.array(sourceSchema).max(10000).readonly().optional(),
  retained: z.array(sourceSchema).max(10_000).readonly()
};
const contextSourceSelectionSchema = z.strictObject(sourceSelectionShape).readonly();
export const contextSelectionSchema = z.strictObject({
  ...sourceSelectionShape,
  continuity: z.strictObject({
    kind: z.literal('fresh'),
    resetId: z.string().min(1),
    model: z.unknown().transform((value) => parseModelSelection(value)),
    sources: z.array(sourceSchema).max(10000).readonly()
  }).readonly().optional()
}).readonly();
export const contextTransitionRequestSchema = z
  .strictObject({
    renewal: z.boolean().optional(),
    expectedCut: historyCutSchema.optional(),
    sessionState: sessionStateChangeSchema.optional(),
    expectedSessionStateRevisionId: z.string().min(1).nullable().optional(),
    toolInvocation: z
      .strictObject({
        runId: z.string().min(1),
        turnId: z.string().min(1),
        requestAttempt: z.int().positive(),
        toolBatchId: z.string().min(1),
        callIndex: z.int().nonnegative(),
        toolAttempt: z.int().positive()
      })
      .readonly()
      .optional(),
    expectedWindowId: z.string().min(1).nullable(),
    expectedSourceRevision: z.number().int().min(0).optional(),
    idempotencyKey: z.string().min(1),
    reason: z.string().min(1),
    selection: contextSourceSelectionSchema
  })
  .readonly();
export const contextStateSequenceSchema = z.strictObject({
  checkpointRevisionId: z.string().min(1).nullable(),
  lineage: historyCutSchema.nullable(),
  parent: sourceSchema.nullable(),
  notice: z.strictObject({
    id: z.string().min(1),
    previousRevisionId: z.string().min(1).nullable(),
    revisionId: z.string().min(1),
    after: historyCutSchema,
    message: z.strictObject({ role: z.literal('user'), content: z.string() }).readonly()
  }).readonly().optional()
}).readonly();
export const contextWindowSchema = z
  .strictObject({
    stateSequence: contextStateSequenceSchema,
    windowId: z.string().min(1),
    parentWindowId: z.string().min(1).nullable(),
    historyPosition: historyCutSchema,
    selection: contextSelectionSchema,
    reason: z.string().min(1),
    createdAt: z.string().min(1)
  })
  .readonly();
export const contextTransitionSchema = z
  .strictObject({
    strategy: z.enum(['append', 'fresh']),
    cause: z.enum(['state_update', 'selection_change', 'explicit_renewal', 'capacity', 'prefix_incompatibility']),
    requestedRenewal: z.boolean().optional(),
    transitionId: z.string().min(1),
    admission: z.strictObject({ status: z.literal('admitted'), compiledInputIdentity: z.string().min(1), capabilityRevision: z.string().min(1) }).readonly(),
    idempotencyKey: z.string().min(1),
    previousWindowId: z.string().min(1).nullable(),
    windowId: z.string().min(1),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    selectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    stateSequenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    requestedSourceRevision: z.number().int().min(0).optional(),
    requestedSessionStateRevisionId: z.string().min(1).nullable().optional(),
    committedAt: z.string().min(1)
  })
  .readonly();
export const contextEntrySchema = z
  .strictObject({
    type: z.literal('context_transition'),
    sessionState: sessionStateChangeSchema.omit({ id: true }).optional(),
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    timestamp: z.string().min(1),
    window: contextWindowSchema,
    transition: contextTransitionSchema
  })
  .readonly();
