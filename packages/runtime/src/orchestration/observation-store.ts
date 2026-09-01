import { randomUUID } from 'node:crypto';
import {
  redactJson,
  type ArtifactRef,
  type ArtifactRepository,
  type PublicArtifactRef
} from '@agent-core/persistence';
import { parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { SimpleTokenEstimator, type ModelImage, type TokenEstimator } from '@agent-core/model';
import {
  decodeOwnedToolObservationForPersistence,
  encodeToolFailureOutput,
  encodeToolObservation,
  updateToolObservation,
  type ToolCall,
  type ToolDefinition,
  recordObservedFacts,
  type ObservedFactRecord,
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
  readonly imageArtifacts: readonly PublicArtifactRef[];
  readonly observedFacts: readonly ObservedFactRecord[];
  readonly durableStorageDegraded?: { readonly message: string };
  readonly createdAt: string;
}

export interface CommittedToolObservation {
  readonly id: string;
  readonly turnIndex: number;
  readonly call: ToolCall;
  readonly toolName: string;
  readonly canonicalSnapshot?: JsonValue;
  readonly tool: ToolDefinition | undefined;
  readonly fullObservation: ToolObservation;
  readonly durableObservation: ToolObservation;
  readonly canonicalArtifact?: PublicArtifactRef;
  readonly durableStorageDegraded?: { readonly message: string };
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

  async commitToolObservation(input: {
    readonly turnIndex: number;
    readonly call: ToolCall;
    readonly canonicalSnapshot?: JsonValue;
    readonly tool: ToolDefinition | undefined;
    readonly observation: ToolObservation;
  }): Promise<CommittedToolObservation> {
    const canonical = input.observation;
    const redactedDurable = await transformToolObservationForDurability(canonical);
    const durableJson = serializeObservation(redactedDurable);
    const needsCanonicalArtifact = byteLength(durableJson) > MAX_DURABLE_OBSERVATION_BYTES
      || this.estimator.estimateText(durableJson) > Math.min(this.budgets.immediate, this.budgets.retained);
    let canonicalArtifact: PublicArtifactRef | undefined;
    let durableStorageDegraded: { readonly message: string } | undefined;
    if (needsCanonicalArtifact && this.artifacts) {
      try {
        canonicalArtifact = await this.artifacts.store({
          label: `${input.call.name}-canonical-observation`,
          content: new TextEncoder().encode(`${durableJson}\n`),
          mediaType: 'application/json; charset=utf-8',
          description: 'Canonical redacted tool observation.'
        });
      } catch (error) {
        durableStorageDegraded = Object.freeze({ message: error instanceof Error ? error.message : String(error) });
      }
    }
    const durableBase = durableStorageDegraded
      ? updateToolObservation(redactedDurable, { metadata: {
        ...(redactedDurable.metadata ?? {}), durableStorage: { status: 'degraded', message: durableStorageDegraded.message }
      } })
      : redactedDurable;
    const durableObservation = byteLength(durableJson) > MAX_DURABLE_OBSERVATION_BYTES
      ? boundedDurableObservation(durableBase, canonicalArtifact, byteLength(durableJson))
      : durableBase;
    const committed: CommittedToolObservation = Object.freeze({
      id: `obs_${randomUUID()}`,
      turnIndex: input.turnIndex,
      call: input.call,
      toolName: input.call.name,
      ...(input.canonicalSnapshot === undefined ? {} : { canonicalSnapshot: input.canonicalSnapshot }),
      tool: input.tool,
      fullObservation: canonical,
      durableObservation,
      ...(canonicalArtifact ? { canonicalArtifact } : {}),
      ...(durableStorageDegraded ? { durableStorageDegraded } : {}),
      createdAt: new Date().toISOString()
    });
    return committed;
  }

  async projectToolObservation(committed: CommittedToolObservation, modelInputModalities: readonly string[] = ['text']): Promise<ToolObservationRecord> {
    const modelObservation = filterToolResultContentForModel(committed.fullObservation, modelInputModalities);
    const immediateRaw = buildToolObservationPresentation(committed.call, committed.canonicalSnapshot, modelObservation, committed.tool, 'immediate', this.budgets.immediate);
    const retainedRaw = buildToolObservationPresentation(committed.call, committed.canonicalSnapshot, modelObservation, committed.tool, 'retained', this.budgets.retained);
    const immediatePresentation = this.fitPresentation(redactToolObservationPresentation(immediateRaw), this.budgets.immediate, committed.canonicalArtifact);
    const retainedPresentation = this.fitPresentation(redactToolObservationPresentation(retainedRaw), this.budgets.retained, committed.canonicalArtifact);
    const immediateImages = await this.loadObservationImages(modelObservation);
    const imageArtifacts = Object.freeze((modelObservation.content ?? []).flatMap((content) => content.type === 'image' ? [content.artifact] : []));
    const record: ToolObservationRecord = Object.freeze({
      id: committed.id,
      turnIndex: committed.turnIndex,
      call: committed.call,
      toolName: committed.toolName,
      fullObservation: committed.fullObservation,
      durableObservation: committed.durableObservation,
      immediatePresentation,
      retainedPresentation,
      immediateImages,
      imageArtifacts,
      observedFacts: Object.freeze(recordObservedFacts(committed.durableObservation.observedFacts, { observationId: committed.id, toolName: committed.toolName, createdAt: committed.createdAt })),
      ...(committed.durableStorageDegraded ? { durableStorageDegraded: committed.durableStorageDegraded } : {}),
      createdAt: committed.createdAt
    });
    this.records.set(record.id, record);
    return record;
  }

  get(id: string): ToolObservationRecord | undefined { return this.records.get(id); }

  private fitPresentation(presentation: ToolObservationPresentation, maxTokens: number, artifact?: ArtifactRef): ToolObservationPresentation {
    if (this.estimator.estimateText(serializeToolObservationPresentation(presentation)) <= maxTokens) return presentation;
    return truncatePresentation(presentation, maxTokens, this.estimator, artifact);
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
  const canonical = observation;
  const redacted = redactJson(encodeToolObservation(canonical));
  if (!isJsonObject(redacted.value)) throw new Error('Redacted tool observation is invalid.');
  let durable = decodeOwnedToolObservationForPersistence(redacted.value);
  if (redacted.redactions > 0 && options.retainUnredacted && options.artifacts) {
    const protectedArtifact = await options.artifacts.storeProtected({
      label: 'protected-tool-observation',
      content: new TextEncoder().encode(`${serializeObservation(canonical)}\n`),
      mediaType: 'application/json; charset=utf-8',
      description: 'Protected unredacted tool observation.'
    });
    durable = updateToolObservation(durable, { metadata: { ...(durable.metadata ?? {}), redactions: redacted.redactions, protectedArtifact } });
  } else if (redacted.redactions > 0) {
    durable = updateToolObservation(durable, { metadata: { ...(durable.metadata ?? {}), redactions: redacted.redactions } });
  }
  return durable;
}

function boundedDurableObservation(observation: ToolObservation, artifact: PublicArtifactRef | undefined, originalBytes: number): ToolObservation {
  const content = [...(observation.content ?? []), ...(artifact ? [{ type: 'artifact' as const, artifact }] : [])];
  const metadata = { ...(observation.metadata ?? {}), durableObservation: { originalBytes, storedAsArtifact: artifact !== undefined, ...(artifact ? { artifact } : {}) } };
  if (observation.kind === 'failure') {
    return updateToolObservation(observation, { ...(content.length ? { content } : {}), metadata, output: boundedFailureOutput(observation.output, artifact, originalBytes) });
  }
  return updateToolObservation(observation, { ...(content.length ? { content } : {}), metadata, output: preserveImportantResultFields(observation.output, artifact, originalBytes) });
}

function boundedFailureOutput(output: import('@agent-core/tools').ToolFailureOutput, artifact: ArtifactRef | undefined, originalBytes: number): JsonValue {
  const encoded = encodeToolFailureOutput(output);
  const storage: JsonObject = Object.freeze(artifact ? { artifact: Object.freeze({ ...artifact }), originalBytes } : { originalBytes });
  const common = { blocked: true as const, reason: output.reason, recovery: output.recovery };
  if (output.reason === 'unknown_tool') return encoded;
  if (output.reason === 'policy') return Object.freeze({ ...common, ...(output.tool ? { tool: output.tool } : {}), ...(output.policyReason ? { policyReason: output.policyReason } : {}), details: storage });
  if (output.reason === 'invalid_arguments') { const issues = boundedFailureField(encoded.issues); return Object.freeze({ ...common, ...(issues ? { issues } : {}), details: storage }); }
  if (output.reason === 'invalid_output') return Object.freeze({
    ...common,
    issues: boundedFailureField(encoded.issues) ?? Object.freeze({ issues: Object.freeze([Object.freeze({ path: Object.freeze([]), code: 'details_stored_as_artifact', message: 'Full validation issues are in the canonical observation artifact.' })]) }),
    details: storage
  });
  if (output.reason === 'missing_service') { const serviceDetails = boundedFailureField(encoded.details); return Object.freeze({ ...common, service: output.service, details: Object.freeze({ ...storage, ...(serviceDetails ? { serviceDetails } : {}) }) }); }
  return Object.freeze({ ...common, error: output.error, details: storage });
}

function boundedFailureField(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  return byteLength(serialized) <= 16_384 ? value : undefined;
}

/** Generic result-content assembly. It is intentionally independent of tool names. */
export function filterToolResultContentForModel(observation: ToolObservation, modelInputModalities: readonly string[]): ToolObservation {
  if (!observation.content?.some((item) => item.type === 'image') || modelInputModalities.includes('image')) return observation;
  const hiddenImages = observation.content.filter((item) => item.type === 'image');
  const content = observation.content.map((item) => item.type === 'image'
    ? Object.freeze({ type: 'artifact' as const, artifact: item.artifact })
    : item);
  return updateToolObservation(observation, {
    summary: `${observation.summary} ${String(hiddenImages.length)} image${hiddenImages.length === 1 ? '' : 's'} exist as public artifacts but were not attached because the active model does not support image input.`, content,
    metadata: {
      ...(observation.metadata ?? {}),
      modelContentFilter: {
        unsupportedModality: 'image',
        convertedToArtifactMetadata: hiddenImages.map((item) => item.artifact)
      }
    }
  });
}

function preserveImportantResultFields(value: JsonValue, artifact: ArtifactRef | undefined, originalBytes: number): JsonValue {
  const durable: Record<string, JsonValue> = { truncatedForPersistence: true, originalBytes, ...(artifact ? { artifact: { ...artifact } } : {}) };
  if (isJsonObject(value)) {
    const important = /^(status|reason|processId|exitCode|signal|count|total|path|file|files|matches|changed|created|deleted|renamed|cursor|nextCursor|fileBytes|observedBytes|retainedBytes|omittedBytes)$/u;
    for (const [key, item] of Object.entries(value)) if (important.test(key) && byteLength(JSON.stringify(item)) <= 16_384) durable[key] = item;
  }
  return Object.freeze(durable);
}

function truncatePresentation(presentation: ToolObservationPresentation, maxTokens: number, estimator: TokenEstimator, artifact?: ArtifactRef): ToolObservationPresentation {
  const compacted: ToolObservationPresentation = Object.freeze({
    ok: presentation.ok,
    title: unicodePrefix(presentation.title, 128),
    summary: unicodePrefix(presentation.summary, 512),
    results: artifact ? Object.freeze({ artifact }) : Object.freeze({ presenterOverBudget: true }),
    omitted: Object.freeze({ tokenBudget: maxTokens }),
    coverage: 'partial',
    truncated: true,
    warnings: Object.freeze(['The domain presenter exceeded its hard budget; durable tool truth is unchanged.']),
    ...(artifact ? { next: `Use read_artifact with artifactId ${artifact.artifactId} to inspect the canonical observation.` } : { next: 'Make a narrower tool call to retrieve less output.' })
  });
  return estimator.estimateText(JSON.stringify(compacted)) <= maxTokens ? compacted : Object.freeze({
    ok: presentation.ok,
    title: 'Tool result',
    summary: 'The model view exceeded its hard budget.',
    results: artifact ? Object.freeze({ artifact }) : Object.freeze({ presenterOverBudget: true }),
    omitted: Object.freeze({ tokenBudget: maxTokens }),
    coverage: 'partial',
    truncated: true
  });
}
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
function unicodePrefix(value: string, count: number): string {
  return Array.from(GRAPHEME_SEGMENTER.segment(value), (item) => item.segment).slice(0, count).join('');
}

export function serializeToolObservationPresentation(presentation: ToolObservationPresentation): string { return JSON.stringify(presentation, null, 2); }
function serializeObservation(observation: ToolObservation): string { return JSON.stringify(observation); }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }

function buildToolObservationPresentation(toolCall: ToolCall, canonicalSnapshot: JsonValue | undefined, observation: ToolObservation, tool: ToolDefinition | undefined, mode: 'immediate' | 'retained', maxTokens: number): ToolObservationPresentation {
  if (!tool?.presentObservation) return fallbackToolObservationPresentation(toolCall, observation);
  const raw: unknown = tool.presentObservation({ call: toolCall, input: canonicalSnapshot, observation, mode, maxTokens });
  const validated = validateToolObservationPresentation(raw);
  return validated.ok ? validated.presentation : invalidPresenterPresentation(toolCall.name, validated.issues);
}

function fallbackToolObservationPresentation(toolCall: ToolCall, observation: ToolObservation): ToolObservationPresentation {
  const base = { ok: observation.ok, title: `${toolCall.name} observation`, summary: observation.summary, scope: toJsonObject(observation.scope), coverage: observation.scope.coverage };
  if (observation.kind === 'result') {
    return Object.freeze({ ...base, results: Object.freeze({ output: observation.output, ...(observation.content ? { content: toJsonValue(observation.content) } : {}), ...(observation.metadata ? { metadata: observation.metadata } : {}) }), ...(observation.scope.coverage === 'partial' ? { next: 'Continue with the indicated range or artifact when more coverage is required.' } : {}) });
  }
  return Object.freeze({ ...base, failures: encodeToolFailureOutput(observation.output), next: observation.output.recovery });
}

function invalidPresenterPresentation(toolName: string, issues: readonly { readonly path: string; readonly message: string }[]): ToolObservationPresentation {
  return Object.freeze({
    ok: false,
    title: 'Invalid tool presenter output',
    summary: `Presenter for ${toolName} produced an invalid observation presentation.`,
    failures: Object.freeze({ reason: 'invalid_presenter_output', issues: Object.freeze(issues.map((issue) => Object.freeze({ path: issue.path, message: issue.message }))) }),
    coverage: 'partial',
    next: 'Fix the tool presenter before using this result.'
  });
}

function redactToolObservationPresentation(presentation: ToolObservationPresentation): ToolObservationPresentation {
  const title = redactJson(presentation.title);
  const summary = redactJson(presentation.summary);
  const scope = presentation.scope === undefined ? undefined : redactJson(presentation.scope);
  const filters = presentation.filters === undefined ? undefined : redactJson(presentation.filters);
  const limits = presentation.limits === undefined ? undefined : redactJson(presentation.limits);
  const results = presentation.results === undefined ? undefined : redactJson(presentation.results);
  const failures = presentation.failures === undefined ? undefined : redactJson(presentation.failures);
  const omitted = presentation.omitted === undefined ? undefined : redactJson(presentation.omitted);
  const warningValues = (presentation.warnings ?? []).map((warning) => redactJson(warning));
  const next = presentation.next === undefined ? undefined : redactJson(presentation.next);
  const redactions = title.redactions + summary.redactions + (scope?.redactions ?? 0) + (filters?.redactions ?? 0) + (limits?.redactions ?? 0)
    + (results?.redactions ?? 0) + (failures?.redactions ?? 0) + (omitted?.redactions ?? 0) + warningValues.reduce((total, warning) => total + warning.redactions, 0) + (next?.redactions ?? 0);
  const warnings = Object.freeze([
    ...warningValues.map((warning) => warning.value),
    ...(redactions === 0 ? [] : [`Redacted ${String(redactions)} sensitive value${redactions === 1 ? '' : 's'}.`])
  ]);
  return Object.freeze({
    ok: presentation.ok,
    title: title.value,
    summary: summary.value,
    ...(scope ? { scope: scope.value } : {}),
    ...(filters ? { filters: filters.value } : {}),
    ...(limits ? { limits: limits.value } : {}),
    ...(results ? { results: results.value } : {}),
    ...(failures ? { failures: failures.value } : {}),
    ...(omitted ? { omitted: omitted.value } : {}),
    ...(presentation.coverage ? { coverage: presentation.coverage } : {}),
    ...(presentation.truncated === undefined ? {} : { truncated: presentation.truncated }),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(next ? { next: next.value } : {})
  });
}

function toJsonObject(value: unknown): JsonObject { const json = parseJsonValue(value); return isJsonObject(json) ? json : { value: json }; }
function isJsonObject(value: JsonValue | undefined): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
