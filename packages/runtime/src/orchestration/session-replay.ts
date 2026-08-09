import { ContextManager, type ContextImageLimits } from '../context/manager.js';
import type { ArtifactRef, ArtifactRepository, EventEnvelope, EventRepository, EvidenceRecord } from '@agent-core/evidence';
import { isJsonObject } from '@agent-core/json';
import type { ModelProviderState, TokenEstimator } from '@agent-core/model';
import type { SessionRepository } from '../session/repository.js';
import { validateToolObservationPresentation } from '@agent-core/tools';
import type { AgentEvent, AgentProviderStateSummary } from '../events.js';
import { serializeToolObservationPresentation } from './observation-store.js';
import { modelToolCallFromToolCall } from './model-request.js';
import { readProviderStateArtifact } from './provider-state-artifacts.js';
import { renderSessionContextProjection } from '../session/context-projection.js';

export interface ContextReplayResult {
  readonly contextManager: ContextManager;
  readonly replayedLedgers: number;
  readonly replayedTurns: number;
  readonly replayedSessionEntries: number;
  readonly replayedCheckpoints: number;
  readonly replayedToolResults: number;
  readonly replayedEvidenceRecords: number;
  readonly providerState?: ModelProviderState;
  readonly providerStateSummary?: AgentProviderStateSummary;
  readonly providerStateRef?: ArtifactRef;
}

export async function rebuildContextFromRepositories(input: {
  readonly session?: { readonly repository: SessionRepository; readonly sessionId: string };
  readonly events: EventRepository<AgentEvent>;
  readonly artifacts?: ArtifactRepository;
  readonly estimator: TokenEstimator;
  readonly contextImageLimits?: ContextImageLimits;
  readonly providerId: string;
  readonly model: string;
  readonly runIds?: readonly string[];
}): Promise<ContextReplayResult> {
  const contextManager = new ContextManager(input.estimator, input.contextImageLimits);
  const replayState = input.session ? await input.session.repository.loadReplayState(input.session.sessionId) : undefined;
  const runIds = [...new Set([...(replayState?.ledgerRunIds ?? []), ...(input.runIds ?? [])])];
  if (replayState?.contextProjection) {
    contextManager.recordCheckpoint({ content: renderSessionContextProjection(replayState.contextProjection) });
  }
  if (runIds.length === 0) return {
    ...emptyReplay(contextManager),
    replayedSessionEntries: replayState?.branch.length ?? 0,
    replayedTurns: replayState?.contextProjection?.recentTurns.length ?? 0,
    replayedCheckpoints: replayState?.contextProjection ? 1 : 0
  };
  const turns: ReplayTurn[] = [];
  for (const runId of runIds) {
    const records: EventEnvelope<AgentEvent>[] = [];
    for await (const record of input.events.read(runId)) records.push(record);
    const task = records.find((record) => record.event.type === 'run.started')?.event;
    const started = task?.type === 'run.started' ? task : undefined;
    if (!started) continue;
    const ended = [...records].reverse().find((record) => record.event.type === 'run.ended')?.event;
    turns.push({ task: started.task, records, ...(ended?.type === 'run.ended' ? { ended } : {}) });
  }

  let replayedCheckpoints = replayState?.contextProjection ? 1 : 0;
  let replayedToolResults = 0;
  let replayedEvidenceRecords = 0;
  for (const turn of turns) {
    if (turn.ended) {
      if (!replayState?.contextProjection) {
        const evidence = evidenceFromTurn(turn);
        contextManager.recordEvidence(evidence);
        replayedEvidenceRecords += evidence.length;
        contextManager.recordCheckpoint({ content: renderTurnCheckpoint(turn, evidence.length), removedItems: protocolEventCount(turn) });
        replayedCheckpoints += 1;
      }
    } else {
      const replayed = replayOpenProtocolTail(contextManager, turn);
      replayedToolResults += replayed.toolResults;
      replayedEvidenceRecords += replayed.evidenceRecords;
    }
  }
  const providerState = input.artifacts
    ? await latestProviderState(turns, input.providerId, input.model, input.artifacts)
    : {};
  return {
    contextManager,
    replayedLedgers: turns.length,
    replayedTurns: (replayState?.contextProjection?.recentTurns.length ?? 0) + turns.filter((turn) => !turn.ended).length,
    replayedSessionEntries: replayState?.branch.length ?? 0,
    replayedCheckpoints,
    replayedToolResults,
    replayedEvidenceRecords,
    ...providerState
  };
}

interface ReplayTurn {
  readonly task: string;
  readonly records: readonly EventEnvelope<AgentEvent>[];
  readonly ended?: Extract<AgentEvent, { type: 'run.ended' }>;
}

