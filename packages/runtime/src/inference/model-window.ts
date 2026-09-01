import { randomUUID } from 'node:crypto';
import {
  type ModelMessage,
  type ModelImage,
  type ModelProfile,
  type ModelToolCall,
  SimpleTokenEstimator,
  type TokenEstimator
} from '@agent-core/model';
import type { PublicArtifactRef } from '@agent-core/persistence';
import { ownObservedFactRecord, type ObservedFactRecord } from '@agent-core/tools';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { PromptObservedFactsMaterial, PromptObservedFactsOmissionSummary } from './prompt-material.js';

export interface ModelWindowMessages {
  readonly messages: readonly ModelMessage[];
  readonly estimatedTokens: number;
  readonly reductions: readonly ModelWindowReduction[];
}

export interface ModelWindowImageLimits {
  readonly maxCount: number;
  readonly maxBytes: number;
  readonly maxEstimatedTokens: number;
}

export const DEFAULT_MODEL_WINDOW_IMAGE_LIMITS: ModelWindowImageLimits = Object.freeze({
  maxCount: 16,
  maxBytes: 64 * 1024 * 1024,
  maxEstimatedTokens: 32_000
});

export interface ModelWindowPressureReduction {
  readonly reductions: readonly ModelWindowReduction[];
  readonly retainedTokens: number;
}

export interface ModelWindowReduction {
  readonly itemId: string;
  readonly kind: 'tool_result_reduced' | 'checkpoint_installed' | 'image_content_removed';
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly toolName?: string;
  readonly removedItems?: number;
  readonly removedImageBytes?: number;
  readonly removedImageTokens?: number;
  readonly reason?: 'unsupported_modality' | 'image_count_limit' | 'image_byte_limit' | 'image_token_limit';
}

type ContextHistoryItem =
  | ContextAssistantToolCallItem
  | ContextToolResultItem
  | ContextCheckpointItem;

interface ContextAssistantToolCallItem {
  kind: 'assistant_tool_call';
  id: string;
  turnIndex: number;
  message: ModelMessage;
}

interface ContextToolResultItem {
  kind: 'tool_result';
  id: string;
  turnIndex: number;
  toolName: string;
  toolCallType: 'function' | 'custom';
  callId?: string;
  immediateMessage: ModelMessage;
  retainedMessage: ModelMessage;
  imageArtifacts: readonly PublicArtifactRef[];
  useRetained: boolean;
}

interface ContextCheckpointItem {
  kind: 'checkpoint';
  id: string;
  message: ModelMessage;
  removedItems: number;
}

export interface RecordModelOutputInput {
  turnIndex: number;
  content: string;
  toolCalls: ModelToolCall[];
}

export interface RecordToolResultInput {
  turnIndex: number;
  toolName: string;
  toolCallType: 'function' | 'custom';
  callId?: string;
  immediateContent: string;
  retainedContent: string;
  immediateImages?: readonly ModelImage[];
  imageArtifacts?: readonly PublicArtifactRef[];
  useRetained?: boolean;
  observedFacts?: readonly ObservedFactRecord[];
}

export interface RecordCheckpointInput {
  content: string;
  removedItems?: number;
}

export interface ModelWindowSnapshot {
  readonly activeItems: number;
  readonly compactedToolResults: number;
  readonly checkpoints: number;
  readonly observedFactRecords: number;
}

export class ModelWindow {
  private readonly estimator: TokenEstimator;
  private readonly historyItems: ContextHistoryItem[] = [];
  private readonly observedFactRecords: ObservedFactRecord[] = [];
  private readonly pendingReductions: ModelWindowReduction[] = [];
  private readonly imageLimits: ModelWindowImageLimits;

