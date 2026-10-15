import { hashJson } from '@agent-core/persistence';
import type { HistorySourceCut } from '../history/contracts.js';
import {
  decodeSessionStateContent,
  sessionStateContentSchema,
  type SessionStateChange,
  type SessionStateContent,
  type SessionStateSnapshot,
  type SessionStateInference
} from '../session/session-state.js';
import type { ContextService } from './service.js';

/** Preparation owns immutable bytes; the only publisher is an admitted context transition. */
export async function stageSessionState(
  context: ContextService,
  storage: { readonly maxSourceBytes: number },
  input: {
    readonly id: string;
    readonly revisionId: string | null;
    readonly inference: SessionStateInference;
    readonly content: SessionStateContent;
    readonly capturedHistoryCut: HistorySourceCut;
    readonly declaredHistoryCut?: HistorySourceCut;
  }
): Promise<
  | SessionStateChange
  | { readonly status: 'unchanged' }
  | { readonly status: 'conflict'; readonly current: Awaited<ReturnType<ContextService['inspectSessionState']>> }
  | { readonly status: 'invalid'; readonly failures: readonly { readonly reason: string; readonly message: string; readonly editIndex?: number }[] }
> {
  const current = await context.sessionState();
  if ((current.revision?.id ?? null) !== input.revisionId)
    return { status: 'conflict', current: await context.inspectSessionState() };
  const parsed = sessionStateContentSchema.safeParse(input.content);
  if (!parsed.success) return {
    status: 'invalid', failures: [{ reason: 'invalid_session_state', message: parsed.error.message }]
  };
  const content = parsed.data;
  if (hashJson(content) === hashJson(current.content)) return { status: 'unchanged' };
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  if (bytes.byteLength > storage.maxSourceBytes) return {
    status: 'invalid', failures: [{ reason: 'result_too_large', message: 'Session state exceeds the available source byte capacity; no revision was published.' }]
  };
  await context.validateSessionStateSources(content, input.capturedHistoryCut);
  return {
    id: input.id,
    previousRevisionId: input.revisionId,
    content,
    inference: input.inference,
    capturedHistoryCut: input.capturedHistoryCut,
    ...(input.declaredHistoryCut ? { declaredHistoryCut: input.declaredHistoryCut } : {})
  };
}

export function stagedSessionState(
  maxSourceBytes: number,
  change: SessionStateChange,
  parentId: string | null
): SessionStateSnapshot {
  const { content: sourceContent, ...metadata } = change;
  const content = decodeSessionStateContent(sourceContent);
  if (Buffer.byteLength(JSON.stringify(content)) > maxSourceBytes)
    throw new Error('Proposed session state exceeds the context source byte bound.');
  return Object.freeze({
    revision: Object.freeze({ ...metadata, parentId, timestamp: new Date().toISOString(),
      contentSha256: hashJson(content), contentBytes: Buffer.byteLength(JSON.stringify(content)) }),
    content
  });
}
