import { randomUUID } from 'node:crypto';
import {
  type ModelMessage,
  type ModelImage,
  type ModelProfile,
  type ModelTool,
  type ModelToolCall,
  SimpleTokenEstimator,
  type TokenEstimator
} from '@agent-core/model';
import type { EvidenceRecord, JsonObject } from '@agent-core/evidence';

export interface ContextRange {
  kind: 'line' | 'byte';
  start?: number;
  end?: number;
}

export type ContextSourceKind = 'user' | 'external' | 'session' | 'tool-observation' | 'generated';
export type ContextConfidence = 'unverified' | 'verified';
export type ContextRepresentation = 'full' | 'excerpt' | 'summary';

export interface ContextItem {
  id: string;
  sourceUri: string;
  sourceKind: ContextSourceKind;
  confidence?: ContextConfidence;
  representation: ContextRepresentation;
  mediaType: string;
  title: string;
  content: string;
  range?: ContextRange;
  tokenEstimate: number;
  selectionReason: string;
  score: number;
}

export type ContextItemInput = Omit<ContextItem, 'id' | 'tokenEstimate'> & {
  id?: string;
  tokenEstimate?: number;
};

export interface ContextOmission {
  reason: string;
  sourceUri?: string;
}

export interface ContextBundle {
  items: ContextItem[];
  totalTokens: number;
  omitted: ContextOmission[];
}

export interface PromptInstructionBlock {
  id: string;
  role: 'system' | 'developer' | 'workspace' | 'user';
  content: string;
  sourceUri?: string;
  priority: number;
}

export interface PromptToolSummary {
  name: string;
  description: string;
  inputFormat: string;
  accessModes: string[];
  promptGuide?: string;
}

export interface PromptOutputContract {
  kind: 'text';
  description: string;
}

export interface PromptEvidenceProjection {
  records: EvidenceRecord[];
  omittedRecords: number;
  omittedSummary?: PromptEvidenceOmissionSummary[];
  tokenEstimate: number;
  coverage: 'complete' | 'partial';
}

export interface PromptEvidenceOmissionSummary {
  toolName: string;
  action: EvidenceRecord['action'];
  outcome: EvidenceRecord['outcome'];
  count: number;
}

export interface PromptProjection {
  id: string;
  task: string;
  instructions: PromptInstructionBlock[];
  notes: string[];
  context: ContextItem[];
  tools: PromptToolSummary[];
  continuity: string[];
  evidence?: PromptEvidenceProjection;
  outputContract?: PromptOutputContract;
  metadata?: Record<string, string>;
}

export interface ContextProjection {
  prompt: PromptProjection;
  contextHistoryMessages: ModelMessage[];
  context: ContextBundle;
  reductions: ContextHistoryReduction[];
  estimate: ContextProjectionEstimate;
}

export interface ContextHistoryProjection {
  messages: ModelMessage[];
  estimatedTokens: number;
}

export interface ContextHistoryPressureReduction {
  reductions: ContextHistoryReduction[];
  projectedTokens: number;
}

export interface ContextProjectionEstimate {
  contextHistoryTokens: number;
  contextTokens: number;
  evidenceTokens: number;
}

export interface ContextProjectionRequest {
  task: string;
  instructions: PromptInstructionBlock[];
  notes?: string[];
  contextItems?: ContextItemInput[];
  tools: PromptToolSummary[];
  modelProfile: ModelProfile;
  modelTools: ModelTool[];
  requestWindow: {
    maxPromptTokens: number;
    maxOutputTokens: number;
    contextWindowTokens: number;
  };
  contextTokenBudget?: number;
  evidenceTokenBudget?: number;
  maxContextItems?: number;
  metadata?: Record<string, string>;
}

export interface ContextHistoryReduction {
  itemId: string;
  kind: 'tool_result_reduced' | 'checkpoint_installed';
  beforeBytes: number;
  afterBytes: number;
  toolName?: string;
  removedItems?: number;
}

export type ContextHistoryItem =
  | ContextAssistantToolCallItem
  | ContextToolResultItem
  | ContextCheckpointItem;

export interface ContextAssistantToolCallItem {
  kind: 'assistant_tool_call';
  id: string;
  turnIndex: number;
  message: ModelMessage;
}

