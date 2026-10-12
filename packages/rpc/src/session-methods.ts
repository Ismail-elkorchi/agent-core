import {
  historyReadRequestSchema,
  contextSelectionSchema,
  contextTransitionRequestSchema,
  type ContextTransitionRequest
} from '@agent-core/runtime';
import type {
  HistoryReadRequest,
  HistoryReadResult,
  SessionBranchBoundary,
  SessionBranchPageRequest,
  SessionBranchSearchRequest
} from '@agent-core/runtime';
import * as z from 'zod';
import { rpcMethod } from './index.js';
import {
  sessionBranchBoundary,
  sessionBranchPageParameters,
  sessionBranchSearchParameters
} from './session-parameters.js';

export interface HistoryRpcOperations {
  readHistorySource(request: HistoryReadRequest): Promise<HistoryReadResult>;
  readHistory(request: SessionBranchPageRequest): Promise<unknown>;
  searchHistory(request: SessionBranchSearchRequest): Promise<unknown>;
  readHistoryEntry(boundary: SessionBranchBoundary, entryId: string): Promise<unknown>;
}

export function historyRpcMethods(operations: HistoryRpcOperations) {
  return {
    'history.source': rpcMethod(historyReadRequestSchema, (request) =>
      operations.readHistorySource(request)
    ),
    'history.read': rpcMethod(sessionBranchPageParameters, (request) =>
      operations.readHistory(request)
    ),
    'history.search': rpcMethod(sessionBranchSearchParameters, (request) =>
      operations.searchHistory(request)
    ),
    'history.entry': rpcMethod(
      z.strictObject({ boundary: sessionBranchBoundary, entryId: z.string().min(1) }),
      ({ boundary, entryId }) => operations.readHistoryEntry(boundary, entryId)
    )
  };
}

/** Applications retain the shape and authority of their session view. */
export interface SessionRpcOperations {
  readSession(): Promise<unknown>;
  listSessions(): Promise<unknown>;
  selectSession(sessionId: string): Promise<unknown>;
}

export function sessionRpcMethods(operations: SessionRpcOperations) {
  const empty = z.strictObject({});
  return {
    'session.read': rpcMethod(empty, () => operations.readSession()),
    'session.list': rpcMethod(empty, () => operations.listSessions()),
    'session.select': rpcMethod(z.strictObject({ sessionId: z.string().min(1) }), ({ sessionId }) =>
      operations.selectSession(sessionId)
    )
  };
}

export interface ContextRpcOperations {
  inspectContext(): Promise<unknown>;
  transitionContext(request: ContextTransitionRequest): Promise<unknown>;
  freshContext(
    retained?: readonly import('@agent-core/runtime').HistorySourceRef[]
  ): Promise<unknown>;
}

export function contextRpcMethods(operations: ContextRpcOperations) {
  const empty = z.strictObject({});
  return {
    'context.read': rpcMethod(empty, () => operations.inspectContext()),
    'context.transition': rpcMethod(
      contextTransitionRequestSchema.unwrap().omit({ toolInvocation: true, expectedCut: true }).extend({ expectedSourceRevision: z.int().nonnegative() }),
      (request) => operations.transitionContext(request)
    ),
    'context.fresh': rpcMethod(
      z.strictObject({ retained: contextSelectionSchema.unwrap().shape.retained.optional() }),
      ({ retained }) => operations.freshContext(retained)
    )
  };
}