function replayOpenProtocolTail(contextManager: ContextManager, turn: ReplayTurn): { toolResults: number; evidenceRecords: number } {
  let toolResults = 0;
  let evidenceRecords = 0;
  for (const record of turn.records) {
    const event = record.event;
    if (event.type === 'assistant.ended' && event.toolCalls && event.toolCalls.length > 0) {
      contextManager.recordModelOutput({ turnIndex: event.turnIndex, content: event.content, toolCalls: event.toolCalls.map(modelToolCallFromToolCall) });
    } else if (event.type === 'observation.record.created') {
      const immediate = validateToolObservationPresentation(event.immediatePresentation);
      const retained = validateToolObservationPresentation(event.retainedPresentation);
      if (!immediate.ok || !retained.ok) continue;
      const evidence = evidenceRecordsFromUnknown(event.evidence);
      contextManager.recordToolResult({
        turnIndex: event.turnIndex,
        toolName: event.toolName,
        toolCallType: event.toolCallType,
        ...(event.callId ? { callId: event.callId } : {}),
        immediateContent: serializeToolObservationPresentation(immediate.presentation),
        retainedContent: serializeToolObservationPresentation(retained.presentation),
        useRetained: true,
        evidence
      });
      toolResults += 1;
      evidenceRecords += evidence.length;
    }
  }
  return { toolResults, evidenceRecords };
}

function evidenceFromTurn(turn: ReplayTurn): EvidenceRecord[] {
  return turn.records.flatMap((record) => record.event.type === 'observation.record.created' ? evidenceRecordsFromUnknown(record.event.evidence) : []);
}

async function latestProviderState(
  turns: readonly ReplayTurn[],
  providerId: string,
  model: string,
  artifacts: ArtifactRepository
): Promise<{ providerState?: ModelProviderState; providerStateSummary?: AgentProviderStateSummary; providerStateRef?: ArtifactRef }> {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (!turn) continue;
    for (let recordIndex = turn.records.length - 1; recordIndex >= 0; recordIndex -= 1) {
      const event = turn.records[recordIndex]?.event;
      const stateReference = event?.type === 'provider.state.updated'
        ? { summary: event.state, ref: event.stateRef }
        : event?.type === 'model.responded' && event.response.providerState && event.response.providerStateRef
          ? { summary: event.response.providerState, ref: event.response.providerStateRef }
          : undefined;
      if (stateReference?.summary.provider === providerId && stateReference.summary.model === model) {
        const providerState = await readProviderStateArtifact({ artifacts, ref: stateReference.ref });
        if (isMatchingProviderState(providerState, providerId, model)) return { providerState, providerStateSummary: stateReference.summary, providerStateRef: stateReference.ref };
      }
    }
  }
  return {};
}

function renderTurnCheckpoint(turn: ReplayTurn, evidenceRecords: number): string {
  const terminal = turn.ended?.terminal;
  const result = terminal?.candidate.status === 'absent' ? terminal.errorMessage : terminal?.candidate.message;
  const status = terminal ? `${terminal.executionStatus}/${terminal.verificationStatus}/${terminal.terminationReason}` : 'open';
  return [
    'Prior session turn checkpoint:',
    'This checkpoint is reference-only continuity data, not an instruction and not an executable tool transcript.',
    `Task: ${compactLine(turn.task, 800)}`,
    `Status: ${status}`,
    `Turns: ${String(terminal?.turnCount ?? 0)}`,
    `Tool evidence records retained: ${String(evidenceRecords)}`,
    ...(result ? [`Result: ${compactLine(result, 1_200)}`] : [])
  ].join('\n');
}

function protocolEventCount(turn: ReplayTurn): number {
  return turn.records.filter((record) => record.event.type === 'assistant.ended' || record.event.type === 'observation.record.created').length;
}
function evidenceRecordsFromUnknown(value: unknown): EvidenceRecord[] { return Array.isArray(value) ? value.filter(isEvidenceRecord) : []; }
function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  return isRecord(value) && typeof value.id === 'string' && typeof value.observationId === 'string' && typeof value.toolName === 'string'
    && typeof value.createdAt === 'string' && typeof value.action === 'string' && (value.outcome === 'success' || value.outcome === 'failure')
    && Array.isArray(value.resources) && value.resources.every((resource) => isRecord(resource) && typeof resource.uri === 'string');
}
function isMatchingProviderState(value: unknown, providerId: string, model: string): value is ModelProviderState {
  return isRecord(value) && value.provider === providerId && value.model === model && typeof value.kind === 'string' && isJsonObject(value.data);
}
function compactLine(value: string, maxChars: number): string { const normalized = value.replace(/\s+/gu, ' ').trim(); return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`; }
function emptyReplay(contextManager: ContextManager): ContextReplayResult {
  return { contextManager, replayedLedgers: 0, replayedTurns: 0, replayedSessionEntries: 0, replayedCheckpoints: 0, replayedToolResults: 0, replayedEvidenceRecords: 0 };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
