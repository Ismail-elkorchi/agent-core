import type { ArtifactRepository } from '@agent-core/persistence';
import type { WorkingStateChange, WorkingStateSnapshot, WorkingStateInference } from '../session/working-state.js';
import type { ContextService } from './service.js';

/** Preparation owns immutable bytes; the only publisher is an admitted context transition. */
export async function stageWorkingState(
  context: ContextService,
  storage: { readonly artifacts: ArtifactRepository; readonly maxSourceBytes: number },
  input: {
    readonly id: string;
    readonly revisionId: string | null;
    readonly inference: WorkingStateInference;
    readonly text: string;
  }): Promise<
    | WorkingStateChange
    | { readonly status: 'unchanged' }
    | {
        readonly status: 'conflict';
        readonly current: Awaited<ReturnType<ContextService['inspectWorkingState']>>;
      }
    | {
        readonly status: 'invalid';
        readonly failures: readonly {
          readonly reason: string;
          readonly message: string;
          readonly editIndex?: number;
        }[];
      }
  > {
    const current = await context.workingState();
    if ((current.revision?.id ?? null) !== input.revisionId)
      return { status: 'conflict', current: await context.inspectWorkingState() };
    if (input.text === current.text) return { status: 'unchanged' };
    const bytes = new TextEncoder().encode(input.text);
    if (bytes.byteLength > storage.maxSourceBytes)
      return {
        status: 'invalid',
        failures: [
          {
            reason: 'result_too_large',
            message:
              'Working state exceeds the available source byte capacity; no revision was published.'
          }
        ]
      };
    const contentRef = await storage.artifacts.storeProtected({
      label: 'working-state',
      mediaType: 'text/plain; charset=utf-8',
      content: bytes
    });
    return {
      id: input.id,
      previousRevisionId: input.revisionId,
      contentRef,
      inference: input.inference
    };
  }

export async function stagedWorkingState(
    artifacts: ArtifactRepository,
    maxSourceBytes: number,
    change: WorkingStateChange,
    parentId: string | null
  ): Promise<WorkingStateSnapshot> {
    if (change.contentRef.size > maxSourceBytes)
      throw new Error('Proposed working state exceeds the context source byte bound.');
    return {
      revision: { ...change, parentId, timestamp: new Date().toISOString() },
      text: new TextDecoder('utf-8', { fatal: true }).decode(
        await artifacts.readVerified(change.contentRef)
      )
    };
  }
