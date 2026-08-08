import { createHash, randomUUID } from 'node:crypto';
import { normalizeToolEvidenceDelta, validateArtifactRef, type ArtifactRef, type ArtifactRepository, type EvidenceRecord } from '@agent-core/evidence';
import { SimpleTokenEstimator, type ModelImage, type TokenEstimator } from '@agent-core/model';
import {
  type JsonObject,
  type JsonValue,
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
  id: string;
  turnIndex: number;
  call: ToolCall;
  toolName: string;
  fullObservation: ToolObservation;
  durableObservation: ToolObservation;
  immediatePresentation: ToolObservationPresentation;
  retainedPresentation: ToolObservationPresentation;
  immediateImages: readonly ModelImage[];
  evidence: EvidenceRecord[];
  createdAt: string;
}

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
    if (!Number.isInteger(budgets.immediate) || budgets.immediate < 1 || !Number.isInteger(budgets.retained) || budgets.retained < 1) {
      throw new Error('Tool observation token budgets must be positive integers.');
    }
    this.budgets = budgets;
  }

  async put(input: {
    turnIndex: number;
    call: ToolCall;
    canonicalInput?: unknown;
    tool: ToolDefinition | undefined;
    observation: ToolObservation;
  }): Promise<ToolObservationRecord> {
    const complete = redactToolObservationPresentation(buildToolObservationPresentation(input.call, input.canonicalInput, input.observation, input.tool, this.budgets.immediate));
    const [immediatePresentation, retainedPresentation, immediateImages] = await Promise.all([
      this.fitPresentation(input.call.name, complete, this.budgets.immediate),
      this.fitPresentation(input.call.name, complete, this.budgets.retained),
      this.loadObservationImages(input.observation)
    ]);
    const id = `obs_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const durableObservation = observationForDurableStorage(input.observation, immediatePresentation);
    const record: ToolObservationRecord = {
      id,
      turnIndex: input.turnIndex,
      call: input.call,
      toolName: input.call.name,
      fullObservation: input.observation,
      durableObservation,
      immediatePresentation,
      retainedPresentation,
      immediateImages,
      evidence: normalizeToolEvidenceDelta(input.observation.evidence, { observationId: id, toolName: input.call.name, createdAt }),
      createdAt
    };
    this.records.set(record.id, record);
    return record;
  }

  get(id: string): ToolObservationRecord | undefined { return this.records.get(id); }

  private async fitPresentation(toolName: string, presentation: ToolObservationPresentation, maxTokens: number): Promise<ToolObservationPresentation> {
    const validated = validateToolObservationPresentation(presentation);
    if (!validated.ok) return invalidPresenterPresentation(toolName, validated.issues);
    const safePresentation = clonePresentation(validated.presentation);
    const serialized = serializeToolObservationPresentation(safePresentation);
    const tokens = this.estimator.estimateText(serialized);
    if (tokens <= maxTokens) return safePresentation;
    const artifact = this.artifacts
      ? await this.artifacts.store({
        label: `${toolName}-observation`,
        content: new TextEncoder().encode(`${serialized}\n`),
        mediaType: 'application/json; charset=utf-8',
        description: 'Complete tool observation presentation.'
      })
      : undefined;
    return {
      ok: safePresentation.ok,
      title: safePresentation.title,
      summary: safePresentation.summary,
      ...(safePresentation.scope ? { scope: safePresentation.scope } : {}),
      results: artifact ? { artifact: toJsonValue(artifact) } : { artifact: null },
      omitted: { presentationTokens: tokens, tokenBudget: maxTokens },
      coverage: 'partial',
      truncated: true,
      warnings: ['The complete structured observation exceeded the runtime token budget and was stored as an artifact.'],
      next: artifact ? `Use read_artifact with artifactId ${artifact.artifactId} to inspect the complete observation.` : 'Make a narrower tool call to retrieve less output.'
    };
  }

  private async loadObservationImages(observation: ToolObservation): Promise<readonly ModelImage[]> {
    if (!this.artifacts) return [];
    return Promise.all((observation.content ?? []).flatMap((content) => content.type === 'image' ? [content] : []).map(async (content) => ({
      type: 'bytes' as const,
      data: await this.artifacts?.readVerified(content.artifact) ?? new Uint8Array(),
      mediaType: content.artifact.mediaType as `image/${string}`,
      detail: content.detail
    })));
  }
}

function observationForDurableStorage(observation: ToolObservation, presentation: ToolObservationPresentation): ToolObservation {
  if (presentation.truncated !== true || observation.kind === 'failure') return observation;
  const artifact = presentationArtifact(presentation);
  return {
    kind: 'result',
    ok: observation.ok,
    summary: observation.summary,
    scope: {
      resources: observation.scope.resources,
      coverage: 'partial',
      cause: artifact ? 'complete output stored as an artifact' : 'output exceeded the runtime token budget'
    },
    ...(artifact ? { content: [...(observation.content ?? []), { type: 'artifact', artifact }] } : {}),
    output: {
      truncated: true,
      artifact: artifact ?? null,
      omitted: presentation.omitted ?? {}
    }
  };
}

function presentationArtifact(presentation: ToolObservationPresentation): ArtifactRef | undefined {
  const results = presentation.results;
  if (results === undefined || !isJsonObject(results)) return undefined;
  const candidate = results.artifact;
  if (candidate === undefined || !isJsonObject(candidate)) return undefined;
  try {
    validateArtifactRef(candidate);
    return Object.freeze({ ...candidate });
  } catch {
    return undefined;
  }
}

export function serializeToolObservationPresentation(presentation: ToolObservationPresentation): string {
  return JSON.stringify(presentation, null, 2);
}

function buildToolObservationPresentation(
  toolCall: ToolCall,
  canonicalInput: unknown,
  observation: ToolObservation,
  tool: ToolDefinition | undefined,
  maxTokens: number
): ToolObservationPresentation {
  let raw: unknown;
  try {
    raw = tool?.presentObservation
      ? tool.presentObservation({ call: toolCall, input: canonicalInput, observation, limit: { maxTokens } })
      : fallbackToolObservationPresentation(toolCall, observation);
  } catch (error) {
    return {
      ok: false,
      title: 'Invalid tool presenter output',
      summary: `Presenter for ${toolCall.name} threw before producing an observation presentation.`,
      failures: { reason: 'presenter_error', error: error instanceof Error ? error.message : String(error) },
      coverage: 'partial',
      next: 'Inspect the persisted tool failure and fix the presenter.'
    };
  }
  const validated = validateToolObservationPresentation(raw);
  return validated.ok ? validated.presentation : invalidPresenterPresentation(toolCall.name, validated.issues);
}

function fallbackToolObservationPresentation(toolCall: ToolCall, observation: ToolObservation): ToolObservationPresentation {
  const base = {
    ok: observation.ok,
    title: `${toolCall.name} observation`,
    summary: observation.summary,
    scope: toJsonObject(observation.scope),
    coverage: observation.scope.coverage
  };
  if (observation.kind === 'result') {
    return {
      ...base,
      results: {
        output: toJsonValue(observation.output),
        ...(observation.content ? { content: toJsonValue(observation.content) } : {}),
        ...(observation.metadata ? { metadata: toJsonValue(observation.metadata) } : {})
      },
      ...(observation.scope.coverage === 'partial' ? { next: 'Continue with the indicated range or artifact when more coverage is required.' } : {})
    };
  }
  return { ...base, failures: toJsonValue(observation.output), next: observation.output.recovery };
}

function invalidPresenterPresentation(toolName: string, issues: { path: string; message: string }[]): ToolObservationPresentation {
  return {
    ok: false,
    title: 'Invalid tool presenter output',
    summary: `Presenter for ${toolName} produced an invalid observation presentation.`,
    failures: { reason: 'invalid_presenter_output', issues: issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    coverage: 'partial',
    next: 'Fix the tool presenter before using this result.'
  };
}

function redactToolObservationPresentation(presentation: ToolObservationPresentation): ToolObservationPresentation {
  const state = { redactions: 0 };
  const redacted = redactJsonValue(toJsonValue(presentation), [], state);
  const validated = validateToolObservationPresentation(redacted);
  const result = validated.ok ? validated.presentation : invalidPresenterPresentation('redaction', validated.issues);
  if (state.redactions === 0) return result;
  return { ...result, warnings: [...(result.warnings ?? []), `Redacted ${String(state.redactions)} sensitive value${state.redactions === 1 ? '' : 's'}.`] };
}

function redactJsonValue(value: JsonValue, pathParts: string[], state: { redactions: number }): JsonValue {
  if (typeof value === 'string') return redactString(value, pathParts, state);
  if (Array.isArray(value)) return value.map((item, index) => redactJsonValue(item, [...pathParts, String(index)], state));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJsonValue(item, [...pathParts, key], state)]));
}

function redactString(value: string, pathParts: string[], state: { redactions: number }): string {
  const key = pathParts.at(-1) ?? '';
  if (/(authorization|credential|password|secret|token|api[-_]?key)/iu.test(key) && value.length > 0) {
    state.redactions += 1;
    return '[REDACTED]';
  }
  const patterns = [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, /(sk-(?:or-v1-)?[A-Za-z0-9_-]{16,})/gu, /([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*=)[^\s]+/giu];
  let result = value;
  for (const pattern of patterns) result = result.replace(pattern, (_match: string, prefix?: string) => { state.redactions += 1; return prefix ? `${prefix}[REDACTED]` : '[REDACTED]'; });
  return result;
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  return isJsonObject(json) ? json : { value: json };
}

function clonePresentation(value: ToolObservationPresentation): ToolObservationPresentation {
  const cloned = validateToolObservationPresentation(toJsonValue(value));
  if (!cloned.ok) throw new Error('Validated tool observation presentation could not be cloned.');
  return cloned.presentation;
}

function isJsonObject(value: JsonValue): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function sha256ToolObservationPresentation(presentation: ToolObservationPresentation): string {
  return createHash('sha256').update(serializeToolObservationPresentation(presentation)).digest('hex');
}
