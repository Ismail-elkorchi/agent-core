import { parseModelSelection } from '@agent-core/model';
import { parseJsonObject } from '@agent-core/json';
import * as z from 'zod';
import { historyCutSchema, noteRefSchema, sourceSchema } from '../history/schema.js';
export const contextSelectionSchema = z
  .strictObject({
    protected: z.array(sourceSchema).max(10000).readonly().optional(),
    continuity: z
      .strictObject({
        kind: z.literal('fresh'),
        resetId: z.string().min(1),
        model: z.unknown().transform((value) => parseModelSelection(value)),
        sources: z.array(sourceSchema).max(10000).readonly()
      })
      .readonly()
      .optional(),
    retained: z.array(sourceSchema).max(10_000).readonly(),
    notes: z.array(noteRefSchema).max(256).readonly(),
    strategy: z.enum(['sources', 'provider']),
    providerState: z
      .unknown()
      .transform((value, context) => {
        try {
          return parseJsonObject(value);
        } catch (error) {
          context.addIssue({
            code: 'custom',
            message: error instanceof Error ? error.message : 'Invalid JSON object.'
          });
          return z.NEVER;
        }
      })
      .optional()
  })
  .readonly();
export const contextTransitionRequestSchema = z
  .strictObject({
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
    selection: contextSelectionSchema
  })
  .readonly();
export const contextWindowSchema = z
  .strictObject({
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
    transitionId: z.string().min(1),
    compiledInputIdentity: z.string().min(1).optional(),
    capabilityRevision: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    previousWindowId: z.string().min(1).nullable(),
    windowId: z.string().min(1),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    selectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    requestedSourceRevision: z.number().int().min(0).optional(),
    committedAt: z.string().min(1)
  })
  .readonly();
export const contextEntrySchema = z
  .strictObject({
    type: z.literal('context_transition'),
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    timestamp: z.string().min(1),
    window: contextWindowSchema,
    transition: contextTransitionSchema
  })
  .readonly();
