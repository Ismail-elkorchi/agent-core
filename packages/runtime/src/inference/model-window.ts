import { accountModelRequest } from '@agent-core/model';
import { randomUUID } from 'node:crypto';
import {
  type ModelInputItem,
  type ModelOutputItem,
  modelOutputToInput,
  parseModelInputItem,
  type ModelImage,
  type ModelProfile,
  type ModelToolCall,
  CompleteRequestEstimator,
  type RequestEstimator
} from '@agent-core/model';
import type { PublicArtifactRef } from '@agent-core/persistence';
import { ownObservedFactRecord, type ObservedFactRecord } from '@agent-core/tools';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { PromptObservedFactsMaterial, PromptObservedFactsOmissionSummary } from './prompt-material.js';

export interface ModelWindowMessages {
  readonly messages: readonly ModelInputItem[];
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
  readonly kind: 'tool_result_reduced' | 'image_content_removed';
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly toolName?: string;
  readonly removedItems?: number;
  readonly removedImageBytes?: number;
  readonly removedImageTokens?: number;
  readonly reason?: 'unsupported_modality' | 'image_count_limit' | 'image_byte_limit' | 'image_token_limit';
}

type ActiveWindowItem = ActiveMessageItem | ActiveToolResultItem;

interface ActiveMessageItem {
  kind: 'message';
  id: string;
  turnIndex: number;
  message: ModelInputItem;
}

interface ActiveToolResultItem {
  kind: 'tool_result';
  id: string;
  turnIndex: number;
  toolName: string;
  toolCallType: 'function' | 'custom';
  callId?: string;
  immediateMessage: ModelInputItem;
  retainedMessage: ModelInputItem;
  imageArtifacts: readonly PublicArtifactRef[];
  useRetained: boolean;
}

export interface RecordModelOutputInput {
  readonly output?: readonly ModelOutputItem[];
  turnIndex: number;
  content: string;
  toolCalls: readonly ModelToolCall[];
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

export interface ModelWindowSnapshot {
  readonly activeItems: number;
  readonly compactedToolResults: number;
  readonly observedFactRecords: number;
}

export class ModelWindow {
  private readonly estimator: RequestEstimator;
  private readonly activeItems: ActiveWindowItem[] = [];
  private readonly priorItems = new Map<string, ModelInputItem>();
  private readonly observedFactRecords: ObservedFactRecord[] = [];
  private readonly pendingReductions: ModelWindowReduction[] = [];
  private readonly imageLimits: ModelWindowImageLimits;

  constructor(
    estimator: RequestEstimator = new CompleteRequestEstimator(),
    imageLimits: ModelWindowImageLimits = DEFAULT_MODEL_WINDOW_IMAGE_LIMITS
  ) {
    this.estimator = estimator;
    if (
      ![imageLimits.maxCount, imageLimits.maxBytes, imageLimits.maxEstimatedTokens].every(
        (value) => Number.isSafeInteger(value) && value > 0
      )
    )
      throw new Error('Context image limits must be positive safe integers.');
    this.imageLimits = Object.freeze({ ...imageLimits });
  }

  recordInput(sourceId: string, message: ModelInputItem, turnIndex = 0): void {
    const existing = this.activeItems.find((item) => item.id === sourceId);
    if (existing) {
      if (existing.kind !== 'message' || JSON.stringify(existing.message) !== JSON.stringify(message))
        throw new Error('Active source identity changed.');
      return;
    }
    this.activeItems.push({
      kind: 'message',
      id: sourceId,
      turnIndex,
      message: parseModelInputItem(message)
    });
  }

  recordModelOutput(input: RecordModelOutputInput): void {
    if (input.output?.length) {
      for (const item of modelOutputToInput(input.output))
        this.recordInput(`output_${randomUUID()}`, item, input.turnIndex);
      return;
    }

    this.activeItems.push({
      kind: 'message',
      id: `hist_${randomUUID()}`,
      turnIndex: input.turnIndex,
      message: Object.freeze({
        role: 'assistant',
        content: input.content,
        toolCalls: Object.freeze(input.toolCalls.map(snapshotModelToolCall))
      })
    });
  }

