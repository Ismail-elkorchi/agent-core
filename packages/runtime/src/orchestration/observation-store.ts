import { createHash, randomUUID } from 'node:crypto';
import {
  normalizeToolEvidenceDelta,
  parseJsonValue,
  type ArtifactRef,
  type ArtifactRepository,
  type EvidenceRecord,
  type JsonObject,
  type JsonValue
} from '@agent-core/evidence';
import { SimpleTokenEstimator, type ModelImage, type TokenEstimator } from '@agent-core/model';
import {
  parseToolObservation,
  normalizeToolObservationForPersistence,
  type ToolCall,
  type ToolDefinition,
  type ToolObservationPresentation,
  type ToolObservation,
  toJsonValue,
  validateToolObservationPresentation
} from '@agent-core/tools';

export interface ToolObservationTokenBudgets {
  readonly immediate: number;
  readonly retained: number;
}

export interface ToolObservationRecord {
  readonly id: string;
  readonly turnIndex: number;
  readonly call: ToolCall;
  readonly toolName: string;
  readonly fullObservation: ToolObservation;
  readonly durableObservation: ToolObservation;
  readonly immediatePresentation: ToolObservationPresentation;
  readonly retainedPresentation: ToolObservationPresentation;
  readonly immediateImages: readonly ModelImage[];
  readonly evidence: readonly EvidenceRecord[];
  readonly createdAt: string;
}

const MAX_DURABLE_OBSERVATION_BYTES = 256 * 1024;

export class ObservationStore {
  private readonly records = new Map<string, ToolObservationRecord>();
  private readonly estimator: TokenEstimator;
  private readonly artifacts: ArtifactRepository | undefined;
  private budgets: ToolObservationTokenBudgets;

  constructor(options: { estimator?: TokenEstimator; artifacts?: ArtifactRepository; budgets?: ToolObservationTokenBudgets } = {}) {
    this.estimator = options.estimator ?? new SimpleTokenEstimator();
    this.artifacts = options.artifacts;
    this.budgets = options.budgets ?? { immediate: 3_000, retained: 600 };
  }

  setTokenBudgets(budgets: ToolObservationTokenBudgets): void {
    if (!Number.isInteger(budgets.immediate) || budgets.immediate < 1 || !Number.isInteger(budgets.retained) || budgets.retained < 1) throw new Error('Tool observation token budgets must be positive integers.');
    this.budgets = Object.freeze({ ...budgets });
  }

