import { resolveToolModelContent } from './observation-source.js';
import { ModelContinuationRequiredError } from './model-change.js';
import {
  modelOutputToInput,
  CompleteRequestEstimator,
  assertModelRequestSupported,
  providerContextIncompatibility,
  type ModelInputItem,
  type ModelImage,
  type ModelOutputItem,
  type ModelProfile,
  type ModelProtocolCapabilities,
  type ProviderContextState,
  type RequestEstimator
} from '@agent-core/model';
import type { ArtifactRef, ArtifactRepository, EventRepository } from '@agent-core/persistence';
import { decodeToolCall } from '@agent-core/tools';
import type { AgentEvent, AgentProviderStateSummary } from '../events.js';
import type { HistorySourceCut } from '../history/contracts.js';
import type { ContextWindowRecord } from '../context/contracts.js';
import { ContextSourceCapacityError } from '../run/context-admission.js';
import { HistorySourceTooLargeError, HistoryReader, sourceRef } from '../history/reader.js';
import { readTransformedContext } from '../inference/context-transform.js';
import { ModelWindow, type ModelWindowImageLimits } from '../inference/model-window.js';
import type { SessionBranchEntry } from '../session/contracts.js';
import { resolveSessionImages } from '../session/images.js';
import { modelToolCallFromToolCall } from './model-request.js';
import { serializeToolModelContent } from '@agent-core/tools';
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
  readonly history?: HistoryReader;
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
  const view = input.history ? await readSelectedHistorySources(input.history) : undefined;
  const selected = view?.entries ?? [];
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
    active.flatMap((entry) =>
      entry.type === 'assistant' && entry.source ? [entry.source.eventId] : []
    )
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
  replayedToolResults += await replaySourceEntries(
    modelWindow,
    view?.cut.sessionId ?? 'local',
    prior,
    input.artifacts,
    new Set(view?.contextWindow?.selection.continuity?.sources.map((source) => source.entryId))
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
          event.type === 'input.steering.local_applied'
            ? event.deliveryId
            : event.delivery.deliveryId;
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
        'turnId' in event
          ? outputByTurn.get(`${event.turnId}:${String(event.requestAttempt)}`)
          : undefined;
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
        const modelContent = await resolveToolModelContent(event, input.artifacts);
        modelWindow.recordToolResult({
          turnIndex: event.turnIndex,
          toolName: event.toolName,
          toolCallType: event.toolCallType,
          ...(event.callId ? { callId: event.callId } : {}),
          immediateContent: serializeToolModelContent(modelContent),
          immediateImages: await recordedModelImages(modelContent, input.artifacts)
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
  invalidatedProviderStates.push(...modelWindow.invalidateProviderState(target));
  const incompatibleState = invalidatedProviderStates[0];
  if (incompatibleState) throw new ModelContinuationRequiredError(incompatibleState.reason);
  return {
    modelWindow,
    invalidatedProviderStates: Object.freeze(invalidatedProviderStates),
    replayedLedgers,
    replayedTurns: new Set(selected.flatMap((entry) => ('runId' in entry ? [entry.runId] : [])))
      .size,
    replayedSessionEntries: prior.length,
    replayedToolResults,
    ...(providerState ? { providerState } : {}),
    ...(providerStateSummary ? { providerStateSummary } : {}),
    ...(providerStateRef ? { providerStateRef } : {})
  };
}

export interface SelectedHistorySources {
  readonly cut: HistorySourceCut;
  readonly entries: readonly SessionBranchEntry[];
  readonly contextWindow?: ContextWindowRecord | undefined;
}

/** Resolve only the selected originals and the bounded tail following their immutable cut. */
// One bounded selected window per reader; immutable cuts remain the authority.
const selectedSourceCache = new WeakMap<
  HistoryReader,
  { readonly value: SelectedHistorySources; readonly bytes: number }
>();
export async function readSelectedHistorySources(
  history: HistoryReader,
  cut?: HistorySourceCut
): Promise<SelectedHistorySources> {
  cut ??= await history.capture();
  const contextWindow = await history.selectedContext(cut);
  const cached = selectedSourceCache.get(history);
  const previous =
    cached &&
    cached.value.contextWindow?.windowId === contextWindow?.windowId &&
    (await history.extendsCut(cached.value.cut, cut))
      ? cached
      : undefined;

  const entries: SessionBranchEntry[] = [...(previous?.value.entries ?? [])];
  const ids = new Set(entries.map((entry) => sourceRef(cut.sessionId, entry).entryId));
  let bytes = previous?.bytes ?? 0;
  const append = (entry: SessionBranchEntry) => {
    const id = sourceRef(cut.sessionId, entry).entryId;
    if (ids.has(id)) return;
    bytes += new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (bytes > 8 * 1024 * 1024 || entries.length >= 10000)
      throw new ContextSourceCapacityError(
        cut,
        bytes > 8 * 1024 * 1024
          ? { unit: 'bytes', limit: 8 * 1024 * 1024, observedAtLeast: bytes }
          : { unit: 'entries', limit: 10000, observedAtLeast: entries.length + 1 }
      );
    entries.push(entry);
    ids.add(id);
  };
  for (const source of previous ? [] : (contextWindow?.selection.retained ?? [])) {
    let entry;
    try {
      entry = await history.resolve(source, cut, Math.max(1, 8 * 1024 * 1024 - bytes));
    } catch (error) {
      if (!(error instanceof HistorySourceTooLargeError)) throw error;
      throw new ContextSourceCapacityError(
        cut,
        {
          unit: 'bytes',
          limit: 8 * 1024 * 1024,
          observedAtLeast: Math.max(8 * 1024 * 1024 + 1, bytes + error.bytes)
        },
        source
      );
    }
    if (!entry) throw new Error('Committed context source is unavailable at its history cut.');
    append(entry);
  }
  let cursor: string | undefined;
  do {
    if (bytes >= 8 * 1024 * 1024)
      throw new ContextSourceCapacityError(cut, {
        unit: 'bytes',
        limit: 8 * 1024 * 1024,
        observedAtLeast: bytes + 1
      });
    const page = await history.page({
      cut,
      ...(previous
        ? { after: previous.value.cut }
        : contextWindow
          ? { after: contextWindow.historyPosition }
          : {}),
      ...(cursor ? { cursor } : {}),
      limit: 1000,
      maxBytes: 8 * 1024 * 1024 - bytes
    });
    const unavailable = page.unavailable?.[0];
    if (unavailable)
      throw new ContextSourceCapacityError(
        cut,
        unavailable.records
          ? { unit: 'records', limit: 1000, observedAtLeast: unavailable.records }
          : {
              unit: 'bytes',
              limit: 8 * 1024 * 1024,
              observedAtLeast: Math.max(8 * 1024 * 1024 + 1, bytes + unavailable.bytes)
            },
        unavailable.source
      );
    for (const entry of page.entries) append(entry);
    cursor = page.cursor;
  } while (cursor);
  const result = Object.freeze({
    cut,
    entries: await history.orderEntries(entries, cut),
    ...(contextWindow ? { contextWindow } : {})
  });
  selectedSourceCache.set(history, { value: result, bytes });
  return result;
}

export async function replaySourceEntries(
  modelWindow: ModelWindow,
  sessionId: string,
  prior: readonly SessionBranchEntry[],
  artifacts?: ArtifactRepository,
  portableSources: ReadonlySet<string> = new Set(),
  currentRunId?: string
): Promise<number> {
  let toolResults = 0;
  const callGroups = new Map<string, Extract<SessionBranchEntry, { type: 'tool_call' }>[]>();
  const callsById = new Map<string, Extract<SessionBranchEntry, { type: 'tool_call' }>>();
  for (const entry of prior)
    if (entry.type === 'tool_call') {
      const identity = `${entry.runId}:${entry.turnId}:${String(entry.requestAttempt)}`;
      const calls = callGroups.get(identity) ?? [];
      calls.push(entry);
      callGroups.set(identity, calls);
      if (entry.callId) callsById.set(`${entry.runId}:${entry.callId}`, entry);
    }
  const resultCalls = new Map(
    prior.flatMap((entry) =>
      entry.type === 'observation' && entry.callId
        ? [[`${entry.runId}:${entry.callId}`, entry] as const]
        : []
    )
  );
  for (const entry of prior) {
    const source = sourceRef(sessionId, entry);
    const key = `${source.sessionId}:${source.entryId}:${source.sha256}`;
    const active = 'runId' in entry && entry.runId === currentRunId;
    const record = (id: string, item: ModelInputItem) => {
      if (active) modelWindow.recordInput(id, item, 'turnIndex' in entry ? entry.turnIndex : 0);
      else modelWindow.recordSourceItem(id, item);
    };
    if (entry.type === 'input' && active) continue;
    if (entry.type === 'input') {
      record(key, {
        role: 'user',
        content: entry.task,
        ...(entry.images === undefined
          ? {}
          : {
              images: await resolveSessionImages(
                entry.images,
                artifacts,
                modelWindow.imageLimits.maxBytes
              )
            })
      });
      for (const [index, instruction] of entry.instructions.entries()) {
        if (instruction.provenance === 'application') continue;
        record(`${key}:instruction:${String(index)}`, {
          role: 'user',
          content: instruction.content
        });
      }
      for (const [index, context] of (entry.originalInput?.contextItems ?? []).entries()) {
        record(`${key}:context:${String(index)}`, {
          role: 'user',
          content: JSON.stringify(context)
        });
      }
    } else if (entry.type === 'steering') {
      record(key, {
        role: 'user',
        content: entry.content,
        ...(entry.originalInput?.images === undefined
          ? {}
          : {
              images: await resolveSessionImages(
                entry.originalInput.images,
                artifacts,
                modelWindow.imageLimits.maxBytes
              )
            })
      });
      for (const [index, instruction] of (entry.originalInput?.instructions ?? []).entries())
        record(`${key}:instruction:${String(index)}`, { role: 'user', content: instruction });
      for (const [index, context] of (entry.originalInput?.contextItems ?? []).entries())
        record(`${key}:context:${String(index)}`, {
          role: 'user',
          content: JSON.stringify(context)
        });
    } else if (entry.type === 'assistant') {
      const calls = (
        callGroups.get(`${entry.runId}:${entry.turnId}:${String(entry.requestAttempt)}`) ?? []
      ).map((item) => modelToolCallFromToolCall(decodeToolCall(item.call)));
      // An unfinished synchronous call remains a durable obligation; replay only complete pairs.
      const completed = calls.filter(
        (call) => call.id && resultCalls.has(`${entry.runId}:${call.id}`)
      );
      if (entry.output?.length) {
        const completedIds = new Set(completed.map((call) => call.id));
        const output = entry.output.filter(
          (item) =>
            (item.type !== 'protocol' || !portableSources.has(source.entryId)) &&
            (item.type !== 'tool_call' || completedIds.has(item.toolCall.id))
        );
        if (
          portableSources.has(source.entryId) &&
          entry.content &&
          !output.some((item) => item.type === 'text' || item.type === 'refusal')
        )
          record(`${key}:answer`, { role: 'assistant', content: entry.content });
        for (const [index, item] of modelOutputToInput(output).entries())
          record(`${key}:${String(index)}`, item);
        if (completed.length && !output.some((item) => item.type === 'tool_call'))
          record(`${key}:calls`, {
            role: 'assistant',
            content: '',
            toolCalls: completed
          });
      } else
        record(key, {
          role: 'assistant',
          content: entry.content,
          ...(completed.length ? { toolCalls: completed } : {})
        });
    } else if (entry.type === 'observation' && entry.callId) {
      const call = callsById.get(`${entry.runId}:${entry.callId}`);
      if (call?.type !== 'tool_call') continue;
      const toolCall = decodeToolCall(call.call);
      const modelContent = await resolveToolModelContent(entry, artifacts);
      record(key, {
        role: 'tool',
        toolName: entry.toolName,
        toolCallId: entry.callId,
        toolCallType: toolCall.input.kind === 'text' ? 'custom' : 'function',
        content: serializeToolModelContent(modelContent),
        images: await recordedModelImages(modelContent, artifacts)
      });
      toolResults++;
    }
  }
  return toolResults;
}

/** Validates a proposed selection without changing admitted context or immutable history. */
export async function assertHistoryModelCompatibility(input: {
  readonly history: HistoryReader;
  readonly artifacts: ArtifactRepository;
  readonly profile: ModelProfile;
}): Promise<void> {
  const view = await readSelectedHistorySources(input.history);
  const target = {
    provider: input.profile.provider,
    model: input.profile.id,
    ...(input.profile.capabilities.protocol === undefined
      ? {}
      : { protocol: input.profile.capabilities.protocol })
  };
  const transformed = await readTransformedContext({ view, artifacts: input.artifacts, ...target });
  const incompatible = (reason: string): never => {
    throw new ModelContinuationRequiredError(reason);
  };
  if (transformed.invalidation !== undefined) incompatible(transformed.invalidation.reason);
  for (const entry of view.entries) {
    if (
      ((entry.type === 'input' && entry.images?.length) ||
        (entry.type === 'steering' && entry.originalInput?.images?.length)) &&
      !input.profile.modalities.input.includes('image')
    ) {
      throw new Error(
        'The selected model cannot receive images in this session. Choose an image-capable model or explicitly change the selected image source.'
      );
    }
    if (
      !input.profile.modalities.input.includes('image') &&
      ((entry.type === 'observation' &&
        (await resolveToolModelContent(entry, input.artifacts)).some(
          (part) => part.type === 'image'
        )) ||
        (entry.type === 'assistant' &&
          entry.output?.some((item) => item.type === 'media' && item.part.type === 'image')))
    )
      throw new Error(
        'The selected model cannot receive the selected original images. Choose an image-capable model or explicitly change the selected image representation.'
      );
    if (transformed.represented.has(sourceRef(view.cut.sessionId, entry).entryId)) continue;
    if (
      entry.type !== 'assistant' ||
      view.contextWindow?.selection.continuity?.sources.some(
        (source) => source.entryId === sourceRef(view.cut.sessionId, entry).entryId
      )
    )
      continue;
    for (const item of entry.output ?? []) {
      if (item.type !== 'protocol') continue;
      const reason = providerContextIncompatibility(item.state, target);
      if (reason !== undefined) incompatible(reason);
    }
  }
}

/** Validate the originals before recording a user-authorized portable representation. */
export function assertPortableHistorySources(
  entries: readonly SessionBranchEntry[],
  profile: ModelProfile
): void {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const entry of entries) {
    if (
      ((entry.type === 'input' && entry.images?.length) ||
        (entry.type === 'steering' && entry.originalInput?.images?.length)) &&
      !profile.modalities.input.includes('image')
    )
      throw new Error(
        'The selected model cannot receive the selected images. Choose an image-capable model or explicitly change the selected image source.'
      );
    if (
      entry.type === 'observation' &&
      entry.modelContent?.some((part) => part.type === 'image') &&
      !profile.modalities.input.includes('image')
    )
      throw new Error(
        'The selected model cannot receive images in the recorded tool result. Choose an image-capable model or explicitly change its selected representation.'
      );
    if (entry.type === 'tool_call') {
      const call = decodeToolCall(entry.call);
      if (!call.id || call.id !== entry.callId)
        throw new Error('Fresh continuation requires the original tool call identity.');
      calls.add(`${entry.runId}:${call.id}`);
    }
    if (entry.type === 'observation' && entry.callId) results.add(`${entry.runId}:${entry.callId}`);
    if (entry.type === 'assistant') {
      for (const item of entry.output ?? []) {
        if (item.type === 'tool_call') {
          if (!item.toolCall.id)
            throw new Error('Fresh continuation requires the original native tool call identity.');
          calls.add(`${entry.runId}:${item.toolCall.id}`);
        }
        if (
          item.type === 'media' &&
          (item.part.type !== 'image' || !profile.modalities.input.includes('image'))
        )
          throw new Error(
            'Fresh continuation cannot discard selected assistant media. Choose a compatible model or an authorized portable representation of this source.'
          );
      }
    }
  }
  for (const call of calls)
    if (!results.has(call))
      throw new Error(
        'Fresh continuation is blocked by an unfinished tool exchange. Settle or reconcile its original result delivery first.'
      );
  for (const result of results)
    if (!calls.has(result))
      throw new Error(
        'Fresh continuation requires the original call for every selected tool observation.'
      );
}

async function recordedModelImages(
  content: readonly import('@agent-core/tools').ToolContent[],
  artifacts?: ArtifactRepository
): Promise<readonly ModelImage[]> {
  return Promise.all(
    content
      .filter((part) => part.type === 'image')
      .map(async (part): Promise<ModelImage> => {
        if (!artifacts)
          throw new Error('Selected tool images require the original artifact repository.');
        if (!part.artifact.mediaType.startsWith('image/'))
          throw new Error('Selected image artifact has an invalid media type.');
        return {
          type: 'bytes',
          data: await artifacts.readVerified(part.artifact),
          mediaType: part.artifact.mediaType as `image/${string}`,
          detail: part.detail
        };
      })
  );
}

/** Check portable source bytes and target protocol/modality before committing their selection. */
export async function assertPortableHistoryCompatibility(input: {
  readonly sessionId: string;
  readonly entries: readonly SessionBranchEntry[];
  readonly profile: ModelProfile;
  readonly artifacts: ArtifactRepository;
}): Promise<void> {
  assertPortableHistorySources(input.entries, input.profile);
  const window = new ModelWindow(new CompleteRequestEstimator());
  await replaySourceEntries(
    window,
    input.sessionId,
    input.entries,
    input.artifacts,
    new Set(input.entries.map((entry) => sourceRef(input.sessionId, entry).entryId))
  );
  assertModelRequestSupported(input.profile, {
    model: input.profile.id,
    messages: window.priorMessagesFor(input.profile).messages
  });
}