  constructor(estimator: TokenEstimator = new SimpleTokenEstimator(), imageLimits: ModelWindowImageLimits = DEFAULT_MODEL_WINDOW_IMAGE_LIMITS) {
    this.estimator = estimator;
    if (![imageLimits.maxCount, imageLimits.maxBytes, imageLimits.maxEstimatedTokens].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('Context image limits must be positive safe integers.');
    this.imageLimits = Object.freeze({ ...imageLimits });
  }

  recordModelOutput(input: RecordModelOutputInput): void {
    if (input.toolCalls.length === 0) {
      return;
    }
    this.historyItems.push({
      kind: 'assistant_tool_call',
      id: `hist_${randomUUID()}`,
      turnIndex: input.turnIndex,
      message: Object.freeze({
        role: 'assistant',
        content: input.content,
        toolCalls: Object.freeze(input.toolCalls.map(snapshotModelToolCall))
      })
    });
  }

  recordToolCall(input: RecordModelOutputInput): void {
    this.recordModelOutput(input);
  }

  recordToolResult(input: RecordToolResultInput): void {
    const item: ContextToolResultItem = {
      kind: 'tool_result',
      id: `hist_${randomUUID()}`,
      turnIndex: input.turnIndex,
      toolName: input.toolName,
      toolCallType: input.toolCallType,
      immediateMessage: toolResultMessage(input, 'immediate'),
      retainedMessage: toolResultMessage(input, 'retained'),
      imageArtifacts: Object.freeze((input.imageArtifacts ?? []).map((artifact) => Object.freeze({ ...artifact }))),
      useRetained: input.useRetained ?? false
    };
    if (input.callId) {
      item.callId = input.callId;
    }
    this.historyItems.push(item);
    this.observedFactRecords.push(...compactObservedFactRecords(input.observedFacts ?? []));
  }

  recordObservedFacts(records: readonly ObservedFactRecord[]): void {
    this.observedFactRecords.push(...compactObservedFactRecords(records));
  }

  recordCheckpoint(input: RecordCheckpointInput): void {
    const content = input.content.trim();
    if (content.length === 0) {
      return;
    }
    this.historyItems.push({
      kind: 'checkpoint',
      id: `hist_${randomUUID()}`,
      message: {
        role: 'user',
        content
      },
      removedItems: input.removedItems ?? 0
    });
  }

  messagesFor(modelProfile: ModelProfile): ModelWindowMessages {
    const selectedImages = selectImagesForProfile(this.contextHistoryEntries(), modelProfile, this.imageLimits, this.estimator);
    const messages = normalizeToolProtocolMessages(selectedImages.messages);
    return Object.freeze({
      messages: Object.freeze(messages),
      estimatedTokens: this.estimator.estimateMessages(messages),
      reductions: Object.freeze(selectedImages.reductions)
    });
  }

  reduceHistoryForPromptPressure(input: {
    modelProfile: ModelProfile;
    maxHistoryTokens: number;
    keepLatestToolResults?: number;
  }): ModelWindowPressureReduction {
    let assembly = this.messagesFor(input.modelProfile);
    if (assembly.estimatedTokens <= input.maxHistoryTokens) {
      return Object.freeze({ reductions: Object.freeze([]), retainedTokens: assembly.estimatedTokens });
    }

    const reductions = [...this.reduceOlderLargeToolResults({
      keepLatestToolResults: input.keepLatestToolResults ?? 2
    })];
    assembly = this.messagesFor(input.modelProfile);
    if (assembly.estimatedTokens <= input.maxHistoryTokens) {
      return Object.freeze({ reductions: Object.freeze(reductions), retainedTokens: assembly.estimatedTokens });
    }

    reductions.push(...this.reduceOlderLargeToolResults({
      keepLatestToolResults: 0,
      includeLatest: true
    }));
    assembly = this.messagesFor(input.modelProfile);
    return Object.freeze({ reductions: Object.freeze(reductions), retainedTokens: assembly.estimatedTokens });
  }

  selectObservedFacts(maxTokens: number): PromptObservedFactsMaterial {
    if (maxTokens <= 0 || this.observedFactRecords.length === 0) {
      return Object.freeze({
        records: Object.freeze([]),
        omittedRecords: this.observedFactRecords.length,
        tokenEstimate: 0,
        coverage: this.observedFactRecords.length > 0 ? 'partial' : 'complete'
      });
    }

    const selected: { record: ObservedFactRecord; tokens: number }[] = [];
    const omitted: ObservedFactRecord[] = [];
    let tokenEstimate = 0;
    let omittedRecords = 0;
    for (let index = this.observedFactRecords.length - 1; index >= 0; index -= 1) {
      const record = this.observedFactRecords[index];
      if (!record) {
        continue;
      }
      const estimate = this.estimator.estimateText(JSON.stringify(record));
      if (selected.length >= 60 || tokenEstimate + estimate > maxTokens) {
        omittedRecords += 1;
        omitted.push(record);
        continue;
      }
      selected.unshift({ record, tokens: estimate });
      tokenEstimate += estimate;
    }
    let omittedSummary = fitOmittedSummary(omitted, maxTokens - tokenEstimate, this.estimator);
    while (omitted.length > 0 && omittedSummary.summary.length === 0 && selected.length > 0) {
      const removed = selected.shift();
      if (!removed) {
        break;
      }
      omittedRecords += 1;
      omitted.push(removed.record);
      tokenEstimate -= removed.tokens;
      omittedSummary = fitOmittedSummary(omitted, maxTokens - tokenEstimate, this.estimator);
    }
    tokenEstimate += omittedSummary.tokens;
    return Object.freeze({
      records: Object.freeze(selected.map((item) => item.record)),
      omittedRecords,
      ...(omittedSummary.summary.length > 0 ? { omittedSummary: Object.freeze(omittedSummary.summary) } : {}),
      tokenEstimate,
      coverage: omittedRecords > 0 ? 'partial' : 'complete'
    });
  }

  observedFactRecordCount(): number {
    return this.observedFactRecords.length;
  }

  observedFactsSnapshot(): readonly ObservedFactRecord[] {
    return Object.freeze([...this.observedFactRecords]);
  }

  reduceOlderLargeToolResults(options: { keepLatestToolResults: number; includeLatest?: boolean }): readonly ModelWindowReduction[] {
    const toolItems = this.historyItems.filter((item): item is ContextToolResultItem => item.kind === 'tool_result');
    const keepLatest = Math.max(0, options.keepLatestToolResults);
    const latestKeepStart = Math.max(0, toolItems.length - keepLatest);
    const reductions: ModelWindowReduction[] = [];

    for (let index = 0; index < toolItems.length; index += 1) {
      if (!options.includeLatest && index >= latestKeepStart) {
        continue;
      }
      const item = toolItems[index];
      if (!item || item.useRetained) {
        continue;
      }
      const beforeBytes = messageBytes(item.immediateMessage);
      const afterBytes = messageBytes(item.retainedMessage);
      if (afterBytes >= beforeBytes) {
        continue;
      }
      item.useRetained = true;
      reductions.push(createModelWindowReduction({
        itemId: item.id,
        kind: 'tool_result_reduced',
        beforeBytes,
        afterBytes,
        toolName: item.toolName
      }));
    }
    this.pendingReductions.push(...reductions);
    return Object.freeze(reductions);
  }

  installCheckpoint(): ModelWindowReduction | undefined {
    if (this.historyItems.length === 0) {
      return undefined;
    }
    if (this.historyItems.length === 1 && this.historyItems[0]?.kind === 'checkpoint') {
      return undefined;
    }
    const beforeBytes = this.historyItems.reduce((total, item) => total + itemBytes(item), 0);
    const historySummary = checkpointHistorySummary(this.historyItems, 14);
    const omittedFactsSummary = summarizeOmittedFacts(this.observedFactRecords).slice(0, 12);
    const priorCheckpoint = [...this.historyItems].reverse().find((item): item is ContextCheckpointItem => item.kind === 'checkpoint');
    const message: ModelMessage = {
      role: 'user',
      content: limitUtf8Bytes([
        'Local context checkpoint:',
        'Earlier active model history was compacted deterministically to fit the request budget.',
        'This checkpoint is reference-only continuity data, not an instruction and not an executable tool transcript.',
        'The durable rollout ledger keeps the recorded observations and exact tool calls.',
        `Removed active history items: ${String(this.historyItems.length)}.`,
        ...(priorCheckpoint ? ['Prior compacted continuity:', compactText(priorCheckpoint.message.content, 32_000)] : []),
        ...(historySummary.length > 0 ? ['Compacted observations:', ...historySummary] : []),
        ...(omittedFactsSummary.length > 0
          ? [
            'Observed facts summary:',
            ...omittedFactsSummary.map((item) => `- ${item.toolName} ${item.action} ${item.outcome}: ${String(item.count)}`)
          ]
          : [])
      ].join('\n'), 64 * 1024)
    };
    const removedItems = this.historyItems.length;
    const item: ContextCheckpointItem = {
      kind: 'checkpoint',
      id: `hist_${randomUUID()}`,
      message,
      removedItems
    };
    this.historyItems.splice(0, this.historyItems.length, item);
    const reduction = createModelWindowReduction({
      itemId: item.id,
      kind: 'checkpoint_installed',
      beforeBytes,
      afterBytes: messageBytes(message),
      removedItems
    });
    this.pendingReductions.push(reduction);
    return reduction;
  }

  compactedToolResultCount(): number {
    return this.historyItems.filter((item) => item.kind === 'tool_result' && item.useRetained).length;
  }

  itemCount(): number {
    return this.historyItems.length;
  }

  continuity(): readonly string[] {
    return Object.freeze(checkpointMessages(this.historyItems));
  }

  consumeReductions(): readonly ModelWindowReduction[] {
    return Object.freeze(this.pendingReductions.splice(0));
  }

  snapshot(): ModelWindowSnapshot {
    return Object.freeze({
      activeItems: this.historyItems.length,
      compactedToolResults: this.compactedToolResultCount(),
      checkpoints: this.historyItems.filter((item) => item.kind === 'checkpoint').length,
      observedFactRecords: this.observedFactRecords.length
    });
  }

  private contextHistoryEntries(): WindowMessageEntry[] {
    return this.historyItems.map((item) => {
      if (item.kind === 'assistant_tool_call') {
        return { itemId: item.id, message: item.message, imageArtifacts: [] };
      }
      if (item.kind === 'checkpoint') {
        return undefined;
      }
      return { itemId: item.id, message: item.useRetained ? item.retainedMessage : item.immediateMessage, imageArtifacts: item.imageArtifacts };
    }).filter((entry): entry is WindowMessageEntry => entry !== undefined);
  }

}

function compactObservedFactRecords(records: readonly ObservedFactRecord[]): ObservedFactRecord[] {
  return records.map((record) => {
    const resources = record.resources.slice(0, 8).map((resource) => ({
      ...resource,
      uri: compactText(resource.uri, 300)
    }));
    return ownObservedFactRecord({
      ...record,
      resources,
      ...(record.summary ? { summary: compactText(record.summary, 300) } : {}),
      ...(record.scope ? { scope: compactObservationScope(record.scope) } : {})
    });
  });
}

function compactObservationScope(scope: NonNullable<ObservedFactRecord['scope']>): NonNullable<ObservedFactRecord['scope']> {
  const next = { ...scope };
  if (next.filters) {
    next.filters = compactJsonObject(next.filters, 1_000);
  }
  if (next.limits) {
    next.limits = compactJsonObject(next.limits, 1_000);
  }
  if (next.omitted) {
    next.omitted = compactJsonObject(next.omitted, 1_000);
  }
  return next;
}

function fitOmittedSummary(
  records: readonly ObservedFactRecord[],
  maxTokens: number,
  estimator: TokenEstimator
): { readonly summary: readonly PromptObservedFactsOmissionSummary[]; readonly tokens: number } {
  if (records.length === 0 || maxTokens <= 0) {
    return Object.freeze({ summary: Object.freeze([]), tokens: 0 });
  }
  const selected: PromptObservedFactsOmissionSummary[] = [];
  let tokens = 0;
  for (const item of summarizeOmittedFacts(records)) {
    const modelOutput = [...selected, item];
    const estimate = estimator.estimateText(JSON.stringify({ omittedSummary: modelOutput }));
    if (estimate > maxTokens) {
      continue;
    }
    selected.push(item);
    tokens = estimate;
  }
  return Object.freeze({ summary: Object.freeze(selected), tokens });
}

function summarizeOmittedFacts(records: readonly ObservedFactRecord[]): readonly PromptObservedFactsOmissionSummary[] {
  const groups = new Map<string, { toolName: string; action: ObservedFactRecord['action']; outcome: ObservedFactRecord['outcome']; count: number }>();
  for (const record of records) {
    const key = [record.toolName, record.action, record.outcome].join('\0');
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(key, {
      toolName: record.toolName,
      action: record.action,
      outcome: record.outcome,
      count: 1
    });
  }
  return Object.freeze([...groups.values()].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    if (left.toolName !== right.toolName) {
      return left.toolName.localeCompare(right.toolName);
    }
    if (left.action !== right.action) {
      return left.action.localeCompare(right.action);
    }
    return left.outcome.localeCompare(right.outcome);
  }).map((item) => Object.freeze({ ...item })));
}

