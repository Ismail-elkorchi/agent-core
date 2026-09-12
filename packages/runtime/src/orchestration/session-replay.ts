import {
  modelOutputToInput,
  providerContextIncompatibility,
  type ModelInputItem,
  type ModelOutputItem,
  type ModelProtocolCapabilities,
  type ProviderContextState,
  type RequestEstimator
} from '@agent-core/model';
import type { ArtifactRef, ArtifactRepository, EventRepository } from '@agent-core/persistence';
import { decodeToolCall } from '@agent-core/tools';
import type { ContextRepresentation } from '../context/contracts.js';
import type { AgentEvent, AgentProviderStateSummary } from '../events.js';
import type { HistoryView } from '../history/contracts.js';
import { HistoryReader, historySourceAfterCut, sourceRef } from '../history/reader.js';
import { readTransformedContext } from '../inference/context-transform.js';
import { ModelWindow, type ModelWindowImageLimits } from '../inference/model-window.js';
import type { SessionBranchEntry, SessionDescriptor, SessionRepository } from '../session/contracts.js';
import { modelToolCallFromToolCall } from './model-request.js';
import { serializeToolObservationPresentation } from './observation-store.js';
import { readProviderStateArtifact } from './provider-state-artifacts.js';

export interface ModelWindowReplayResult {
  readonly modelWindow: ModelWindow;
  readonly invalidatedProviderStates: readonly {
    readonly state: ProviderContextState;
    readonly reason: string;
  }[];
  readonly replayedLedgers: number;
  readonly replayedTurns: number;
  readonly replayedSessionEntries: number;
  readonly replayedToolResults: number;
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
  readonly protocol?: ModelProtocolCapabilities;
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
          model: input.model,
          ...(input.protocol ? { protocol: input.protocol } : {})
        })
      : undefined;
  const invalidatedProviderStates = transformed?.invalidation ? [transformed.invalidation] : [];
  const target = {
    provider: input.providerId,
    model: input.model,
    ...(input.protocol ? { protocol: input.protocol } : {})
  };
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
  const active = selected.filter(
    (entry) =>
      'runId' in entry &&
      entry.runId === input.currentRunId &&
      !transformed?.represented.has(sourceRef(view?.cut.sessionId ?? 'local', entry).entryId)
  );
  const retainedAssistantEvents = new Set(
    active.flatMap((entry) => (entry.type === 'assistant' && entry.source ? [entry.source.eventId] : []))
  );
  const retainedObservations = new Set(
    active.flatMap((entry) =>
      entry.type === 'observation'
        ? [`${String(entry.toolBatchId)}:${String(entry.callIndex)}:${String(entry.toolAttempt)}`]
        : []
    )
  );
  const retainedSteering = new Set(
    active.flatMap((entry) => (entry.type === 'steering' ? [entry.deliveryId] : []))
  );
  const selectedWindow = view?.contextWindow !== undefined;
  let replayedToolResults = 0;
  replayedToolResults += replaySourceEntries(
    modelWindow,
    view?.cut.sessionId ?? 'local',
    prior,
    view?.contextWindow?.selection.representations
  );
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
        if (content && (!selectedWindow || retainedSteering.has(deliveryId)))
          modelWindow.recordInput(`steering:${deliveryId}`, {
            role: 'user',
            content
          });
      }
      if (event.type === 'provider.attempt.settled' && event.response.output)
        outputByTurn.set(`${event.turnId}:${String(event.requestAttempt)}`, event.response.output);
      const output =
        'turnId' in event ? outputByTurn.get(`${event.turnId}:${String(event.requestAttempt)}`) : undefined;
      if (
        event.type === 'assistant.ended' &&
        (!selectedWindow || retainedAssistantEvents.has(record.eventId))
      )
        modelWindow.recordModelOutput({
          turnIndex: event.turnIndex,
          content: event.content,
          toolCalls: (event.toolCalls ?? []).map(modelToolCallFromToolCall),
          ...(output ? { output } : {})
        });
      else if (
        event.type === 'observation.record.created' &&
        (!selectedWindow ||
          retainedObservations.has(
            `${event.toolBatchId}:${String(event.callIndex)}:${String(event.toolAttempt)}`
          ))
      ) {
        modelWindow.recordToolResult({
          turnIndex: event.turnIndex,
          toolName: event.toolName,
          toolCallType: event.toolCallType,
          ...(event.callId ? { callId: event.callId } : {}),
          immediateContent: serializeToolObservationPresentation(event.immediatePresentation)
        });
        replayedToolResults++;
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
      if (ref) {
        providerState = undefined;
        providerStateSummary = undefined;
        providerStateRef = undefined;
      }
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
        const reason = state ? providerContextIncompatibility(state, target) : undefined;
        if (state && reason) invalidatedProviderStates.push({ state, reason });
        if (state && !reason) {
          providerState = state;
          providerStateSummary = ref.summary;
          providerStateRef = ref.ref;
        }
      }
    }
  }
  if (view && input.currentRunId)
    modelWindow.selectToolResultPresentations(activeObservationRepresentations(view, input.currentRunId));
  invalidatedProviderStates.push(...modelWindow.invalidateProviderState(target));
  return {
    modelWindow,
    invalidatedProviderStates: Object.freeze(invalidatedProviderStates),
    replayedLedgers,
    replayedTurns: view?.runFinalizations.length ?? 0,
    replayedSessionEntries: prior.length,
    replayedToolResults,
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
  prior: readonly SessionBranchEntry[],
  representations: readonly ContextRepresentation[] = []
): number {
  const summaries = new Set(representations.map((item) => item.source.entryId));
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
        content: observationContextContent(entry, source, summaries.has(source.entryId))
      });
      toolResults++;
    }
  }
  return toolResults;
}

export function observationContextContent(
  entry: Extract<SessionBranchEntry, { readonly type: 'observation' }>,
  source: ReturnType<typeof sourceRef>,
  summary: boolean
): string {
  return JSON.stringify({
    ok: entry.ok,
    summary: entry.summary,
    ...(!summary && entry.output !== undefined ? { output: entry.output } : {}),
    ...(entry.artifacts ? { artifacts: entry.artifacts.filter((ref) => ref.visibility === 'public') } : {}),
    ...(summary ? { representation: 'summary', source } : {})
  });
}

export function activeObservationRepresentations(
  view: HistoryView,
  runId: string
): ReadonlyMap<string, Extract<ModelInputItem, { readonly role: 'tool' }>> {
  const selected = new Set(view.contextWindow?.selection.representations?.map((item) => item.source.entryId));
  const messages = new Map<string, Extract<ModelInputItem, { readonly role: 'tool' }>>();
  for (const entry of view.entries) {
    if (entry.type !== 'observation' || entry.runId !== runId || !entry.callId) continue;
    const source = sourceRef(view.cut.sessionId, entry);
    if (!selected.has(source.entryId)) continue;
    const call = view.entries.find(
      (item) => item.type === 'tool_call' && item.runId === runId && item.callId === entry.callId
    );
    if (call?.type !== 'tool_call') throw new Error('Selected observation has no original call.');
    messages.set(
      entry.callId,
      Object.freeze({
        role: 'tool',
        toolName: entry.toolName,
        toolCallId: entry.callId,
        toolCallType: decodeToolCall(call.call).input.kind === 'text' ? 'custom' : 'function',
        content: observationContextContent(entry, source, true)
      })
    );
  }
  return messages;
}
