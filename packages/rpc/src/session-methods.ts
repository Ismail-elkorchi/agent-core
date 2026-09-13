import type {
  NoteQueryResult,
  NoteReadResult,
  SessionBranchBoundary,
  SessionBranchPageRequest,
  SessionBranchSearchRequest,
  SessionNoteRead
} from '@agent-core/runtime';
import * as z from 'zod';
import { rpcMethod } from './index.js';
import { noteListParameters, noteReadParameters } from './note-parameters.js';
import {
  sessionBranchBoundary,
  sessionBranchPageParameters,
  sessionBranchSearchParameters
} from './session-parameters.js';

export interface HistoryRpcOperations {
  readHistory(request: SessionBranchPageRequest): Promise<unknown>;
  searchHistory(request: SessionBranchSearchRequest): Promise<unknown>;
  readHistoryEntry(boundary: SessionBranchBoundary, entryId: string): Promise<unknown>;
}

export function historyRpcMethods(operations: HistoryRpcOperations) {
  return {
    'history.read': rpcMethod(sessionBranchPageParameters, (request) => operations.readHistory(request)),
    'history.search': rpcMethod(sessionBranchSearchParameters, (request) =>
      operations.searchHistory(request)
    ),
    'history.entry': rpcMethod(
      z.strictObject({ boundary: sessionBranchBoundary, entryId: z.string().min(1) }),
      ({ boundary, entryId }) => operations.readHistoryEntry(boundary, entryId)
    )
  };
}

export interface NoteRpcOperations {
  listNotes(cursor?: string): Promise<NoteQueryResult>;
  readNote(request: SessionNoteRead): Promise<NoteReadResult>;
}

export function noteRpcMethods(operations: NoteRpcOperations) {
  return {
    'notes.list': rpcMethod(noteListParameters, ({ cursor }) => operations.listNotes(cursor)),
    'notes.read': rpcMethod(noteReadParameters, (request) => operations.readNote(request))
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
