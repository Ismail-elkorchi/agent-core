import { readTransformedContext } from '../inference/context-transform.js';
import { ModelWindow, type ModelWindowImageLimits } from '../inference/model-window.js';
import type { ArtifactRef, ArtifactRepository, EventRepository } from '@agent-core/persistence';
import { decodeToolCall } from '@agent-core/tools';
import {
  modelOutputToInput,
  type ProviderContextState,
  type RequestEstimator,
  type ModelOutputItem
} from '@agent-core/model';
import type { SessionBranchEntry, SessionDescriptor, SessionRepository } from '../session/contracts.js';
import type { AgentEvent, AgentProviderStateSummary } from '../events.js';
import { HistoryReader, sourceRef, historySourceAfterCut } from '../history/reader.js';
import type { HistoryView } from '../history/contracts.js';
import { serializeToolObservationPresentation } from './observation-store.js';
import { modelToolCallFromToolCall } from './model-request.js';
import { readProviderStateArtifact } from './provider-state-artifacts.js';

export interface ModelWindowReplayResult {
  readonly modelWindow: ModelWindow;
  readonly replayedLedgers: number;
  readonly replayedTurns: number;
  readonly replayedSessionEntries: number;
  readonly replayedToolResults: number;
  readonly replayedObservedFactRecords: number;
  readonly providerState?: ProviderContextState;
  readonly providerStateSummary?: AgentProviderStateSummary;
  readonly providerStateRef?: ArtifactRef;
}