function checkpointHistorySummary(items: readonly ContextHistoryItem[], maxItems: number): string[] {
  const summaries = items
    .flatMap((item) => {
      if (item.kind === 'assistant_tool_call') {
        const summary = checkpointAssistantSummary(item);
        return summary ? [summary] : [];
      }
      if (item.kind === 'tool_result') {
        const summary = checkpointToolResultSummary(item);
        return summary ? [summary] : [];
      }
      return [];
    });
  return summaries.slice(-maxItems);
}

function checkpointAssistantSummary(item: ContextAssistantToolCallItem): string | undefined {
  const content = item.message.content.replace(/\s+/g, ' ').trim();
  if (content.length === 0) {
    return undefined;
  }
  return `- turnIndex ${String(item.turnIndex)} assistant: ${compactText(content, 360)}`;
}

function checkpointToolResultSummary(item: ContextToolResultItem): string {
  const message = item.retainedMessage;
  const presentation = parseToolObservationPresentationSummary(message.content);
  const parts = [
    `turnIndex ${String(item.turnIndex)}`,
    item.toolName,
    presentation.ok === undefined ? undefined : presentation.ok ? 'ok' : 'failed'
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);
  const summary = compactText(presentation.summary ?? message.content.replace(/\s+/g, ' ').trim(), 360);
  return `- ${parts.join(' ')}: ${summary}`;
}

