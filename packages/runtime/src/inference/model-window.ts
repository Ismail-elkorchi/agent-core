import { canonicalJsonString, parseJsonObject } from '@agent-core/json';
import {
  CompleteRequestEstimator,
  modelOutputToInput,
  parseModelInputItem,
  providerContextIncompatibility,
  type ModelImage,
  type ModelInputItem,
  type ModelOutputItem,
  type ModelProfile,
  type ModelToolCall,
  type ProviderContextState,
  type RequestEstimator
} from '@agent-core/model';
import { randomUUID } from 'node:crypto';

export interface ModelWindowMessages {
  readonly messages: readonly ModelInputItem[];
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
  immediateImages?: readonly ModelImage[];
}

export class ModelWindow {
  private readonly estimator: RequestEstimator;
  private readonly activeItems: ActiveWindowItem[] = [];
  private readonly priorItems = new Map<string, ModelInputItem>();
  readonly imageLimits: ModelWindowImageLimits;

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
    const owned = parseModelInputItem(message);
    const existing = this.activeItems.find((item) => item.id === sourceId);
    if (existing) {
      if (
        existing.kind !== 'message' ||
        canonicalJsonString(existing.message) !== canonicalJsonString(owned)
      )
        throw new Error('Active source identity changed.');
      return;
    }
    this.activeItems.push({
      kind: 'message',
      id: sourceId,
      turnIndex,
      message: owned
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
      immediateMessage: toolResultMessage(input)
    };
    if (input.callId) {
      item.callId = input.callId;
    }
    this.activeItems.push(item);
  }

  /** Removes incompatible native material from attention; immutable history remains unchanged. */
  invalidateProviderState(
    target: Parameters<typeof providerContextIncompatibility>[1]
  ): readonly { readonly state: ProviderContextState; readonly reason: string }[] {
    const invalidated: { state: ProviderContextState; reason: string }[] = [];
    const invalid = (message: ModelInputItem): boolean => {
      if (message.role !== 'protocol') return false;
      const reason = providerContextIncompatibility(message.state, target);
      if (!reason) return false;
      invalidated.push({ state: message.state, reason });
      return true;
    };
    for (const [id, message] of this.priorItems) if (invalid(message)) this.priorItems.delete(id);
    for (let index = this.activeItems.length - 1; index >= 0; index--) {
      const item = this.activeItems[index];
      if (item?.kind === 'message' && invalid(item.message)) this.activeItems.splice(index, 1);
    }
    return Object.freeze(invalidated);
  }

  toolResult(callId: string): Extract<ModelInputItem, { readonly role: 'tool' }> | undefined {
    const item = this.activeItems.find(
      (item) => item.kind === 'tool_result' && item.callId === callId
    );
    if (item?.kind !== 'tool_result') return undefined;
    const message = item.immediateMessage;
    return message.role === 'tool' ? message : undefined;
  }

  /** Original selected source content, keyed by its immutable history reference. */
  recordSourceItem(sourceId: string, message: ModelInputItem): void {
    const owned = parseModelInputItem(message);
    const prior = this.priorItems.get(sourceId);
    if (prior && canonicalJsonString(prior) !== canonicalJsonString(owned))
      throw new Error(`History source ${sourceId} changed its immutable content.`);
    this.priorItems.set(sourceId, owned);
  }

  replaceWith(window: ModelWindow): void {
    this.activeItems.splice(0, this.activeItems.length, ...window.activeItems);
    this.priorItems.clear();
    for (const [source, item] of window.priorItems) this.priorItems.set(source, item);
  }

  assertImagesAdmitted(messages: readonly ModelInputItem[], profile: ModelProfile): void {
    assertImagesAdmitted(messages, profile, this.imageLimits, this.estimator);
  }

  priorMessagesFor(modelProfile: ModelProfile): ModelWindowMessages {
    const entries = [...this.priorItems].map(([itemId, message]) => ({
      itemId,
      message
    }));
    const selected = admitImagesForProfile(entries, modelProfile, this.imageLimits, this.estimator);
    return Object.freeze({
      messages: Object.freeze(normalizeToolProtocolMessages(selected.messages))
    });
  }

  messagesFor(modelProfile: ModelProfile): ModelWindowMessages {
    const selectedImages = admitImagesForProfile(
      this.contextHistoryEntries(),
      modelProfile,
      this.imageLimits,
      this.estimator
    );
    const messages = normalizeToolProtocolMessages(selectedImages.messages);
    return Object.freeze({
      messages: Object.freeze(messages)
    });
  }

  itemCount(): number {
    return this.activeItems.length + this.priorItems.size;
  }

  private contextHistoryEntries(): WindowMessageEntry[] {
    return this.activeItems.map((item) => {
      if (item.kind === 'message') {
        return { itemId: item.id, message: item.message };
      }
      return {
        itemId: item.id,
        message: item.immediateMessage
      };
    });
  }
}

interface WindowMessageEntry {
  readonly itemId: string;
  readonly message: ModelInputItem;
}

interface SelectedWindowImages {
  readonly messages: ModelInputItem[];
}

function admitImagesForProfile(
  entries: readonly WindowMessageEntry[],
  profile: ModelProfile,
  limits: ModelWindowImageLimits,
  estimator: RequestEstimator
): SelectedWindowImages {
  const messages = entries.map((entry) => entry.message);
  assertImagesAdmitted(messages, profile, limits, estimator);
  return { messages };
}

function assertImagesAdmitted(
  messages: readonly ModelInputItem[],
  profile: ModelProfile,
  limits: ModelWindowImageLimits,
  estimator: RequestEstimator
): void {
  const images = messages.flatMap((message) => [
    ...(message.images ?? []),
    ...(message.parts?.flatMap((part) => (part.type === 'image' ? [part.image] : [])) ?? [])
  ]);
  if (images.length > 0 && !profile.modalities.input.includes('image'))
    throw new Error('context_admission_failed: selected images require an image-capable model.');
  const bytes = images.reduce((total, image) => total + imageByteLength(image), 0);
  const tokens = images.reduce((total, image) => total + estimator.estimateImage(image), 0);
  if (
    images.length > limits.maxCount ||
    bytes > limits.maxBytes ||
    tokens > limits.maxEstimatedTokens
  )
    throw new Error(
      'context_admission_failed: selected images exceed the admitted count, byte or token limit.'
    );
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

function toolResultMessage(input: RecordToolResultInput): ModelInputItem {
  return Object.freeze({
    role: 'tool',
    toolName: input.toolName,
    toolCallType: input.toolCallType,
    content: input.immediateContent,
    ...(input.callId ? { toolCallId: input.callId } : {}),
    ...(input.immediateImages && input.immediateImages.length > 0
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