/** Replay selected immutable source entries and every contribution after the committed cut. */
export async function rebuildModelWindowFromRepositories(input: {
  readonly session?: {
    readonly repository: SessionRepository;
    readonly descriptor: SessionDescriptor;
  };
  readonly events: EventRepository<AgentEvent>;
  readonly artifacts?: ArtifactRepository;
  readonly estimator: RequestEstimator;
  readonly modelWindowImageLimits?: ModelWindowImageLimits;
  readonly providerId: string;
  readonly model: string;
  readonly runIds?: readonly string[];
  readonly currentRunId?: string;
}): Promise<ModelWindowReplayResult> {
  const modelWindow = new ModelWindow(input.estimator, input.modelWindowImageLimits);
  const view = input.session
    ? await new HistoryReader({
        repository: input.session.repository,
        session: input.session.descriptor,
        events: input.events,
        ...(input.artifacts ? { artifacts: input.artifacts } : {})
      }).view()
    : undefined;
  const selected = view ? selectedHistoryEntries(view) : [];
  if (view?.contextWindow?.selection.strategy === 'provider' && !input.artifacts)
    throw new Error('Committed native context requires its protected artifact repository.');
  const transformed =
    view && input.artifacts
      ? await readTransformedContext({
          view,
          artifacts: input.artifacts,
          provider: input.providerId,
          model: input.model
        })
      : undefined;
  for (const [index, item] of (transformed?.input ?? []).entries())
    modelWindow.recordSourceItem(
      `context-transform:${view?.contextWindow?.windowId ?? ''}:${String(index)}`,
      item
    );
  const prior = selected.filter(
    (entry) =>
      (!('runId' in entry) || entry.runId !== input.currentRunId) &&
      !transformed?.represented.has(sourceRef(view?.cut.sessionId ?? 'local', entry).entryId)
  );
  let replayedToolResults = 0;
  let replayedObservedFactRecords = 0;
  replayedToolResults += replaySourceEntries(modelWindow, view?.cut.sessionId ?? 'local', prior);
  // Only the owning unfinished run may use an open ledger tail. Completed history
  // is branch-scoped above; reading entire historical ledgers would cross a fork.
  let replayedLedgers = 0;
  let providerState: ProviderContextState | undefined;
  let providerStateSummary: AgentProviderStateSummary | undefined;
  let providerStateRef: ArtifactRef | undefined;
  const outputByTurn = new Map<string, readonly ModelOutputItem[]>();
  const steering = new Map<string, string>();
  for (const runId of [...new Set(input.runIds ?? [])]) {
    replayedLedgers++;
    for await (const record of input.events.read(runId)) {
      const event = record.event;
      if (event.type === 'input.steering.accepted') steering.set(event.deliveryId, event.content);
      if (
        event.type === 'input.steering.local_applied' ||
        (event.type === 'input.steering.delivery' && event.delivery.status === 'applied')
      ) {
        const deliveryId =
          event.type === 'input.steering.local_applied' ? event.deliveryId : event.delivery.deliveryId;
        const content = steering.get(deliveryId);
        if (content)
          modelWindow.recordInput(`steering:${deliveryId}`, {
            role: 'user',
            content
          });
      }
      if (event.type === 'provider.attempt.settled' && event.response.output)
        outputByTurn.set(`${event.turnId}:${String(event.requestAttempt)}`, event.response.output);
      const output =
        'turnId' in event ? outputByTurn.get(`${event.turnId}:${String(event.requestAttempt)}`) : undefined;
      if (event.type === 'assistant.ended')
        modelWindow.recordModelOutput({
          turnIndex: event.turnIndex,
          content: event.content,
          toolCalls: (event.toolCalls ?? []).map(modelToolCallFromToolCall),
          ...(output ? { output } : {})
        });
      else if (event.type === 'run.disposition.decided' && event.decision.kind === 'revise')
        modelWindow.recordInput(
          `disposition-${String(event.revisionCount + 1)}`,
          { role: 'user', content: event.decision.instruction },
          event.turnIndex
        );
      else if (event.type === 'observation.record.created') {
        modelWindow.recordToolResult({
          turnIndex: event.turnIndex,
          toolName: event.toolName,
          toolCallType: event.toolCallType,
          ...(event.callId ? { callId: event.callId } : {}),
          immediateContent: serializeToolObservationPresentation(event.immediatePresentation),
          retainedContent: serializeToolObservationPresentation(event.retainedPresentation),
          useRetained: true,
          observedFacts: event.observedFacts
        });
        replayedToolResults++;
        replayedObservedFactRecords += event.observedFacts.length;
      }
      const ref =
        event.type === 'provider.state.updated'
          ? { summary: event.state, ref: event.stateRef }
          : event.type === 'provider.attempt.settled' && event.providerState
            ? {
                summary: event.providerState.summary,
                ref: event.providerState.artifact
              }
            : undefined;
      if (
        ref &&
        input.artifacts &&
        ref.summary.provider === input.providerId &&
        ref.summary.model === input.model
      ) {
        const state = await readProviderStateArtifact({
          artifacts: input.artifacts,
          ref: ref.ref
        });
        if (state) {
          providerState = state;
          providerStateSummary = ref.summary;
          providerStateRef = ref.ref;
        }
      }
    }
  }
  return {
    modelWindow,
    replayedLedgers,
    replayedTurns: view?.runFinalizations.length ?? 0,
    replayedSessionEntries: prior.length,
    replayedToolResults,
    replayedObservedFactRecords,
    ...(providerState ? { providerState } : {}),
    ...(providerStateSummary ? { providerStateSummary } : {}),
    ...(providerStateRef ? { providerStateRef } : {})
  };
}

export function selectedHistoryEntries(view: HistoryView): readonly SessionBranchEntry[] {
  const window = view.contextWindow;
  if (!window) return view.entries;
  const retained = new Map(window.selection.retained.map((source) => [source.entryId, source]));
  return view.entries.filter((entry) => {
    if (historySourceAfterCut(view, entry, window.historyPosition)) return true;
    const actual = sourceRef(view.cut.sessionId, entry);
    const source = retained.get(actual.entryId);
    if (!source) return false;
    if (source.sessionId !== actual.sessionId || source.sha256 !== actual.sha256)
      throw new Error('Committed context source identity changed.');
    return true;
  });
}

