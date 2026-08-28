import type { EventAppendReceipt, EventRepository } from '@agent-core/evidence';
import {
  AgentContractError,
  createAgentTerminalSnapshot,
  terminalSnapshotFingerprint,
  type AgentDeliveryDiagnostic,
  type AgentEndedRunResult,
  type AgentTerminalSnapshot
} from '../run/contracts.js';
import type { SessionRepository } from '../session/repository.js';
import type { AgentAuditEvent, AgentEvent, AgentProgressEvent } from '../events.js';
import { AgentFinalizationError, type AgentFinalizationProgress } from '../ports.js';

export class AgentRunFinalizer {
  private decisionFingerprint: string | undefined;
  private finalizationPromise: Promise<AgentEndedRunResult> | undefined;

  constructor(private readonly input: {
    readonly runId: string;
    readonly finalizationId: string;
    readonly events: EventRepository<AgentEvent>;
    readonly append: (event: AgentAuditEvent, idempotencyKey: string) => Promise<EventAppendReceipt>;
    readonly session?: { readonly repository: SessionRepository; readonly sessionId: string };
    readonly deliver?: (event: AgentProgressEvent) => void | Promise<void>;
    readonly deliveryDiagnostics?: AgentDeliveryDiagnostic[];
  }) {}

  finalize(
    terminalInput: AgentTerminalSnapshot,
    diagnostic?: Extract<AgentEvent, { type: 'run.ended' }>['diagnostic']
  ): Promise<AgentEndedRunResult> {
    const terminal = createAgentTerminalSnapshot(terminalInput);
    if (terminal.runId !== this.input.runId || terminal.finalizationId !== this.input.finalizationId) {
      throw new AgentContractError('Finalization identity mismatch.', ['The terminal decision does not belong to this finalizer.']);
    }
    const fingerprint = terminalSnapshotFingerprint(terminal);
    if (this.decisionFingerprint !== undefined && this.decisionFingerprint !== fingerprint) {
      throw new AgentContractError('Conflicting terminal decision.', [`Finalization ${this.input.finalizationId} already has an immutable decision.`]);
    }
    this.decisionFingerprint = fingerprint;
    this.finalizationPromise ??= this.commit(terminal, diagnostic);
    return this.finalizationPromise;
  }

  private async commit(
    terminal: AgentTerminalSnapshot,
    diagnostic: Extract<AgentEvent, { type: 'run.ended' }>['diagnostic'] | undefined
  ): Promise<AgentEndedRunResult> {
    const progress: MutableFinalizationProgress = { prepared: false, sessionProjected: false, committed: false };
    try {
      await this.input.append(
        { type: 'finalization.prepared', terminal },
        `${this.input.finalizationId}:prepared`
      );
      progress.prepared = true;
      if (this.input.session) {
        await this.input.session.repository.projectFinal(this.input.session.sessionId, terminal);
      }
      progress.sessionProjected = true;
      await this.input.append(
        { type: 'run.ended', terminal, ...(diagnostic ? { diagnostic } : {}) },
        `${this.input.finalizationId}:committed`
      );
      progress.committed = true;
    } catch (error) {
      let observed: AgentFinalizationProgress;
      try { observed = await this.auditProgress(terminal, progress); }
      catch { observed = freezeProgress(progress, 'unavailable'); }
      throw new AgentFinalizationError({
        runId: this.input.runId,
        finalizationId: this.input.finalizationId,
        progress: observed,
        cause: error
      });
    }

    const deliveryDiagnostics = this.input.deliveryDiagnostics ?? [];
    if (this.input.deliver) {
      try {
        await this.input.deliver({ type: 'run.ended', terminal, deliveryDiagnostics: Object.freeze([...deliveryDiagnostics]) });
      } catch (error) {
        const base = { eventType: 'run.ended', message: errorMessage(error) };
        try {
          const diagnosticEvent: AgentDeliveryDiagnostic = { ...base, persisted: true };
          await this.input.append(
            { type: 'delivery.failed', finalizationId: this.input.finalizationId, diagnostic: diagnosticEvent },
            `${this.input.finalizationId}:delivery:turn.ended`
          );
          deliveryDiagnostics.push(diagnosticEvent);
        } catch {
          deliveryDiagnostics.push({ ...base, persisted: false });
        }
      }
    }
    return Object.freeze({ state: 'ended', terminal, deliveryDiagnostics: Object.freeze(deliveryDiagnostics) });
  }

  private async auditProgress(terminal: AgentTerminalSnapshot, fallback: MutableFinalizationProgress): Promise<AgentFinalizationProgress> {
    let prepared = fallback.prepared;
    let committed = fallback.committed;
    const expected = terminalSnapshotFingerprint(terminal);
    for await (const envelope of this.input.events.read(this.input.runId)) {
      if (envelope.event.type !== 'finalization.prepared' && envelope.event.type !== 'run.ended') continue;
      if (envelope.event.terminal.finalizationId !== this.input.finalizationId) continue;
      if (terminalSnapshotFingerprint(envelope.event.terminal) !== expected) throw new AgentContractError('Conflicting durable finalization record.', [`Finalization ${this.input.finalizationId} changed while persistence was being reconciled.`]);
      if (envelope.event.type === 'finalization.prepared') prepared = true;
      else committed = true;
    }
    let sessionProjected = this.input.session === undefined || fallback.sessionProjected;
    if (this.input.session) {
      const replay = await this.input.session.repository.loadReplayState(this.input.session.sessionId);
      for (const projection of replay.terminalProjections) {
        if (projection.finalizationId !== this.input.finalizationId) continue;
        if (terminalSnapshotFingerprint(projection.terminal) !== expected) throw new AgentContractError('Conflicting durable session projection.', [`Finalization ${this.input.finalizationId} changed while persistence was being reconciled.`]);
        sessionProjected = true;
      }
    }
    return Object.freeze({ prepared, sessionProjected, committed, reconciliation: 'verified' });
  }
}

export async function readCommittedTerminal(
  events: EventRepository<AgentEvent>,
  runId: string
): Promise<AgentTerminalSnapshot | undefined> {
  let terminal: AgentTerminalSnapshot | undefined;
  for await (const envelope of events.read(runId)) {
    if (envelope.event.type === 'run.ended') {
      if (envelope.event.terminal.runId !== runId) {
        throw new AgentContractError('Terminal commit identity mismatch.', [`Ledger ${runId} contains terminal truth for ${envelope.event.terminal.runId}.`]);
      }
      if (terminal && terminalSnapshotFingerprint(terminal) !== terminalSnapshotFingerprint(envelope.event.terminal)) {
        throw new AgentContractError('Contradictory terminal commits.', [`Run ${runId} has more than one terminal truth.`]);
      }
      terminal = envelope.event.terminal;
    }
  }
  return terminal;
}

interface MutableFinalizationProgress {
  prepared: boolean;
  sessionProjected: boolean;
  committed: boolean;
}

function freezeProgress(value: MutableFinalizationProgress, reconciliation: AgentFinalizationProgress['reconciliation']): AgentFinalizationProgress {
  return Object.freeze({ ...value, reconciliation });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