function parseToolObservationPresentationSummary(content: string): { ok?: boolean; summary?: string } {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      ...(typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : {}),
      ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {})
    };
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactJsonObject(value: JsonObject, maxBytes: number): JsonObject {
  const jsonBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (jsonBytes <= maxBytes) {
    return value;
  }
  return {
    coverage: 'partial',
    originalBytes: jsonBytes
  };
}

function compactText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function limitUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= Math.max(1, Math.floor(end * 0.05));
  return value.slice(0, end);
}

interface WindowMessageEntry {
  readonly itemId: string;
  readonly message: ModelMessage;
  readonly imageArtifacts: readonly PublicArtifactRef[];
}

interface SelectedWindowImages {
  readonly messages: ModelMessage[];
  readonly reductions: ModelWindowReduction[];
}

function selectImagesForProfile(
  entries: readonly WindowMessageEntry[],
  profile: ModelProfile,
  limits: ModelWindowImageLimits,
  estimator: TokenEstimator
): SelectedWindowImages {
  const supportsImages = profile.modalities.input.includes('image');
  const images = entries.flatMap((entry, messageIndex) => (entry.message.images ?? []).map((image, imageIndex) => ({
    entry, messageIndex, imageIndex, image, bytes: imageByteLength(image), tokens: estimator.estimateImage(image)
  })));
  const kept = new Set<string>();
  const removalReasons = new Map<string, ModelWindowReduction['reason']>();
  let activeCount = 0;
  let activeBytes = 0;
  let activeTokens = 0;
  for (let index = images.length - 1; index >= 0; index -= 1) {
    const modelOutput = images[index];
    if (!modelOutput) continue;
    const key = `${String(modelOutput.messageIndex)}:${String(modelOutput.imageIndex)}`;
    if (!supportsImages) {
      removalReasons.set(key, 'unsupported_modality');
      continue;
    }
    const reason = activeCount + 1 > limits.maxCount
      ? 'image_count_limit'
      : activeBytes + modelOutput.bytes > limits.maxBytes
        ? 'image_byte_limit'
        : activeTokens + modelOutput.tokens > limits.maxEstimatedTokens
          ? 'image_token_limit'
          : undefined;
    if (reason) {
      removalReasons.set(key, reason);
      continue;
    }
    kept.add(key);
    activeCount += 1;
    activeBytes += modelOutput.bytes;
    activeTokens += modelOutput.tokens;
  }

  const reductions: ModelWindowReduction[] = [];
  const messages = entries.map((entry, messageIndex) => {
    if (entry.message.role !== 'user' && entry.message.role !== 'tool') return entry.message;
    const { images: sourceImages = [], ...messageWithoutImages } = entry.message;
    if (sourceImages.length === 0) return entry.message;
    const retained: ModelImage[] = [];
    const removed: { readonly image: ModelImage; readonly artifact?: PublicArtifactRef; readonly bytes: number; readonly tokens: number; readonly reason: NonNullable<ModelWindowReduction['reason']> }[] = [];
    for (let imageIndex = 0; imageIndex < sourceImages.length; imageIndex += 1) {
      const image = sourceImages[imageIndex];
      if (!image) continue;
      const key = `${String(messageIndex)}:${String(imageIndex)}`;
      if (kept.has(key)) retained.push(image);
      else removed.push({
        image,
        ...(entry.imageArtifacts[imageIndex] ? { artifact: entry.imageArtifacts[imageIndex] } : {}),
        bytes: imageByteLength(image),
        tokens: estimator.estimateImage(image),
        reason: removalReasons.get(key) ?? 'unsupported_modality'
      });
    }
    if (removed.length === 0) return entry.message;
    const firstRemoved = removed[0];
    if (!firstRemoved) return entry.message;
    const metadata = removed.map((item) => item.artifact
      ? `- ${item.image.mediaType}, ${String(item.bytes)} bytes, public artifact ${item.artifact.artifactId} (${item.artifact.sha256}, ${String(item.artifact.size)} bytes).`
      : `- ${item.image.mediaType}, ${String(item.bytes)} bytes; its public artifact metadata remains in the tool-result presentation.`).join('\n');
    const deliveredMessage: ModelMessage = Object.freeze({
      ...messageWithoutImages,
      content: `${entry.message.content}\n[${String(removed.length)} image attachment${removed.length === 1 ? '' : 's'} omitted from active model context]\n${metadata}`,
      ...(retained.length > 0 ? { images: Object.freeze(retained) } : {})
    });
    reductions.push(createModelWindowReduction({
      itemId: entry.itemId,
      kind: 'image_content_removed',
      beforeBytes: Buffer.byteLength(entry.message.content, 'utf8') + sourceImages.reduce((total, image) => total + imageByteLength(image), 0),
      afterBytes: Buffer.byteLength(deliveredMessage.content, 'utf8') + retained.reduce((total, image) => total + imageByteLength(image), 0),
      ...(entry.message.role === 'tool' ? { toolName: entry.message.toolName } : {}),
      removedItems: removed.length,
      removedImageBytes: removed.reduce((total, item) => total + item.bytes, 0),
      removedImageTokens: removed.reduce((total, item) => total + item.tokens, 0),
      reason: firstRemoved.reason
    }));
    return deliveredMessage;
  });
  return { messages, reductions };
}