export function replaySourceEntries(
  modelWindow: ModelWindow,
  sessionId: string,
  prior: readonly SessionBranchEntry[]
): number {
  let toolResults = 0;
  const callGroups = new Map<string, Extract<SessionBranchEntry, { type: 'tool_call' }>[]>();
  const callsById = new Map<string, Extract<SessionBranchEntry, { type: 'tool_call' }>>();
  for (const entry of prior)
    if (entry.type === 'tool_call') {
      const identity = `${entry.runId}:${entry.turnId}:${String(entry.requestAttempt)}`;
      const calls = callGroups.get(identity) ?? [];
      calls.push(entry);
      callGroups.set(identity, calls);
      if (entry.callId) callsById.set(entry.callId, entry);
    }
  const resultCalls = new Map(
    prior.flatMap((entry) =>
      entry.type === 'observation' && entry.callId ? [[entry.callId, entry] as const] : []
    )
  );
  for (const entry of prior) {
    const source = sourceRef(sessionId, entry);
    const key = `${source.sessionId}:${source.entryId}:${source.sha256}`;
    if (entry.type === 'input') {
      modelWindow.recordSourceItem(key, { role: 'user', content: entry.task });
      for (const [index, instruction] of entry.instructions.entries()) {
        if (instruction.provenance === 'application') continue;
        modelWindow.recordSourceItem(`${key}:instruction:${String(index)}`, {
          role: 'user',
          content: instruction.content
        });
      }
      for (const [index, context] of (entry.originalInput?.contextItems ?? []).entries()) {
        modelWindow.recordSourceItem(`${key}:context:${String(index)}`, {
          role: 'user',
          content: JSON.stringify(context)
        });
      }
    } else if (entry.type === 'steering')
      modelWindow.recordSourceItem(key, {
        role: 'user',
        content: entry.content
      });
    else if (entry.type === 'assistant') {
      const calls = (
        callGroups.get(`${entry.runId}:${entry.turnId}:${String(entry.requestAttempt)}`) ?? []
      ).map((item) => modelToolCallFromToolCall(decodeToolCall(item.call)));
      // An unfinished synchronous call remains a durable obligation; replay only complete pairs.
      const completed = calls.filter((call) => call.id && resultCalls.has(call.id));
      if (entry.output?.length) {
        const completedIds = new Set(completed.map((call) => call.id));
        const output = entry.output.filter(
          (item) => item.type !== 'tool_call' || completedIds.has(item.toolCall.id)
        );
        for (const [index, item] of modelOutputToInput(output).entries())
          modelWindow.recordSourceItem(`${key}:${String(index)}`, item);
        if (completed.length && !output.some((item) => item.type === 'tool_call'))
          modelWindow.recordSourceItem(`${key}:calls`, {
            role: 'assistant',
            content: '',
            toolCalls: completed
          });
      } else
        modelWindow.recordSourceItem(key, {
          role: 'assistant',
          content: entry.content,
          ...(completed.length ? { toolCalls: completed } : {})
        });
    } else if (entry.type === 'observation' && entry.callId) {
      const call = callsById.get(entry.callId);
      if (call?.type !== 'tool_call') continue;
      const toolCall = decodeToolCall(call.call);
      modelWindow.recordSourceItem(key, {
        role: 'tool',
        toolName: entry.toolName,
        toolCallId: entry.callId,
        toolCallType: toolCall.input.kind === 'text' ? 'custom' : 'function',
        content: JSON.stringify({
          ok: entry.ok,
          summary: entry.summary,
          ...(entry.output !== undefined ? { output: entry.output } : {}),
          ...(entry.artifacts
            ? {
                artifacts: entry.artifacts.filter((ref) => ref.visibility === 'public')
              }
            : {})
        })
      });
      toolResults++;
    }
  }
  return toolResults;
}
