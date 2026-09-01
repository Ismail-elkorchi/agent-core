import { randomUUID } from 'node:crypto';
import { SimpleTokenEstimator, type TokenEstimator } from '@agent-core/model';
import type { ObservedFactRecord } from '@agent-core/tools';

export interface PromptContextRange {
  readonly kind: 'line' | 'byte';
  readonly start?: number;
  readonly end?: number;
}

export type PromptContextSourceKind = 'user' | 'external' | 'session' | 'tool-observation' | 'generated';
export type PromptContextIntegrity = 'unverified' | 'verified';
export type PromptContextRepresentation = 'full' | 'excerpt' | 'summary';

export interface PromptContextItem {
  readonly id: string;
  readonly sourceUri: string;
  readonly sourceKind: PromptContextSourceKind;
  readonly integrity?: PromptContextIntegrity;
  readonly representation: PromptContextRepresentation;
  readonly mediaType: string;
  readonly title: string;
  readonly content: string;
  readonly range?: PromptContextRange;
  readonly tokenEstimate: number;
  readonly purpose: string;
}

export type PromptContextItemInput = Omit<PromptContextItem, 'id' | 'tokenEstimate'> & {
  readonly id?: string;
  readonly tokenEstimate?: number;
};

export interface PromptContextDelivery {
  readonly items: readonly PromptContextItem[];
  readonly totalTokens: number;
}

export interface PromptInstructionBlock {
  readonly id: string;
  readonly role: 'system' | 'developer' | 'environment' | 'user';
  readonly content: string;
  readonly sourceUri?: string;
  readonly priority: number;
}

export interface PromptToolSummary {
  readonly name: string;
  readonly description: string;
  readonly inputFormat: string;
  readonly accessModes: readonly string[];
  readonly promptGuide?: string;
}

export interface PromptOutputContract {
  readonly kind: 'text';
  readonly description: string;
}

export interface PromptObservedFactsMaterial {
  readonly records: readonly ObservedFactRecord[];
  readonly omittedRecords: number;
  readonly omittedSummary?: readonly PromptObservedFactsOmissionSummary[];
  readonly tokenEstimate: number;
  readonly coverage: 'complete' | 'partial';
}

export interface PromptObservedFactsOmissionSummary {
  readonly toolName: string;
  readonly action: ObservedFactRecord['action'];
  readonly outcome: ObservedFactRecord['outcome'];
  readonly count: number;
}

/** Typed material selected by the application and runtime before message framing. */
export interface PromptMaterial {
  readonly id: string;
  readonly task: string;
  readonly instructions: readonly PromptInstructionBlock[];
  readonly notes: readonly string[];
  readonly context: readonly PromptContextItem[];
  readonly tools: readonly PromptToolSummary[];
  readonly continuity: readonly string[];
  readonly observedFacts?: PromptObservedFactsMaterial;
  readonly outputContract?: PromptOutputContract;
  readonly metadata?: Readonly<Record<string, string>>;
}

export function decodePromptContextItemInput(value: unknown): PromptContextItemInput {
  if (!isRecord(value)) throw new TypeError('Prompt context item must be an object.');
  const allowed = new Set(['id', 'sourceUri', 'sourceKind', 'integrity', 'representation', 'mediaType', 'title', 'content', 'range', 'tokenEstimate', 'purpose']);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) throw new TypeError(`Unsupported prompt context fields: ${unsupported.join(', ')}.`);
  if (typeof value.sourceUri !== 'string' || value.sourceUri.length === 0
    || !oneOf(value.sourceKind, ['user', 'external', 'session', 'tool-observation', 'generated'] as const)
    || (value.integrity !== undefined && !oneOf(value.integrity, ['unverified', 'verified'] as const))
    || !oneOf(value.representation, ['full', 'excerpt', 'summary'] as const)
    || typeof value.mediaType !== 'string' || value.mediaType.length === 0
    || typeof value.title !== 'string' || typeof value.content !== 'string'
    || typeof value.purpose !== 'string' || value.purpose.trim().length === 0
    || (value.id !== undefined && (typeof value.id !== 'string' || value.id.length === 0))
    || (value.tokenEstimate !== undefined && !nonnegativeInteger(value.tokenEstimate))) {
    throw new TypeError('Prompt context item fields are invalid.');
  }
  const range = value.range === undefined ? undefined : decodePromptContextRange(value.range);
  return Object.freeze({
    sourceUri: value.sourceUri,
    sourceKind: value.sourceKind,
    ...(value.integrity === undefined ? {} : { integrity: value.integrity }),
    representation: value.representation,
    mediaType: value.mediaType,
    title: value.title,
    content: value.content,
    ...(range === undefined ? {} : { range }),
    purpose: value.purpose,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.tokenEstimate === undefined ? {} : { tokenEstimate: value.tokenEstimate })
  });
}

/** Preserve application order; Core does not rerank or silently select a second context set. */
export function deliverPromptContext(
  inputs: readonly PromptContextItemInput[],
  estimator: TokenEstimator = new SimpleTokenEstimator()
): PromptContextDelivery {
  const ids = new Set<string>();
  const items = inputs.map((input) => materializePromptContextItem(input, estimator));
  for (const item of items) {
    if (ids.has(item.id)) throw new TypeError(`Prompt context contains duplicate id ${item.id}.`);
    ids.add(item.id);
  }
  return Object.freeze({
    items: Object.freeze(items),
    totalTokens: items.reduce((total, item) => total + item.tokenEstimate, 0)
  });
}

export function createPromptMaterial(input: Omit<PromptMaterial, 'id'> & { readonly id?: string }): PromptMaterial {
  return Object.freeze({
    ...input,
    id: input.id ?? `material_${randomUUID()}`,
    instructions: Object.freeze(input.instructions.map((item) => Object.freeze({ ...item }))),
    notes: Object.freeze([...input.notes]),
    context: Object.freeze([...input.context]),
    tools: Object.freeze(input.tools.map((tool) => Object.freeze({ ...tool, accessModes: Object.freeze([...tool.accessModes]) }))),
    continuity: Object.freeze([...input.continuity]),
    ...(input.metadata ? { metadata: Object.freeze({ ...input.metadata }) } : {})
  });
}

function materializePromptContextItem(input: PromptContextItemInput, estimator: TokenEstimator): PromptContextItem {
  const { id, tokenEstimate, ...rest } = input;
  return Object.freeze({
    ...rest,
    id: id ?? contextId(input.sourceUri, input.title, input.content),
    tokenEstimate: tokenEstimate ?? estimator.estimateText(input.content),
    ...(input.range ? { range: Object.freeze({ ...input.range }) } : {})
  });
}

function decodePromptContextRange(value: unknown): PromptContextRange {
  if (!isRecord(value)) throw new TypeError('Prompt context range must be an object.');
  const unsupported = Object.keys(value).filter((key) => key !== 'kind' && key !== 'start' && key !== 'end');
  if (unsupported.length > 0 || !oneOf(value.kind, ['line', 'byte'] as const)
    || (value.start !== undefined && !nonnegativeInteger(value.start))
    || (value.end !== undefined && !nonnegativeInteger(value.end))
    || (typeof value.start === 'number' && typeof value.end === 'number' && value.end < value.start)) {
    throw new TypeError('Prompt context range is invalid.');
  }
  return Object.freeze({ kind: value.kind, ...(value.start === undefined ? {} : { start: value.start }), ...(value.end === undefined ? {} : { end: value.end }) });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function oneOf<const TValue extends readonly string[]>(value: unknown, choices: TValue): value is TValue[number] {
  return typeof value === 'string' && choices.some((choice) => choice === value);
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