  recordToolResult(input: RecordToolResultInput): void {
    const item: ActiveToolResultItem = {
      kind: 'tool_result',
      id: `hist_${randomUUID()}`,
      turnIndex: input.turnIndex,
      toolName: input.toolName,
      toolCallType: input.toolCallType,
      immediateMessage: toolResultMessage(input, 'immediate'),
      retainedMessage: toolResultMessage(input, 'retained'),
      imageArtifacts: Object.freeze(
        (input.imageArtifacts ?? []).map((artifact) => Object.freeze({ ...artifact }))
      ),
      useRetained: input.useRetained ?? false
    };
    if (input.callId) {
      item.callId = input.callId;
    }
    this.activeItems.push(item);
    this.observedFactRecords.push(...compactObservedFactRecords(input.observedFacts ?? []));
  }

  toolResult(callId: string): Extract<ModelInputItem, { readonly role: 'tool' }> | undefined {
    const item = this.activeItems.find((item) => item.kind === 'tool_result' && item.callId === callId);
    if (item?.kind !== 'tool_result') return undefined;
    const message = item.useRetained ? item.retainedMessage : item.immediateMessage;
    return message.role === 'tool' ? message : undefined;
  }

  recordObservedFacts(records: readonly ObservedFactRecord[]): void {
    this.observedFactRecords.push(...compactObservedFactRecords(records));
  }

  /** Original selected source content, keyed by its immutable history reference. */
  recordSourceItem(sourceId: string, message: ModelInputItem): void {
    const prior = this.priorItems.get(sourceId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(message))
      throw new Error(`History source ${sourceId} changed its immutable content.`);
    this.priorItems.set(sourceId, parseModelInputItem(message));
  }

  activateSources(window: ModelWindow): void {
    this.priorItems.clear();
    for (const [source, item] of window.priorItems) this.priorItems.set(source, item);
  }

  priorMessagesFor(modelProfile: ModelProfile): ModelWindowMessages {
    const entries = [...this.priorItems].map(([itemId, message]) => ({
      itemId,
      message,
      imageArtifacts: []
    }));
    const selected = selectImagesForProfile(entries, modelProfile, this.imageLimits, this.estimator);
    return Object.freeze({
      messages: Object.freeze(normalizeToolProtocolMessages(selected.messages)),
      estimatedTokens: accountModelRequest(
        { model: modelProfile.id, messages: selected.messages },
        modelProfile,
        { estimator: this.estimator }
      ).estimatedInputTokens,
      reductions: Object.freeze(selected.reductions)
    });
  }