function imageByteLength(image: ModelImage): number {
  if (image.type === 'bytes') return image.data.byteLength;
  const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(image.data.length * 3 / 4) - padding);
}

function normalizeToolProtocolMessages(messages: ModelMessage[]): ModelMessage[] {
  const normalized: ModelMessage[] = [];
  const openCalls: ModelToolCall[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      normalized.push(message);
      openCalls.push(...message.toolCalls);
      continue;
    }
    if (message.role === 'tool') {
      const callId = message.toolCallId;
      if (callId && !openCalls.some((call) => call.id === callId)) {
        continue;
      }
      if (!callId && openCalls.length === 0) {
        continue;
      }
      normalized.push(message);
      if (callId) {
        const index = openCalls.findIndex((call) => call.id === callId);
        if (index >= 0) {
          openCalls.splice(index, 1);
        }
      } else {
        openCalls.shift();
      }
      continue;
    }
    normalized.push(message);
  }

  if (openCalls.length === 0) {
    return normalized;
  }

  return normalized.map((message) => {
    if (message.role !== 'assistant' || !message.toolCalls || message.toolCalls.length === 0) {
      return message;
    }
    const retainedCalls = message.toolCalls.filter((call) => !openCalls.some((open) => sameToolCall(open, call)));
    if (retainedCalls.length === message.toolCalls.length) {
      return message;
    }
    return Object.freeze({
      ...message,
      toolCalls: Object.freeze(retainedCalls),
      content: retainedCalls.length > 0
        ? message.content
        : `${message.content}\n[tool calls removed from active history because their paired outputs were not retained]`.trim()
    });
  });
}

