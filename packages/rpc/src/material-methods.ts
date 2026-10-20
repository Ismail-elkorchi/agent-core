import {
  materialOwnerSchema,
  qualifiedMaterialRefSchema,
  sessionStatePageSchema,
  sessionStateItemRefSchema,
  type QualifiedMaterialRef,
  type ScopedMaterialService
} from '@agent-core/runtime';
import * as z from 'zod';
import { rpcMethod } from './index.js';

/** The service is the same host-bound capability used by context admission. */
export interface MaterialRpcOperations {
  materialService(expectedSessionId?: string): ScopedMaterialService;
  submitMaterialCorrection(ref: QualifiedMaterialRef, text: string, expectedSessionId: string): Promise<unknown>;
}

/** User controls only. These methods are never added to the model tool catalog. */
export function materialRpcMethods(operations: MaterialRpcOperations) {
  return {
    'material.owner': rpcMethod(z.strictObject({}), () => operations.materialService().currentSessionOwner()),
    'material.scopes': rpcMethod(sessionStatePageSchema, page => operations.materialService().listScopes(page)),
    'material.list': rpcMethod(z.strictObject({ owner: materialOwnerSchema, page: sessionStatePageSchema.optional() }),
      ({ owner, page }) => operations.materialService().list(owner, page)),
    'material.read': rpcMethod(z.strictObject({ ref: qualifiedMaterialRefSchema,
      maxBytes: z.int().positive().max(1024 * 1024).optional() }),
      ({ ref, maxBytes }) => operations.materialService().read(ref, maxBytes === undefined ? {} : { maxBytes })),
    'material.correct': rpcMethod(z.strictObject({ sessionId: z.string().min(1), ref: qualifiedMaterialRefSchema, text: z.string().min(1).max(1024 * 1024) }),
      ({ ref, text, sessionId }) => operations.submitMaterialCorrection(ref, text, sessionId)),
    'material.revoke': rpcMethod(z.strictObject({ owner: materialOwnerSchema,
      operationId: z.string().min(1).max(512), expectedRevision: z.int().nonnegative(),
      refs: z.array(sessionStateItemRefSchema).min(1).max(256) }),
      input => operations.materialService().revoke(input)),
    'material.erase': rpcMethod(z.strictObject({ targets: z.array(qualifiedMaterialRefSchema).min(1).max(256) }),
      ({ targets }) => operations.materialService().erase(targets))
  };
}