  messagesFor(modelProfile: ModelProfile): ModelWindowMessages {
    const selectedImages = selectImagesForProfile(
      this.contextHistoryEntries(),
      modelProfile,
      this.imageLimits,
      this.estimator
    );
    const messages = normalizeToolProtocolMessages(selectedImages.messages);
    return Object.freeze({
      messages: Object.freeze(messages),
      estimatedTokens: accountModelRequest({ model: modelProfile.id, messages }, modelProfile, {
        estimator: this.estimator
      }).estimatedInputTokens,
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
      return Object.freeze({
        reductions: Object.freeze([]),
        retainedTokens: assembly.estimatedTokens
      });
    }

    const reductions = [
      ...this.reduceOlderLargeToolResults({
        keepLatestToolResults: input.keepLatestToolResults ?? 2
      })
    ];
    assembly = this.messagesFor(input.modelProfile);
    if (assembly.estimatedTokens <= input.maxHistoryTokens) {
      return Object.freeze({
        reductions: Object.freeze(reductions),
        retainedTokens: assembly.estimatedTokens
      });
    }

    reductions.push(
      ...this.reduceOlderLargeToolResults({
        keepLatestToolResults: 0,
        includeLatest: true
      })
    );
    assembly = this.messagesFor(input.modelProfile);
    return Object.freeze({
      reductions: Object.freeze(reductions),
      retainedTokens: assembly.estimatedTokens
    });
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

  reduceOlderLargeToolResults(options: {
    keepLatestToolResults: number;
    includeLatest?: boolean;
  }): readonly ModelWindowReduction[] {
    const toolItems = this.activeItems.filter(
      (item): item is ActiveToolResultItem => item.kind === 'tool_result'
    );
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
      reductions.push(
        createModelWindowReduction({
          itemId: item.id,
          kind: 'tool_result_reduced',
          beforeBytes,
          afterBytes,
          toolName: item.toolName
        })
      );
    }
    this.pendingReductions.push(...reductions);
    return Object.freeze(reductions);
  }

  compactedToolResultCount(): number {
    return this.activeItems.filter((item) => item.kind === 'tool_result' && item.useRetained).length;
  }

  itemCount(): number {
    return this.activeItems.length + this.priorItems.size;
  }

  consumeReductions(): readonly ModelWindowReduction[] {
    return Object.freeze(this.pendingReductions.splice(0));
  }

  snapshot(): ModelWindowSnapshot {
    return Object.freeze({
      activeItems: this.activeItems.length + this.priorItems.size,
      compactedToolResults: this.compactedToolResultCount(),
      observedFactRecords: this.observedFactRecords.length
    });
  }

  private contextHistoryEntries(): WindowMessageEntry[] {
    return this.activeItems.map((item) => {
      if (item.kind === 'message') {
        return { itemId: item.id, message: item.message, imageArtifacts: [] };
      }
      return {
        itemId: item.id,
        message: item.useRetained ? item.retainedMessage : item.immediateMessage,
        imageArtifacts: item.imageArtifacts
      };
    });
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

function compactObservationScope(
  scope: NonNullable<ObservedFactRecord['scope']>
): NonNullable<ObservedFactRecord['scope']> {
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
  estimator: RequestEstimator
): {
  readonly summary: readonly PromptObservedFactsOmissionSummary[];
  readonly tokens: number;
} {
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

function summarizeOmittedFacts(
  records: readonly ObservedFactRecord[]
): readonly PromptObservedFactsOmissionSummary[] {
  const groups = new Map<
    string,
    {
      toolName: string;
      action: ObservedFactRecord['action'];
      outcome: ObservedFactRecord['outcome'];
      count: number;
    }
  >();
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
  return Object.freeze(
    [...groups.values()]
      .sort((left, right) => {
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
      })
      .map((item) => Object.freeze({ ...item }))
  );
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

interface WindowMessageEntry {
  readonly itemId: string;
  readonly message: ModelInputItem;
  readonly imageArtifacts: readonly PublicArtifactRef[];
}

interface SelectedWindowImages {
  readonly messages: ModelInputItem[];
  readonly reductions: ModelWindowReduction[];
}

function selectImagesForProfile(
  entries: readonly WindowMessageEntry[],
  profile: ModelProfile,
  limits: ModelWindowImageLimits,
  estimator: RequestEstimator
): SelectedWindowImages {
  const supportsImages = profile.modalities.input.includes('image');
  const images = entries.flatMap((entry, messageIndex) =>
    (entry.message.images ?? []).map((image, imageIndex) => ({
      entry,
      messageIndex,
      imageIndex,
      image,
      bytes: imageByteLength(image),
      tokens: estimator.estimateImage(image)
    }))
  );
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
    const reason =
      activeCount + 1 > limits.maxCount
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
    const removed: {
      readonly image: ModelImage;
      readonly artifact?: PublicArtifactRef;
      readonly bytes: number;
      readonly tokens: number;
      readonly reason: NonNullable<ModelWindowReduction['reason']>;
    }[] = [];
    for (let imageIndex = 0; imageIndex < sourceImages.length; imageIndex += 1) {
      const image = sourceImages[imageIndex];
      if (!image) continue;
      const key = `${String(messageIndex)}:${String(imageIndex)}`;
      if (kept.has(key)) retained.push(image);
      else
        removed.push({
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
    const metadata = removed
      .map((item) =>
        item.artifact
          ? `- ${item.image.mediaType}, ${String(item.bytes)} bytes, public artifact ${item.artifact.artifactId} (${item.artifact.sha256}, ${String(item.artifact.size)} bytes).`
          : `- ${item.image.mediaType}, ${String(item.bytes)} bytes; its public artifact metadata remains in the tool-result presentation.`
      )
      .join('\n');
    const deliveredMessage: ModelInputItem = Object.freeze({
      ...messageWithoutImages,
      content: `${entry.message.content}\n[${String(removed.length)} image attachment${removed.length === 1 ? '' : 's'} omitted from active model context]\n${metadata}`,
      ...(retained.length > 0 ? { images: Object.freeze(retained) } : {})
    });
    reductions.push(
      createModelWindowReduction({
        itemId: entry.itemId,
        kind: 'image_content_removed',
        beforeBytes:
          Buffer.byteLength(entry.message.content, 'utf8') +
          sourceImages.reduce((total, image) => total + imageByteLength(image), 0),
        afterBytes:
          Buffer.byteLength(deliveredMessage.content, 'utf8') +
          retained.reduce((total, image) => total + imageByteLength(image), 0),
        ...(entry.message.role === 'tool' ? { toolName: entry.message.toolName } : {}),
        removedItems: removed.length,
        removedImageBytes: removed.reduce((total, item) => total + item.bytes, 0),
        removedImageTokens: removed.reduce((total, item) => total + item.tokens, 0),
        reason: firstRemoved.reason
      })
    );
    return deliveredMessage;
  });
  return { messages, reductions };
}

function imageByteLength(image: ModelImage): number {
  if (image.type === 'bytes') return image.data.byteLength;
  const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((image.data.length * 3) / 4) - padding);
}

function normalizeToolProtocolMessages(messages: ModelInputItem[]): ModelInputItem[] {
  const normalized: ModelInputItem[] = [];
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
    const retainedCalls = message.toolCalls.filter(
      (call) => !openCalls.some((open) => sameToolCall(open, call))
    );
    if (retainedCalls.length === message.toolCalls.length) {
      return message;
    }
    return Object.freeze({
      ...message,
      toolCalls: Object.freeze(retainedCalls),
      content:
        retainedCalls.length > 0
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

function toolResultMessage(input: RecordToolResultInput, _detail: 'immediate' | 'retained'): ModelInputItem {
  return Object.freeze({
    role: 'tool',
    toolName: input.toolName,
    toolCallType: input.toolCallType,
    content: _detail === 'immediate' ? input.immediateContent : input.retainedContent,
    ...(input.callId ? { toolCallId: input.callId } : {}),
    ...(_detail === 'immediate' && input.immediateImages && input.immediateImages.length > 0
      ? { images: Object.freeze(input.immediateImages.map(snapshotModelImage)) }
      : {})
  });
}

function snapshotModelToolCall(call: ModelToolCall): ModelToolCall {
  if (call.type === 'function')
    return Object.freeze({
      ...call,
      input: Object.freeze({
        kind: 'json',
        value: parseJsonObject(call.input.value)
      })
    });
  return Object.freeze({
    ...call,
    input: Object.freeze({ kind: 'text', value: call.input.value })
  });
}

function snapshotModelImage(image: ModelImage): ModelImage {
  return image.type === 'bytes'
    ? Object.freeze({ ...image, data: new Uint8Array(image.data) })
    : Object.freeze({ ...image });
}

function messageBytes(message: ModelInputItem): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}