function sameToolCall(left: ModelToolCall, right: ModelToolCall): boolean {
  if (left.id || right.id) {
    return left.id === right.id;
  }
  return left.name === right.name && left.type === right.type;
}

function createModelWindowReduction(value: ModelWindowReduction): ModelWindowReduction {
  return Object.freeze(value);
}

function toolResultMessage(input: RecordToolResultInput, _detail: 'immediate' | 'retained'): ModelMessage {
  return Object.freeze({
    role: 'tool',
    toolName: input.toolName,
    toolCallType: input.toolCallType,
    content: _detail === 'immediate' ? input.immediateContent : input.retainedContent,
    ...(input.callId ? { toolCallId: input.callId } : {}),
    ...(_detail === 'immediate' && input.immediateImages && input.immediateImages.length > 0 ? { images: Object.freeze(input.immediateImages.map(snapshotModelImage)) } : {})
  });
}

function snapshotModelToolCall(call: ModelToolCall): ModelToolCall {
  if (call.type === 'function') return Object.freeze({ ...call, input: Object.freeze({ kind: 'json', value: parseJsonObject(call.input.value) }) });
  return Object.freeze({ ...call, input: Object.freeze({ kind: 'text', value: call.input.value }) });
}

function snapshotModelImage(image: ModelImage): ModelImage {
  return image.type === 'bytes' ? Object.freeze({ ...image, data: new Uint8Array(image.data) }) : Object.freeze({ ...image });
}

function checkpointMessages(items: ContextHistoryItem[]): string[] {
  return items
    .filter((item): item is ContextCheckpointItem => item.kind === 'checkpoint')
    .map((item) => item.message.content);
}

function messageBytes(message: ModelMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

function itemBytes(item: ContextHistoryItem): number {
  if (item.kind === 'assistant_tool_call') {
    return messageBytes(item.message);
  }
  if (item.kind === 'checkpoint') {
    return messageBytes(item.message);
  }
  return messageBytes(item.useRetained ? item.retainedMessage : item.immediateMessage);
}
