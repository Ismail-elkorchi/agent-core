import type { ArtifactRepository, EventRepository } from '@agent-core/evidence';
import type { SessionRepository } from './session/repository.js';
import type { AgentEvent } from './events.js';

export interface AgentSessionBinding {
  readonly repository: SessionRepository;
  readonly sessionId: string;
}

export interface AgentRuntimeRepositories {
  readonly events: EventRepository<AgentEvent>;
  readonly session?: AgentSessionBinding;
  readonly artifacts?: ArtifactRepository;
}

export interface AgentFinalizationProgress {
  readonly prepared: boolean;
  readonly sessionProjected: boolean;
  readonly committed: boolean;
  readonly reconciliation: 'verified' | 'unavailable';
}

export class AgentFinalizationError extends Error {
  readonly runId: string;
  readonly finalizationId: string;
  readonly progress: AgentFinalizationProgress;
  readonly causeValue: unknown;

  constructor(input: {
    runId: string;
    finalizationId: string;
    progress: AgentFinalizationProgress;
    cause: unknown;
  }) {
    super(
      `Finalization ${input.finalizationId} for run ${input.runId} failed: prepared=${String(input.progress.prepared)}, sessionProjected=${String(input.progress.sessionProjected)}, committed=${String(input.progress.committed)}, reconciliation=${input.progress.reconciliation}. ${errorMessage(input.cause)}`
    );
    this.name = 'AgentFinalizationError';
    this.runId = input.runId;
    this.finalizationId = input.finalizationId;
    this.progress = Object.freeze({ ...input.progress });
    this.causeValue = input.cause;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
