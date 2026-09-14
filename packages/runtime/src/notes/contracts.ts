import type { ProtectedArtifactRef } from '@agent-core/persistence';
import type { JsonValue } from '@agent-core/json';
import type { HistorySourceRef } from '../history/contracts.js';

export interface NoteScope {
  readonly sessionId: string;
  readonly branchId: string;
}
export interface NoteReference {
  readonly scope: NoteScope;
  readonly noteId: string;
  readonly revisionId: string;
}
export interface NoteRevision extends NoteReference {
  readonly format: 'agent-core.note/1';
  readonly title: string;
  readonly mediaType: 'text/plain' | 'text/markdown' | 'application/json';
  readonly schemaId?: string | undefined;
  readonly contentArtifact?: ProtectedArtifactRef | undefined;
  readonly parentRevision: string | null;
  readonly authorId: string;
  readonly invocationId: string;
  readonly sources: readonly HistorySourceRef[];
  readonly tombstone: boolean;
  readonly createdAt: string;
}
export interface NoteWriteRequest {
  readonly scope: NoteScope;
  readonly noteId: string;
  readonly title: string;
  readonly mediaType: NoteRevision['mediaType'];
  readonly content: string | JsonValue;
  readonly schemaId?: string | undefined;
  readonly expectedRevision: string | null;
  readonly idempotencyKey: string;
  readonly authorId: string;
  readonly invocationId: string;
  readonly sources?: readonly HistorySourceRef[] | undefined;
}
export type NoteRemoveRequest = Pick<
  NoteWriteRequest,
  'scope' | 'noteId' | 'expectedRevision' | 'idempotencyKey' | 'authorId' | 'invocationId'
>;
export type NoteWriteResult =
  | Readonly<{ status: 'committed'; revision: NoteRevision }>
  | Readonly<{ status: 'conflict'; currentRevision: string | null }>;
export interface NoteReadRequest {
  readonly scope: NoteScope;
  readonly noteId: string;
  readonly revisionId?: string | undefined;
  readonly offset?: number | undefined;
  readonly maxBytes?: number | undefined;
}
export type NoteReadResult =
  | Readonly<{
      status: 'available';
      revision: NoteRevision;
      text: string;
      offset: number;
      nextOffset: number;
      totalBytes: number;
      truncated: boolean;
    }>
  | Readonly<{ status: 'missing' | 'tombstone' | 'artifact_unavailable'; revision?: NoteRevision }>;
export interface NoteQuery {
  readonly maxScannedBytes?: number | undefined;
  readonly scope: NoteScope;
  readonly query?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxScanned?: number | undefined;
}
export interface NoteQueryResult {
  readonly scannedBytes: number;
  readonly unavailable?: readonly {
    readonly revision: NoteRevision;
    readonly reason: 'source_too_large' | 'artifact_unavailable';
  }[];
  readonly index?: {
    readonly sources: number;
    readonly bytes: number;
    readonly terms: number;
    readonly coverage: 'complete' | 'partial';
  };
  readonly items: readonly NoteRevision[];
  readonly watermark: number;
  readonly coverage: 'complete' | 'partial';
  readonly scanned: number;
  readonly bytes: number;
  readonly cursor?: string;
}
export interface NoteQuotas {
  readonly maxIndexBytes: number;
  readonly maxNotes: number;
  readonly maxNoteBytes: number;
  readonly maxTotalBytes: number;
  readonly maxRevisions: number;
  readonly maxQueryScanned: number;
  readonly maxQueryBytes: number;
}
export interface NoteRepository {
  write(input: NoteWriteRequest): Promise<NoteWriteResult>;
  remove(input: NoteRemoveRequest): Promise<NoteWriteResult>;
  read(input: NoteReadRequest): Promise<NoteReadResult>;
  list(input: NoteQuery): Promise<NoteQueryResult>;
  search(input: NoteQuery): Promise<NoteQueryResult>;
  fork(input: {
    readonly scope: NoteScope;
    readonly parentScope: NoteScope;
    readonly throughRevision?: number;
  }): Promise<void>;
}