  async put(input: {
    readonly turnIndex: number;
    readonly call: ToolCall;
    readonly canonicalInput?: unknown;
    readonly tool: ToolDefinition | undefined;
    readonly observation: ToolObservation;
  }): Promise<ToolObservationRecord> {
    const canonical = parseToolObservation(input.tool, input.observation);
    const redactedDurable = await transformToolObservationForDurability(canonical);
    const durableJson = serializeObservation(redactedDurable);
    const rawPresentation = buildToolObservationPresentation(input.call, input.canonicalInput, canonical, input.tool, this.budgets.immediate);
    const safePresentation = redactToolObservationPresentation(rawPresentation);
    const presentationOversized = this.estimator.estimateText(serializeToolObservationPresentation(safePresentation)) > Math.min(this.budgets.immediate, this.budgets.retained);
    const needsCanonicalArtifact = byteLength(durableJson) > MAX_DURABLE_OBSERVATION_BYTES || presentationOversized;
    const canonicalArtifact = needsCanonicalArtifact && this.artifacts
      ? await this.artifacts.store({
        label: `${input.call.name}-canonical-observation`,
        content: new TextEncoder().encode(`${durableJson}\n`),
        mediaType: 'application/json; charset=utf-8',
        description: 'Canonical redacted tool observation.'
      })
      : undefined;
    const durableObservation = byteLength(durableJson) > MAX_DURABLE_OBSERVATION_BYTES
      ? boundedDurableObservation(redactedDurable, canonicalArtifact, byteLength(durableJson))
      : redactedDurable;
    const immediatePresentation = this.fitPresentation(safePresentation, this.budgets.immediate, canonicalArtifact);
    const retainedPresentation = this.fitPresentation(safePresentation, this.budgets.retained, canonicalArtifact);
    const immediateImages = await this.loadObservationImages(canonical);
    const id = `obs_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const record: ToolObservationRecord = Object.freeze({
      id,
      turnIndex: input.turnIndex,
      call: input.call,
      toolName: input.call.name,
      fullObservation: canonical,
      durableObservation,
      immediatePresentation,
      retainedPresentation,
      immediateImages,
      evidence: Object.freeze(normalizeToolEvidenceDelta(durableObservation.evidence, { observationId: id, toolName: input.call.name, createdAt })),
      createdAt
    });
    this.records.set(record.id, record);
    return record;
  }

  get(id: string): ToolObservationRecord | undefined { return this.records.get(id); }

  private fitPresentation(presentation: ToolObservationPresentation, maxTokens: number, artifact?: ArtifactRef): ToolObservationPresentation {
    const validated = validateToolObservationPresentation(presentation);
    if (!validated.ok) return invalidPresenterPresentation('unknown', validated.issues);
    const safe = clonePresentation(validated.presentation);
    if (this.estimator.estimateText(serializeToolObservationPresentation(safe)) <= maxTokens) return safe;
    return truncatePresentation(safe, maxTokens, this.estimator, artifact);
  }

  private async loadObservationImages(observation: ToolObservation): Promise<readonly ModelImage[]> {
    const artifacts = this.artifacts;
    if (!artifacts) return [];
    return Promise.all((observation.content ?? []).flatMap((content) => content.type === 'image' ? [content] : []).map(async (content) => ({
      type: 'bytes' as const,
      data: await artifacts.readVerified(content.artifact),
      mediaType: content.artifact.mediaType as `image/${string}`,
      detail: content.detail
    })));
  }
}

export async function transformToolObservationForDurability(
  observation: ToolObservation,
  options: { readonly artifacts?: ArtifactRepository; readonly retainUnredacted?: boolean } = {}
): Promise<ToolObservation> {
  const canonical = normalizeToolObservationForPersistence(observation);
  const state = { redactions: 0 };
  const redacted = redactJsonValue(parseJsonValue(canonical), [], state);
  let durable = normalizeToolObservationForPersistence(redacted);
  if (state.redactions > 0 && options.retainUnredacted && options.artifacts) {
    const protectedArtifact = await options.artifacts.storeProtected({
      label: 'protected-tool-observation',
      content: new TextEncoder().encode(`${serializeObservation(canonical)}\n`),
      mediaType: 'application/json; charset=utf-8',
      description: 'Protected unredacted tool observation.'
    });
    durable = normalizeToolObservationForPersistence({
      ...durable,
      content: [...(durable.content ?? []), { type: 'artifact', artifact: protectedArtifact }],
      metadata: { ...(durable.metadata ?? {}), redactions: state.redactions, protectedArtifact }
    });
  } else if (state.redactions > 0) {
    durable = normalizeToolObservationForPersistence({ ...durable, metadata: { ...(durable.metadata ?? {}), redactions: state.redactions } });
  }
  return durable;
}

function boundedDurableObservation(observation: ToolObservation, artifact: ArtifactRef | undefined, originalBytes: number): ToolObservation {
  const content = [...(observation.content ?? []), ...(artifact ? [{ type: 'artifact' as const, artifact }] : [])];
  const metadata = { ...(observation.metadata ?? {}), durableObservation: { originalBytes, storedAsArtifact: artifact !== undefined, ...(artifact ? { artifact } : {}) } };
  if (observation.kind === 'failure') {
    return normalizeToolObservationForPersistence({
      ...observation,
      ...(content.length ? { content } : {}),
      metadata,
      output: { reason: observation.output.reason, ...(observation.output.recovery ? { recovery: observation.output.recovery } : {}), details: artifact ? { artifact, originalBytes } : { originalBytes } }
    });
  }
  return normalizeToolObservationForPersistence({
    ...observation,
    ...(content.length ? { content } : {}),
    metadata,
    output: preserveImportantResultFields(observation.output, artifact, originalBytes)
  });
}

function preserveImportantResultFields(output: unknown, artifact: ArtifactRef | undefined, originalBytes: number): JsonValue {
  const value = parseJsonValue(output);
  const durable: Record<string, JsonValue> = { truncatedForPersistence: true, originalBytes, ...(artifact ? { artifact: parseJsonValue(artifact) } : {}) };
  if (isJsonObject(value)) {
    const important = /^(status|reason|processId|exitCode|signal|count|total|path|file|files|matches|changed|created|deleted|renamed|cursor|nextCursor|fileBytes|observedBytes|retainedBytes|omittedBytes)$/u;
    for (const [key, item] of Object.entries(value)) if (important.test(key) && byteLength(JSON.stringify(item)) <= 16_384) durable[key] = parseJsonValue(item);
  }
  return parseJsonValue(durable);
}

function truncatePresentation(presentation: ToolObservationPresentation, maxTokens: number, estimator: TokenEstimator, artifact?: ArtifactRef): ToolObservationPresentation {
  const omitted: Record<string, JsonValue> = { ...(presentation.omitted ?? {}), tokenBudget: maxTokens };
  let results = presentation.results;
  if (isJsonObject(results)) {
    const compact: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(results)) {
      const candidate = parseJsonValue(value);
      if (Array.isArray(candidate)) {
        const kept: JsonValue[] = [];
        for (const item of candidate) {
          const trial = { ...presentation, results: { ...compact, [key]: [...kept, item] } };
          if (estimator.estimateText(JSON.stringify(trial)) > Math.max(1, maxTokens - 32)) break;
          kept.push(item);
        }
        compact[key] = kept;
        if (kept.length < candidate.length) omitted[`${key}Items`] = candidate.length - kept.length;
      } else if (estimator.estimateText(JSON.stringify({ ...presentation, results: { ...compact, [key]: candidate } })) <= Math.max(1, maxTokens - 32)) compact[key] = candidate;
      else omitted[`${key}Omitted`] = true;
    }
    results = { ...compact, ...(artifact ? { artifact: parseJsonValue(artifact) } : {}) };
  } else if (artifact) results = { artifact: parseJsonValue(artifact) };
  const compacted: ToolObservationPresentation = {
    ok: presentation.ok,
    title: presentation.title,
    summary: presentation.summary,
    ...(presentation.scope ? { scope: presentation.scope } : {}),
    ...(results !== undefined ? { results } : {}),
    ...(presentation.failures !== undefined ? { failures: compactFailure(presentation.failures) } : {}),
    omitted,
    coverage: 'partial',
    truncated: true,
    warnings: [...(presentation.warnings ?? []), 'The model view was truncated; durable tool truth is unchanged.'],
    ...(artifact ? { next: `Use read_artifact with artifactId ${artifact.artifactId} to inspect the canonical observation.` } : { next: 'Make a narrower tool call to retrieve less output.' })
  };
  const validated = validateToolObservationPresentation(compacted);
  return validated.ok ? validated.presentation : invalidPresenterPresentation('truncation', validated.issues);
}

function compactFailure(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value);
  return byteLength(serialized) <= 16_384 ? value : { truncated: true, preview: serialized.slice(0, 4_096) };
}

export function serializeToolObservationPresentation(presentation: ToolObservationPresentation): string { return JSON.stringify(presentation, null, 2); }
function serializeObservation(observation: ToolObservation): string { return JSON.stringify(observation); }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }

function buildToolObservationPresentation(toolCall: ToolCall, canonicalInput: unknown, observation: ToolObservation, tool: ToolDefinition | undefined, maxTokens: number): ToolObservationPresentation {
  let raw: unknown;
  try {
    raw = tool?.presentObservation
      ? tool.presentObservation({ call: toolCall, input: canonicalInput, observation, limit: { maxTokens } })
      : fallbackToolObservationPresentation(toolCall, observation);
  } catch (error) {
    return { ok: false, title: 'Invalid tool presenter output', summary: `Presenter for ${toolCall.name} threw before producing an observation presentation.`, failures: { reason: 'presenter_error', error: error instanceof Error ? error.message : String(error) }, coverage: 'partial', next: 'Inspect the persisted tool failure and fix the presenter.' };
  }
  const validated = validateToolObservationPresentation(raw);
  return validated.ok ? validated.presentation : invalidPresenterPresentation(toolCall.name, validated.issues);
}

function fallbackToolObservationPresentation(toolCall: ToolCall, observation: ToolObservation): ToolObservationPresentation {
  const base = { ok: observation.ok, title: `${toolCall.name} observation`, summary: observation.summary, scope: toJsonObject(observation.scope), coverage: observation.scope.coverage };
  if (observation.kind === 'result') {
    return { ...base, results: { output: toJsonValue(observation.output), ...(observation.content ? { content: toJsonValue(observation.content) } : {}), ...(observation.metadata ? { metadata: toJsonValue(observation.metadata) } : {}) }, ...(observation.scope.coverage === 'partial' ? { next: 'Continue with the indicated range or artifact when more coverage is required.' } : {}) };
  }
  return { ...base, failures: toJsonValue(observation.output), next: observation.output.recovery };
}

function invalidPresenterPresentation(toolName: string, issues: readonly { readonly path: string; readonly message: string }[]): ToolObservationPresentation {
  return { ok: false, title: 'Invalid tool presenter output', summary: `Presenter for ${toolName} produced an invalid observation presentation.`, failures: { reason: 'invalid_presenter_output', issues: issues.map((issue) => ({ path: issue.path, message: issue.message })) }, coverage: 'partial', next: 'Fix the tool presenter before using this result.' };
}

function redactToolObservationPresentation(presentation: ToolObservationPresentation): ToolObservationPresentation {
  const state = { redactions: 0 };
  const redacted = redactJsonValue(parseJsonValue(presentation), [], state);
  const validated = validateToolObservationPresentation(redacted);
  const result = validated.ok ? validated.presentation : invalidPresenterPresentation('redaction', validated.issues);
  if (state.redactions === 0) return result;
  return { ...result, warnings: [...(result.warnings ?? []), `Redacted ${String(state.redactions)} sensitive value${state.redactions === 1 ? '' : 's'}.`] };
}

function redactJsonValue(value: JsonValue, pathParts: readonly string[], state: { redactions: number }): JsonValue {
  if (typeof value === 'string') return redactString(value, pathParts, state);
  if (Array.isArray(value)) return value.map((item, index) => redactJsonValue(item, [...pathParts, String(index)], state));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJsonValue(item, [...pathParts, key], state)]));
}

function redactString(value: string, pathParts: readonly string[], state: { redactions: number }): string {
  const key = pathParts.at(-1) ?? '';
  if (/(authorization|credential|password|secret|token|api[-_]?key)/iu.test(key) && value.length > 0) { state.redactions += 1; return '[REDACTED]'; }
  const patterns = [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, /(Basic\s+)[A-Za-z0-9+/=]+/giu, /(sk-(?:or-v1-)?[A-Za-z0-9_-]{16,})/gu, /([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*=)[^\s]+/giu, /((?:password|secret|token|api[-_]?key)\s*[:=]\s*)[^\s,;]+/giu];
  let result = value;
  for (const pattern of patterns) result = result.replace(pattern, (_match: string, prefix?: string) => { state.redactions += 1; return prefix ? `${prefix}[REDACTED]` : '[REDACTED]'; });
  return result;
}

function toJsonObject(value: unknown): JsonObject { const json = parseJsonValue(value); return isJsonObject(json) ? json : { value: json }; }
function clonePresentation(value: ToolObservationPresentation): ToolObservationPresentation { const cloned = validateToolObservationPresentation(parseJsonValue(value)); if (!cloned.ok) throw new Error('Validated tool observation presentation could not be cloned.'); return cloned.presentation; }
function isJsonObject(value: JsonValue | undefined): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function sha256ToolObservationPresentation(presentation: ToolObservationPresentation): string { return createHash('sha256').update(serializeToolObservationPresentation(presentation)).digest('hex'); }