export interface ContextToolResultItem {
  kind: 'tool_result';
  id: string;
  turnIndex: number;
  toolName: string;
  toolCallType: 'function' | 'custom';
  callId?: string;
  immediateMessage: ModelMessage;
  retainedMessage: ModelMessage;
  useRetained: boolean;
}

export interface ContextCheckpointItem {
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
  useRetained?: boolean;
  evidence?: EvidenceRecord[];
}

export interface RecordCheckpointInput {
  content: string;
  removedItems?: number;
}

export interface ContextManagerSnapshot {
  activeItems: number;
  compactedToolResults: number;
  checkpoints: number;
  evidenceRecords: number;
}

export class ContextManager {
  private readonly estimator: TokenEstimator;
  private readonly historyItems: ContextHistoryItem[] = [];
  private readonly evidenceRecords: EvidenceRecord[] = [];
  private readonly projectionReductions: ContextHistoryReduction[] = [];

  constructor(estimator: TokenEstimator = new SimpleTokenEstimator()) {
    this.estimator = estimator;
  }

  recordModelOutput(input: RecordModelOutputInput): void {
    if (input.toolCalls.length === 0) {
      return;
    }
    this.historyItems.push({
      kind: 'assistant_tool_call',
      id: `hist_${randomUUID()}`,
      turnIndex: input.turnIndex,
      message: {
        role: 'assistant',
        content: input.content,
        toolCalls: input.toolCalls.map((call) => ({ ...call }))
      }
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
      useRetained: input.useRetained ?? false
    };
    if (input.callId) {
      item.callId = input.callId;
    }
    this.historyItems.push(item);
    this.evidenceRecords.push(...compactEvidenceRecords(input.evidence ?? []));
  }

  recordEvidence(records: EvidenceRecord[]): void {
    this.evidenceRecords.push(...compactEvidenceRecords(records));
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

  projectHistory(modelProfile: ModelProfile): ContextHistoryProjection {
    void modelProfile;
    const messages = this.contextHistoryMessages();
    return {
      messages,
      estimatedTokens: this.estimator.estimateMessages(messages)
    };
  }

  reduceHistoryForPromptPressure(input: {
    modelProfile: ModelProfile;
    maxHistoryTokens: number;
    keepLatestToolResults?: number;
  }): ContextHistoryPressureReduction {
    let projection = this.projectHistory(input.modelProfile);
    if (projection.estimatedTokens <= input.maxHistoryTokens) {
      return { reductions: [], projectedTokens: projection.estimatedTokens };
    }

    const reductions = this.reduceOlderLargeToolResults({
      keepLatestToolResults: input.keepLatestToolResults ?? 2
    });
    projection = this.projectHistory(input.modelProfile);
    if (projection.estimatedTokens <= input.maxHistoryTokens) {
      return { reductions, projectedTokens: projection.estimatedTokens };
    }

    reductions.push(...this.reduceOlderLargeToolResults({
      keepLatestToolResults: 0,
      includeLatest: true
    }));
    projection = this.projectHistory(input.modelProfile);
    return { reductions, projectedTokens: projection.estimatedTokens };
  }

  project(request: ContextProjectionRequest): ContextProjection {
    const contextHistory = this.projectHistory(request.modelProfile);
    const contextBudget = Math.max(0, request.contextTokenBudget ?? request.requestWindow.maxPromptTokens);
    const selectInput: { items: ContextItemInput[]; maxTokens: number; maxItems?: number } = {
      items: request.contextItems ?? [],
      maxTokens: contextBudget
    };
    if (request.maxContextItems !== undefined) {
      selectInput.maxItems = request.maxContextItems;
    }
    const context = this.selectContext(selectInput);
    const evidence = this.projectEvidence(request.evidenceTokenBudget ?? Math.min(1_600, Math.floor(request.requestWindow.maxPromptTokens * 0.08)));
    const projection: PromptProjection = {
      id: `prompt_${randomUUID()}`,
      task: request.task,
      instructions: request.instructions,
      notes: request.notes ?? [],
      context: context.items,
      tools: request.tools,
      continuity: checkpointMessages(this.historyItems),
      ...(evidence.records.length > 0 || evidence.omittedSummary?.length ? { evidence } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {})
    };
    return {
      prompt: projection,
      contextHistoryMessages: contextHistory.messages,
      context,
      reductions: this.consumeProjectionReductions(),
      estimate: {
        contextHistoryTokens: contextHistory.estimatedTokens,
        contextTokens: context.totalTokens,
        evidenceTokens: evidence.tokenEstimate
      }
    };
  }

  projectEvidence(maxTokens: number): PromptEvidenceProjection {
    if (maxTokens <= 0 || this.evidenceRecords.length === 0) {
      return {
        records: [],
        omittedRecords: this.evidenceRecords.length,
        tokenEstimate: 0,
        coverage: this.evidenceRecords.length > 0 ? 'partial' : 'complete'
      };
    }

    const selected: { record: EvidenceRecord; tokens: number }[] = [];
    const omitted: EvidenceRecord[] = [];
    let tokenEstimate = 0;
    let omittedRecords = 0;
    for (let index = this.evidenceRecords.length - 1; index >= 0; index -= 1) {
      const record = this.evidenceRecords[index];
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
    return {
      records: selected.map((item) => item.record),
      omittedRecords,
      ...(omittedSummary.summary.length > 0 ? { omittedSummary: omittedSummary.summary } : {}),
      tokenEstimate,
      coverage: omittedRecords > 0 ? 'partial' : 'complete'
    };
  }

  evidenceRecordCount(): number {
    return this.evidenceRecords.length;
  }

  evidenceSnapshot(): readonly EvidenceRecord[] {
    return Object.freeze([...this.evidenceRecords]);
  }

  selectContext(input: { items: ContextItemInput[]; maxTokens: number; maxItems?: number; omitted?: ContextOmission[] }): ContextBundle {
    const candidates = input.items.map((item) => this.materializeContextItem(item));
    const omitted = [...(input.omitted ?? [])];
    return selectContextItems(candidates, input.maxTokens, input.maxItems ?? 24, omitted);
  }

  reduceOlderLargeToolResults(options: { keepLatestToolResults: number; includeLatest?: boolean }): ContextHistoryReduction[] {
    const toolItems = this.historyItems.filter((item): item is ContextToolResultItem => item.kind === 'tool_result');
    const keepLatest = Math.max(0, options.keepLatestToolResults);
    const latestKeepStart = Math.max(0, toolItems.length - keepLatest);
    const reductions: ContextHistoryReduction[] = [];

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
      reductions.push({
        itemId: item.id,
        kind: 'tool_result_reduced',
        beforeBytes,
        afterBytes,
        toolName: item.toolName
      });
    }
    this.projectionReductions.push(...reductions);
    return reductions;
  }

  installCheckpoint(): ContextHistoryReduction | undefined {
    if (this.historyItems.length === 0) {
      return undefined;
    }
    if (this.historyItems.length === 1 && this.historyItems[0]?.kind === 'checkpoint') {
      return undefined;
    }
    const beforeBytes = this.historyItems.reduce((total, item) => total + itemBytes(item), 0);
    const historySummary = checkpointHistorySummary(this.historyItems, 14);
    const evidenceSummary = summarizeOmittedEvidence(this.evidenceRecords).slice(0, 12);
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
        ...(evidenceSummary.length > 0
          ? [
            'Evidence summary:',
            ...evidenceSummary.map((item) => `- ${item.toolName} ${item.action} ${item.outcome}: ${String(item.count)}`)
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
    const reduction: ContextHistoryReduction = {
      itemId: item.id,
      kind: 'checkpoint_installed',
      beforeBytes,
      afterBytes: messageBytes(message),
      removedItems
    };
    this.projectionReductions.push(reduction);
    return reduction;
  }

  compactedToolResultCount(): number {
    return this.historyItems.filter((item) => item.kind === 'tool_result' && item.useRetained).length;
  }

  itemCount(): number {
    return this.historyItems.length;
  }

  rawItems(): readonly ContextHistoryItem[] {
    return this.historyItems;
  }

  snapshot(): ContextManagerSnapshot {
    return {
      activeItems: this.historyItems.length,
      compactedToolResults: this.compactedToolResultCount(),
      checkpoints: this.historyItems.filter((item) => item.kind === 'checkpoint').length,
      evidenceRecords: this.evidenceRecords.length
    };
  }

  private contextHistoryMessages(): ModelMessage[] {
    return normalizeToolProtocolMessages(this.historyItems.map((item) => {
      if (item.kind === 'assistant_tool_call') {
        return item.message;
      }
      if (item.kind === 'checkpoint') {
        return undefined;
      }
      return item.useRetained ? item.retainedMessage : item.immediateMessage;
    }).filter((message): message is ModelMessage => message !== undefined));
  }

  private materializeContextItem(input: ContextItemInput): ContextItem {
    const { id, tokenEstimate, ...rest } = input;
    return {
      ...rest,
      id: id ?? contextId(input.sourceUri, input.title, input.content),
      tokenEstimate: tokenEstimate ?? this.estimator.estimateText(input.content)
    };
  }

  private consumeProjectionReductions(): ContextHistoryReduction[] {
    return this.projectionReductions.splice(0);
  }
}

function compactEvidenceRecords(records: EvidenceRecord[]): EvidenceRecord[] {
  return records.map((record) => {
    const next: EvidenceRecord = {
      ...record,
      resources: record.resources.slice(0, 8).map((resource) => ({
        ...resource,
        uri: compactText(resource.uri, 300)
      }))
    };
    if (record.summary) {
      next.summary = compactText(record.summary, 300);
    }
    if (record.scope) {
      next.scope = compactEvidenceScope(record.scope);
    }
    return next;
  });
}

function compactEvidenceScope(scope: NonNullable<EvidenceRecord['scope']>): NonNullable<EvidenceRecord['scope']> {
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
  records: EvidenceRecord[],
  maxTokens: number,
  estimator: TokenEstimator
): { summary: PromptEvidenceOmissionSummary[]; tokens: number } {
  if (records.length === 0 || maxTokens <= 0) {
    return { summary: [], tokens: 0 };
  }
  const selected: PromptEvidenceOmissionSummary[] = [];
  let tokens = 0;
  for (const item of summarizeOmittedEvidence(records)) {
    const candidate = [...selected, item];
    const estimate = estimator.estimateText(JSON.stringify({ omittedSummary: candidate }));
    if (estimate > maxTokens) {
      continue;
    }
    selected.push(item);
    tokens = estimate;
  }
  return { summary: selected, tokens };
}

function summarizeOmittedEvidence(records: EvidenceRecord[]): PromptEvidenceOmissionSummary[] {
  const groups = new Map<string, PromptEvidenceOmissionSummary>();
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
  return [...groups.values()].sort((left, right) => {
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
  });
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

function selectContextItems(
  candidates: ContextItem[],
  maxTokens: number,
  maxItems: number,
  omitted: ContextOmission[]
): ContextBundle {
  const deduped = new Map<string, ContextItem>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.id);
    if (!existing || candidate.score > existing.score) {
      deduped.set(candidate.id, candidate);
    }
  }

  const sorted = [...deduped.values()].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.sourceUri.localeCompare(right.sourceUri);
  });

  const selected: ContextItem[] = [];
  let totalTokens = 0;
  for (const item of sorted) {
    if (selected.length >= maxItems) {
      omitted.push({ reason: 'max item count reached', sourceUri: item.sourceUri });
      continue;
    }
    if (totalTokens + item.tokenEstimate > maxTokens) {
      omitted.push({ reason: 'token budget exceeded', sourceUri: item.sourceUri });
      continue;
    }
    selected.push(item);
    totalTokens += item.tokenEstimate;
  }

  return { items: selected, totalTokens, omitted };
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
    return {
      ...message,
      toolCalls: retainedCalls,
      content: retainedCalls.length > 0
        ? message.content
        : `${message.content}\n[tool calls removed from active history because their paired outputs were not retained]`.trim()
    };
  });
}

function sameToolCall(left: ModelToolCall, right: ModelToolCall): boolean {
  if (left.id || right.id) {
    return left.id === right.id;
  }
  return left.name === right.name && left.type === right.type;
}

function toolResultMessage(input: RecordToolResultInput, _detail: 'immediate' | 'retained'): ModelMessage {
  const message: ModelMessage = {
    role: 'tool',
    toolName: input.toolName,
    toolCallType: input.toolCallType,
    content: _detail === 'immediate' ? input.immediateContent : input.retainedContent,
    ...(_detail === 'immediate' && input.immediateImages && input.immediateImages.length > 0 ? { images: [...input.immediateImages] } : {})
  };
  if (input.callId) {
    message.toolCallId = input.callId;
  }
  return message;
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

function contextId(...parts: string[]): string {
  let hash = 2166136261;
  const text = parts.join('\0');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ctx_${(hash >>> 0).toString(16)}`;
}
