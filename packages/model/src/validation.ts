import type {
  ModelProfile,
  ModelCapabilities,
  ModelLimits,
  ModelMessage,
  ModelImage,
  ModelModalities,
  ModelPricing,
  ModelProviderOptions,
  ModelReasoningEffort,
  ModelReasoningRequest,
  ModelRequest,
  ModelResponseFormat,
  ModelProviderState,
  ModelResponse,
  ModelStreamEvent,
  ModelTerminationReason,
  ModelTool,
  ModelToolCall,
  ModelTransportMetadata,
  ModelUsage
} from './index.js';
import { normalizeJsonSafe, parseJsonObject, type JsonObject, type JsonValue } from '@agent-core/json';

const MODEL_JSON_LIMITS = { maxDepth: 32, maxCollectionEntries: 10_000, maxStringBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 };
const OWNED_PROFILES = new WeakSet<ModelProfile>();
const OWNED_REQUESTS = new WeakSet<ModelRequest>();
const OWNED_RESPONSES = new WeakSet<ModelResponse>();
const OWNED_PROVIDER_STATES = new WeakSet<ModelProviderState>();
const OWNED_STREAM_EVENTS = new WeakSet<ModelStreamEvent>();

export class ModelContractError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super(`${message} ${issues.join(' ')}`.trim());
    this.name = 'ModelContractError';
    this.issues = Object.freeze([...issues]);
  }
}

export function parseModelProfile(value: unknown): ModelProfile {
  if (ownedBy(OWNED_PROFILES, value)) return value;
  if (!isRecord(value)) throw contract('Invalid model profile.', ['Expected an object.']);
  const issues: string[] = [];
  const id = typeof value.id === 'string' ? value.id : '';
  const provider = typeof value.provider === 'string' ? value.provider : '';
  nonempty(id, 'id', issues); nonempty(provider, 'provider', issues);
  if (value.displayName !== undefined && typeof value.displayName !== 'string') issues.push('displayName must be a string.');
  let capabilities: ModelCapabilities | undefined;
  let modalities: ModelModalities | undefined;
  let limits: ModelLimits | undefined;
  let pricing: ModelPricing | undefined;
  let metadata: JsonObject | undefined;
  try { capabilities = decodeOwnedModelCapabilities(value.capabilities); } catch (error) { issues.push(errorMessage(error)); }
  try { modalities = decodeOwnedModelModalities(value.modalities); } catch (error) { issues.push(errorMessage(error)); }
  try { limits = decodeOwnedModelLimits(value.limits); } catch (error) { issues.push(errorMessage(error)); }
  if (!stringArray(value.supportedParameters) || !value.supportedParameters.every((item) => MODEL_PARAMETERS.has(item))) issues.push('supportedParameters contains an unsupported canonical parameter.');
  else if (new Set(value.supportedParameters).size !== value.supportedParameters.length) issues.push('supportedParameters must not contain duplicates.');
  if (value.pricing !== undefined) try { pricing = decodePricing(value.pricing); } catch (error) { issues.push(errorMessage(error)); }
  if (value.metadata !== undefined) try { metadata = parseJsonObject(value.metadata, MODEL_JSON_LIMITS); } catch { issues.push('metadata must be a bounded JSON-safe object.'); }
  if (issues.length > 0) throw contract('Invalid model profile.', issues);
  if (!capabilities || !modalities || !limits) throw contract('Invalid model profile.', ['Required owned profile fields are missing.']);
  return own(OWNED_PROFILES, Object.freeze({
    id, provider,
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    capabilities, modalities, limits,
    supportedParameters: Object.freeze([...(value.supportedParameters as ModelProfile['supportedParameters'])]),
    ...(pricing ? { pricing } : {}), ...(metadata ? { metadata } : {})
  }));
}

export function parseModelRequest(value: unknown): ModelRequest {
  if (ownedBy(OWNED_REQUESTS, value)) return value;
  if (!isRecord(value)) throw contract('Invalid model request.', ['Expected an object.']);
  const issues: string[] = [];
  const model = typeof value.model === 'string' ? value.model : '';
  let messages: readonly ModelMessage[] | undefined;
  let responseFormat: ModelResponseFormat | undefined;
  let tools: readonly ModelTool[] | undefined;
  let reasoning: ModelReasoningRequest | undefined;
  let providerOptions: ModelProviderOptions | undefined;
  let metadata: Readonly<Record<string, string>> | undefined;
  if (!onlyKeys(value, ['model', 'messages', 'temperature', 'topP', 'maxOutputTokens', 'responseFormat', 'tools', 'keepAlive', 'reasoning', 'logprobs', 'topLogprobs', 'providerOptions', 'metadata', 'signal'])) issues.push('request contains unsupported fields.');
  nonempty(model, 'model', issues);
  if (!Array.isArray(value.messages) || value.messages.length === 0) issues.push('messages must be a non-empty array.');
  else {
    const owned: ModelMessage[] = [];
    value.messages.forEach((message, index) => { try { owned.push(decodeMessage(message, index)); } catch (error) { issues.push(errorMessage(error)); } });
    messages = Object.freeze(owned);
  }
  if (value.temperature !== undefined && !finiteInRange(value.temperature, 0, 2)) issues.push('temperature must be finite and between 0 and 2.');
  if (value.topP !== undefined && !finiteInRange(value.topP, 0, 1)) issues.push('topP must be finite and between 0 and 1.');
  if (value.maxOutputTokens !== undefined && !positiveInteger(value.maxOutputTokens)) issues.push('maxOutputTokens must be a positive integer.');
  if (value.responseFormat !== undefined) try { responseFormat = decodeModelResponseFormat(value.responseFormat); } catch { issues.push('responseFormat is invalid or not JSON-safe.'); }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) issues.push('tools contains an invalid definition.');
    else { const owned: ModelTool[] = []; for (const tool of value.tools) try { owned.push(decodeModelTool(tool)); } catch { issues.push('tools contains an invalid definition.'); } tools = Object.freeze(owned); }
  }
  if (value.keepAlive !== undefined && !(typeof value.keepAlive === 'string' || nonnegativeFinite(value.keepAlive))) issues.push('keepAlive must be a string or finite nonnegative number.');
  if (value.logprobs !== undefined && typeof value.logprobs !== 'boolean') issues.push('logprobs must be a boolean.');
  if (value.topLogprobs !== undefined && !nonnegativeInteger(value.topLogprobs)) issues.push('topLogprobs must be a nonnegative integer.');
  if (value.topLogprobs !== undefined && value.logprobs !== true) issues.push('topLogprobs requires logprobs=true.');
  if (value.reasoning !== undefined) try { reasoning = parseModelReasoningRequest(value.reasoning); } catch { issues.push('reasoning must be a valid discriminated strategy.'); }
  if (value.providerOptions !== undefined) try { providerOptions = decodeProviderOptions(value.providerOptions); } catch { issues.push('providerOptions must be namespaced to a provider and contain JSON-safe values.'); }
  if (value.metadata !== undefined) try { metadata = decodeStringMetadata(value.metadata); } catch { issues.push('metadata must contain string values.'); }
  if (value.signal !== undefined && !isAbortSignal(value.signal)) issues.push('signal must be an AbortSignal.');
  if (issues.length > 0) throw contract('Invalid model request.', issues);
  if (!messages) throw contract('Invalid model request.', ['messages must be a non-empty array.']);
  return own(OWNED_REQUESTS, Object.freeze({
    model, messages,
    ...(typeof value.temperature === 'number' ? { temperature: value.temperature } : {}),
    ...(typeof value.topP === 'number' ? { topP: value.topP } : {}),
    ...(typeof value.maxOutputTokens === 'number' ? { maxOutputTokens: value.maxOutputTokens } : {}),
    ...(responseFormat !== undefined ? { responseFormat } : {}), ...(tools ? { tools } : {}),
    ...((typeof value.keepAlive === 'string' || typeof value.keepAlive === 'number') ? { keepAlive: value.keepAlive } : {}),
    ...(reasoning ? { reasoning } : {}), ...(typeof value.logprobs === 'boolean' ? { logprobs: value.logprobs } : {}),
    ...(typeof value.topLogprobs === 'number' ? { topLogprobs: value.topLogprobs } : {}),
    ...(providerOptions ? { providerOptions } : {}), ...(metadata ? { metadata } : {}),
    ...(isAbortSignal(value.signal) ? { signal: value.signal } : {})
  }));
}

export function createModelRequest(value: ModelRequest): ModelRequest {
  if (OWNED_REQUESTS.has(value)) return value;
  const issues: string[] = [];
  nonempty(value.model, 'model', issues);
  if (value.messages.length === 0) issues.push('messages must be a non-empty array.');
  if (value.temperature !== undefined && !finiteInRange(value.temperature, 0, 2)) issues.push('temperature must be finite and between 0 and 2.');
  if (value.topP !== undefined && !finiteInRange(value.topP, 0, 1)) issues.push('topP must be finite and between 0 and 1.');
  if (value.maxOutputTokens !== undefined && !positiveInteger(value.maxOutputTokens)) issues.push('maxOutputTokens must be a positive integer.');
  if (value.topLogprobs !== undefined && value.logprobs !== true) issues.push('topLogprobs requires logprobs=true.');
  if (issues.length > 0) throw contract('Invalid model request.', issues);
  return own(OWNED_REQUESTS, Object.freeze({
    ...value,
    messages: Object.freeze(value.messages.map(snapshotMessage)),
    ...(value.responseFormat && typeof value.responseFormat === 'object' ? { responseFormat: Object.freeze({ type: 'json_schema' as const, schema: parseJsonObject(value.responseFormat.schema, MODEL_JSON_LIMITS) }) } : {}),
    ...(value.tools ? { tools: Object.freeze(value.tools.map(snapshotModelTool)) } : {}),
    ...(value.reasoning ? { reasoning: Object.freeze({ ...value.reasoning }) } : {}),
    ...(value.providerOptions ? { providerOptions: Object.freeze({ provider: value.providerOptions.provider, values: parseJsonObject(value.providerOptions.values, MODEL_JSON_LIMITS) }) } : {}),
    ...(value.metadata ? { metadata: Object.freeze({ ...value.metadata }) } : {})
  }));
}

function snapshotMessage(message: ModelMessage): ModelMessage {
  if (message.role === 'user') return Object.freeze({ ...message, ...(message.images ? { images: Object.freeze(message.images.map(snapshotImage)) } : {}) });
  if (message.role === 'assistant') return Object.freeze({ ...message, ...(message.toolCalls ? { toolCalls: Object.freeze(message.toolCalls.map(snapshotToolCall)) } : {}) });
  if (message.role === 'tool') return Object.freeze({ ...message, ...(message.images ? { images: Object.freeze(message.images.map(snapshotImage)) } : {}) });
  return Object.freeze({ ...message });
}
function snapshotImage(image: ModelImage): ModelImage {
  return image.type === 'bytes' ? Object.freeze({ ...image, data: new Uint8Array(image.data) }) : Object.freeze({ ...image });
}
function snapshotToolCall(call: ModelToolCall): ModelToolCall {
  return call.type === 'function'
    ? Object.freeze({ ...call, input: Object.freeze({ kind: 'json' as const, value: parseJsonObject(call.input.value, MODEL_JSON_LIMITS) }) })
    : Object.freeze({ ...call, input: Object.freeze({ ...call.input }) });
}
function snapshotModelTool(tool: ModelTool): ModelTool {
  return tool.type === 'function'
    ? Object.freeze({ type: 'function', function: Object.freeze({ ...tool.function, ...(tool.function.parameters ? { parameters: parseJsonObject(tool.function.parameters, MODEL_JSON_LIMITS) } : {}) }) })
    : Object.freeze({ ...tool, format: Object.freeze({ ...tool.format }) });
}

/** Enforces a discovered profile against an actual request at the provider boundary. */
export function assertModelRequestSupported(profile: ModelProfile, request: ModelRequest): void {
  const issues: string[] = [];
  if (request.model !== profile.id) issues.push(`request model ${request.model} does not match profile ${profile.id}.`);
  const declared = new Set<string>(profile.supportedParameters);
  const parameters: [keyof ModelRequest, string][] = [
    ['temperature', 'temperature'], ['topP', 'topP'], ['maxOutputTokens', 'maxOutputTokens'],
    ['responseFormat', 'responseFormat'], ['tools', 'tools'], ['keepAlive', 'keepAlive'],
    ['reasoning', 'reasoning'], ['logprobs', 'logprobs'], ['topLogprobs', 'topLogprobs'],
    ['metadata', 'metadata'], ['providerOptions', 'providerOptions']
  ];
  for (const [field, parameter] of parameters) if (request[field] !== undefined && !declared.has(parameter)) issues.push(`${field} is not declared by ${profile.id}.`);
  if (request.temperature !== undefined && !profile.capabilities.temperature) issues.push(`temperature is not supported by ${profile.id}.`);
  if (request.topP !== undefined && !profile.capabilities.topP) issues.push(`topP is not supported by ${profile.id}.`);
  if ((request.logprobs !== undefined || request.topLogprobs !== undefined) && !profile.capabilities.logprobs) issues.push(`log probabilities are not supported by ${profile.id}.`);
  if (request.responseFormat === 'json' && !profile.capabilities.jsonMode) issues.push(`JSON mode is not supported by ${profile.id}.`);
  if (typeof request.responseFormat === 'object' && !profile.capabilities.jsonSchema) issues.push(`JSON Schema output is not supported by ${profile.id}.`);
  if (request.messages.some((message) => (message.images?.length ?? 0) > 0) && !profile.modalities.input.includes('image')) issues.push(`image input is not supported by ${profile.id}.`);
  if ((request.tools?.length ?? 0) > 0) {
    if (!profile.capabilities.toolCalling) issues.push(`tool calling is not supported by ${profile.id}.`);
    const supportedInputs = profile.capabilities.supportedToolInputs;
    for (const tool of request.tools ?? []) {
      const supported = tool.type === 'function'
        ? supportedInputs.some((input) => input.kind === 'json')
        : tool.format.type === 'text'
          ? supportedInputs.some((input) => input.kind === 'text')
          : grammarInputSupported(supportedInputs, tool.format.syntax);
      if (!supported) {
        const format = tool.type === 'function' ? 'json' : tool.format.type === 'text' ? 'text' : `grammar:${tool.format.syntax}`;
        issues.push(`tool input format ${format} is not supported by ${profile.id}.`);
      }
    }
  }
  issues.push(...modelReasoningSupportIssues(profile, request.reasoning));
  if (request.maxOutputTokens !== undefined && profile.limits.outputTokens !== undefined && request.maxOutputTokens > profile.limits.outputTokens) issues.push(`maxOutputTokens exceeds ${profile.id}'s output limit.`);
  if (issues.length > 0) throw contract('Model request conflicts with its profile.', issues);
}

function grammarInputSupported(inputs: ModelProfile['capabilities']['supportedToolInputs'], syntax: string): boolean {
  return inputs.some((input) => input.kind === 'grammar' && input.syntax === syntax);
}

export function assertModelReasoningSupported(profile: ModelProfile, reasoning: ModelReasoningRequest | undefined): void {
  const issues = modelReasoningSupportIssues(profile, reasoning);
  if (issues.length > 0) throw contract('Model reasoning request conflicts with its profile.', issues);
}

function modelReasoningSupportIssues(profile: ModelProfile, reasoning: ModelReasoningRequest | undefined): string[] {
  if (!reasoning) return [];
  const capabilities = profile.capabilities.reasoning;
  if (!capabilities || !profile.supportedParameters.includes('reasoning')) return [`reasoning controls are not supported by ${profile.id}.`];
  if (reasoning.strategy === 'disabled') return capabilities.canDisable ? [] : [`reasoning cannot be disabled for ${profile.id}.`];
  const strategy = reasoning.strategy === 'enabled' ? 'toggle' : reasoning.strategy;
  const issues: string[] = [];
  if (!capabilities.strategies.includes(strategy)) issues.push(`reasoning strategy ${strategy} is not supported by ${profile.id}.`);
  if (reasoning.strategy === 'effort' && !capabilities.efforts?.includes(reasoning.effort)) issues.push(`reasoning effort ${reasoning.effort} is not supported by ${profile.id}.`);
  if (reasoning.strategy === 'effort' && reasoning.mode !== undefined && !capabilities.modes?.includes(reasoning.mode)) issues.push(`reasoning mode ${reasoning.mode} is not supported by ${profile.id}.`);
  if ('summary' in reasoning && !capabilities.summaries?.includes(reasoning.summary)) issues.push(`reasoning summary ${reasoning.summary} is not supported by ${profile.id}.`);
  return issues;
}

function decodeMessage(value: unknown, index: number): ModelMessage {
  const path = `messages[${String(index)}]`;
  if (!isRecord(value) || typeof value.content !== 'string' || (value.name !== undefined && typeof value.name !== 'string')) throw new Error(`${path} has invalid common fields.`);
  const common = { content: value.content, ...(typeof value.name === 'string' ? { name: value.name } : {}) };
  if (value.role === 'system') {
    if (!onlyKeys(value, ['role', 'content', 'name'])) throw new Error(`${path} contains fields that are illegal for a system message.`);
    return Object.freeze({ role: 'system', ...common });
  }
  if (value.role === 'user') {
    if (!onlyKeys(value, ['role', 'content', 'name', 'images'])) throw new Error(`${path} contains fields that are illegal for a user message.`);
    return Object.freeze({ role: 'user', ...common, ...(value.images === undefined ? {} : { images: decodeImages(value.images, path) }) });
  }
  if (value.role === 'assistant') {
    if (!onlyKeys(value, ['role', 'content', 'name', 'reasoning', 'toolCalls']) || (value.reasoning !== undefined && typeof value.reasoning !== 'string')) throw new Error(`${path} has invalid assistant fields.`);
    if (value.toolCalls !== undefined && !Array.isArray(value.toolCalls)) throw new Error(`${path}.toolCalls must be an array.`);
    const toolCalls = Array.isArray(value.toolCalls) ? Object.freeze(value.toolCalls.map(parseModelToolCall)) : undefined;
    return Object.freeze({ role: 'assistant', ...common, ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}), ...(toolCalls ? { toolCalls } : {}) });
  }
  if (value.role === 'tool') {
    if (value.toolCallType !== 'function' && value.toolCallType !== 'custom') throw new Error(`${path}.toolCallType is invalid.`);
    if (!onlyKeys(value, ['role', 'content', 'name', 'toolName', 'toolCallId', 'toolCallType', 'images']) || typeof value.toolName !== 'string' || value.toolName.trim().length === 0 || (value.toolCallId !== undefined && typeof value.toolCallId !== 'string')) throw new Error(`${path} has invalid tool fields.`);
    return Object.freeze({ role: 'tool', ...common, toolName: value.toolName, toolCallType: value.toolCallType, ...(typeof value.toolCallId === 'string' ? { toolCallId: value.toolCallId } : {}), ...(value.images === undefined ? {} : { images: decodeImages(value.images, path) }) });
  }
  throw new Error(`${path}.role is invalid.`);
}

function decodeImages(value: unknown, path: string): readonly import('./index.js').ModelImage[] {
  if (!Array.isArray(value)) throw new Error(`${path}.images is invalid.`);
  return Object.freeze(value.map((item) => {
    if (!isRecord(item) || (item.type !== 'base64' && item.type !== 'bytes') || typeof item.mediaType !== 'string' || !item.mediaType.startsWith('image/') || (item.detail !== undefined && item.detail !== 'auto' && item.detail !== 'low' && item.detail !== 'high' && item.detail !== 'original') || !onlyKeys(item, ['type', 'data', 'mediaType', 'detail'])) throw new Error(`${path}.images is invalid.`);
    if (item.type === 'base64') {
      if (typeof item.data !== 'string') throw new Error(`${path}.images is invalid.`);
      return Object.freeze({ type: 'base64' as const, data: item.data, mediaType: item.mediaType as `image/${string}`, ...(item.detail === undefined ? {} : { detail: item.detail }) });
    }
    if (!(item.data instanceof Uint8Array)) throw new Error(`${path}.images is invalid.`);
    return Object.freeze({ type: 'bytes' as const, data: new Uint8Array(item.data), mediaType: item.mediaType as `image/${string}`, ...(item.detail === undefined ? {} : { detail: item.detail }) });
  }));
}

function decodeModelResponseFormat(value: unknown): ModelResponseFormat {
  if (value === 'text' || value === 'json') return value;
  if (!isRecord(value) || value.type !== 'json_schema' || !onlyKeys(value, ['type', 'schema'])) throw new Error('responseFormat is invalid.');
  return Object.freeze({ type: 'json_schema', schema: parseJsonObject(value.schema, MODEL_JSON_LIMITS) });
}

export function decodeOwnedModelResponseFormat(value: JsonValue): ModelResponseFormat {
  if (value === 'text' || value === 'json') return value;
  if (!ownedJsonObject(value) || value.type !== 'json_schema' || !onlyKeys(value, ['type', 'schema'])) throw new Error('responseFormat is invalid.');
  const schema = value.schema;
  if (!ownedJsonObject(schema)) throw new Error('responseFormat is invalid.');
  return Object.freeze({ type: 'json_schema', schema });
}

function ownedJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeModelTool(value: unknown): ModelTool {
  if (!isRecord(value)) throw new Error('Tool must be an object.');
  if (value.type === 'function') {
    if (!onlyKeys(value, ['type', 'function']) || !isRecord(value.function) || !onlyKeys(value.function, ['name', 'description', 'parameters']) || typeof value.function.name !== 'string' || value.function.name.trim().length === 0 || (value.function.description !== undefined && typeof value.function.description !== 'string')) throw new Error('Function tool is invalid.');
    const parameters = value.function.parameters === undefined ? undefined : parseJsonObject(value.function.parameters, MODEL_JSON_LIMITS);
    return Object.freeze({ type: 'function', function: Object.freeze({ name: value.function.name, ...(typeof value.function.description === 'string' ? { description: value.function.description } : {}), ...(parameters ? { parameters } : {}) }) });
  }
  if (value.type !== 'custom' || !onlyKeys(value, ['type', 'name', 'description', 'format']) || typeof value.name !== 'string' || value.name.trim().length === 0 || (value.description !== undefined && typeof value.description !== 'string') || !isRecord(value.format)) throw new Error('Custom tool is invalid.');
  const format = value.format.type === 'text' && onlyKeys(value.format, ['type'])
    ? Object.freeze({ type: 'text' as const })
    : value.format.type === 'grammar' && typeof value.format.syntax === 'string' && value.format.syntax.length > 0 && typeof value.format.definition === 'string' && value.format.definition.length > 0 && onlyKeys(value.format, ['type', 'syntax', 'definition'])
      ? Object.freeze({ type: 'grammar' as const, syntax: value.format.syntax, definition: value.format.definition })
      : undefined;
  if (!format) throw new Error('Custom tool format is invalid.');
  return Object.freeze({ type: 'custom', name: value.name, ...(typeof value.description === 'string' ? { description: value.description } : {}), format });
}

export function parseModelReasoningRequest(value: unknown): ModelReasoningRequest {
  if (!validReasoningRequest(value)) throw contract('Invalid model reasoning request.', ['Expected a legal disabled, enabled, effort, or budget strategy.']);
  return Object.freeze({ ...value });
}

export function parseModelUsage(value: unknown): ModelUsage {
  if (!isRecord(value)) throw contract('Invalid model usage.', ['Expected an object.']);
  if (!nonnegativeFinite(value.promptTokens)) throw contract('Invalid model usage.', ['promptTokens must be finite and nonnegative.']);
  if (!nonnegativeFinite(value.completionTokens)) throw contract('Invalid model usage.', ['completionTokens must be finite and nonnegative.']);
  if (!nonnegativeFinite(value.totalTokens)) throw contract('Invalid model usage.', ['totalTokens must be finite and nonnegative.']);
  for (const name of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (value[name] !== undefined && !nonnegativeFinite(value[name])) throw contract('Invalid model usage.', [`${name} must be finite and nonnegative when provided.`]);
  }
  if (value.totalTokens !== value.promptTokens + value.completionTokens) throw contract('Invalid model usage.', ['totalTokens must equal promptTokens + completionTokens.']);
  return Object.freeze({
    promptTokens: value.promptTokens,
    completionTokens: value.completionTokens,
    totalTokens: value.totalTokens,
    ...(typeof value.cacheReadTokens === 'number' ? { cacheReadTokens: value.cacheReadTokens } : {}),
    ...(typeof value.cacheWriteTokens === 'number' ? { cacheWriteTokens: value.cacheWriteTokens } : {}),
    ...(typeof value.reasoningTokens === 'number' ? { reasoningTokens: value.reasoningTokens } : {})
  });
}

export function parseModelTerminationReason(value: unknown): ModelTerminationReason {
  if (!isModelTerminationReason(value)) throw contract('Invalid model termination.', ['Unsupported termination reason.']);
  return value;
}

export function parseModelToolCall(value: unknown): ModelToolCall {
  if (!isRecord(value)) throw contract('Invalid model tool call.', ['Expected an object.']);
  const issues: string[] = [];
  let jsonInput: JsonObject | undefined;
  const name = typeof value.name === 'string' ? value.name : '';
  nonempty(name, 'name', issues);
  if (value.id !== undefined && typeof value.id !== 'string') issues.push('id must be a string.');
  if (value.type !== 'function' && value.type !== 'custom') issues.push('type must be function or custom.');
  if (!isRecord(value.input) || (value.input.kind !== 'json' && value.input.kind !== 'text')) issues.push('input is invalid.');
  else if (value.input.kind === 'text') {
    if (typeof value.input.value !== 'string') issues.push('input value is invalid.');
  } else {
    try { jsonInput = parseJsonObject(value.input.value, MODEL_JSON_LIMITS); }
    catch { issues.push('input value is invalid.'); }
  }
  if (value.type === 'function' && isRecord(value.input) && value.input.kind !== 'json') issues.push('function tool calls require JSON input.');
  if (value.type === 'custom' && isRecord(value.input) && value.input.kind !== 'text') issues.push('custom tool calls require text input.');
  if (issues.length > 0) throw contract('Invalid model tool call.', issues);
  const input = value.input as Record<string, unknown>;
  const identity = { ...(typeof value.id === 'string' ? { id: value.id } : {}), name };
  return value.type === 'function'
    ? Object.freeze({ ...identity, type: 'function', input: Object.freeze({ kind: 'json', value: jsonInput ?? {} }) })
    : Object.freeze({ ...identity, type: 'custom', input: Object.freeze({ kind: 'text', value: input.value as string }) });
}

export function parseModelProviderState(value: unknown): ModelProviderState {
  if (ownedBy(OWNED_PROVIDER_STATES, value)) return value;
  if (!isRecord(value) || typeof value.provider !== 'string' || value.provider.length === 0 || typeof value.model !== 'string' || value.model.length === 0 || typeof value.kind !== 'string' || value.kind.length === 0) {
    throw contract('Invalid provider continuation state.', ['State identity and data must be JSON-safe.']);
  }
  let data: JsonObject;
  try { data = parseJsonObject(value.data, MODEL_JSON_LIMITS); }
  catch { throw contract('Invalid provider continuation state.', ['State identity and data must be JSON-safe.']); }
  return own(OWNED_PROVIDER_STATES, Object.freeze({ provider: value.provider, model: value.model, kind: value.kind, data }));
}

export function parseModelResponse(value: unknown): ModelResponse {
  if (ownedBy(OWNED_RESPONSES, value)) return value;
  if (!isRecord(value)) throw contract('Invalid model response.', ['Expected an object.']);
  const issues: string[] = [];
  let terminationReason: ModelTerminationReason = 'unknown';
  let usage: ModelUsage | undefined;
  let toolCalls: ModelToolCall[] | undefined;
  let providerState: ModelProviderState | undefined;
  let transport: ModelTransportMetadata | undefined;
  let timings: Record<string, number> | undefined;
  const content = typeof value.content === 'string' ? value.content : '';
  const model = typeof value.model === 'string' ? value.model : '';
  const provider = typeof value.provider === 'string' ? value.provider : '';
  if (typeof value.content !== 'string') issues.push('content must be a string.');
  nonempty(model, 'model', issues); nonempty(provider, 'provider', issues);
  try { terminationReason = parseModelTerminationReason(value.terminationReason); } catch (error) { issues.push(errorMessage(error)); }
  if (value.usage !== undefined) try { usage = parseModelUsage(value.usage); } catch (error) { issues.push(errorMessage(error)); }
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls)) issues.push('toolCalls must be an array.');
    else {
      toolCalls = [];
      for (const call of value.toolCalls) try { toolCalls.push(parseModelToolCall(call)); } catch (error) { issues.push(errorMessage(error)); }
    }
  }
  if (value.providerState !== undefined) try { providerState = parseModelProviderState(value.providerState); } catch (error) { issues.push(errorMessage(error)); }
  if (isRecord(value.providerState) && typeof value.provider === 'string' && value.providerState.provider !== value.provider) issues.push('providerState.provider must match response.provider.');
  if (value.requestId !== undefined) nonempty(value.requestId, 'requestId', issues);
  if (value.providerTerminationReason !== undefined) nonempty(value.providerTerminationReason, 'providerTerminationReason', issues);
  if (value.transport !== undefined) try { transport = decodeOwnedModelTransport(value.transport, value.provider); } catch (error) { issues.push(errorMessage(error)); }
  if (value.reasoning !== undefined && typeof value.reasoning !== 'string') issues.push('reasoning must be a string.');
  if (value.reasoningSummary !== undefined && typeof value.reasoningSummary !== 'string') issues.push('reasoningSummary must be a string.');
  if (value.timings !== undefined) try { timings = parseFiniteNumberRecord(value.timings); } catch { issues.push('timings must contain finite nonnegative numbers.'); }
  if (issues.length > 0) throw contract('Invalid model response.', issues);
  const response: ModelResponse = {
    content,
    model,
    provider,
    terminationReason,
    ...(providerState ? { providerState } : {}),
    ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
    ...(transport ? { transport } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}),
    ...(typeof value.reasoningSummary === 'string' ? { reasoningSummary: value.reasoningSummary } : {}),
    ...(toolCalls ? { toolCalls: Object.freeze(toolCalls) } : {}),
    ...(typeof value.providerTerminationReason === 'string' ? { providerTerminationReason: value.providerTerminationReason } : {}),
    ...(timings ? { timings } : {}),
    ...(Object.hasOwn(value, 'logprobs') ? { logprobs: ownedOpaque(value.logprobs) } : {}),
    ...(Object.hasOwn(value, 'raw') ? { raw: ownedOpaque(value.raw) } : {})
  };
  return own(OWNED_RESPONSES, Object.freeze(response));
}

export function parseModelStreamEvent(value: unknown): ModelStreamEvent {
  if (ownedBy(OWNED_STREAM_EVENTS, value)) return value;
  if (!isRecord(value) || typeof value.type !== 'string') throw contract('Invalid model stream event.', ['Expected a discriminated object.']);
  if (value.type === 'content' && typeof value.content === 'string' && value.content.length > 0 && typeof value.accumulated === 'string' && value.accumulated.endsWith(value.content) && onlyKeys(value, ['type', 'content', 'accumulated', 'raw'])) {
    return own(OWNED_STREAM_EVENTS, Object.freeze({ type: 'content', content: value.content, accumulated: value.accumulated, ...optionalRaw(value) }));
  }
  if (value.type === 'reasoning' && typeof value.reasoning === 'string' && value.reasoning.length > 0 && typeof value.accumulatedReasoning === 'string' && value.accumulatedReasoning.endsWith(value.reasoning) && (value.channel === undefined || value.channel === 'reasoning' || value.channel === 'summary') && onlyKeys(value, ['type', 'reasoning', 'accumulatedReasoning', 'channel', 'raw'])) {
    if (value.channel === 'reasoning') {
      const event: ModelStreamEvent = { type: 'reasoning', reasoning: value.reasoning, accumulatedReasoning: value.accumulatedReasoning, channel: 'reasoning', ...optionalRaw(value) };
      return own(OWNED_STREAM_EVENTS, Object.freeze(event));
    }
    if (value.channel === 'summary') {
      const event: ModelStreamEvent = { type: 'reasoning', reasoning: value.reasoning, accumulatedReasoning: value.accumulatedReasoning, channel: 'summary', ...optionalRaw(value) };
      return own(OWNED_STREAM_EVENTS, Object.freeze(event));
    }
    const event: ModelStreamEvent = { type: 'reasoning', reasoning: value.reasoning, accumulatedReasoning: value.accumulatedReasoning, ...optionalRaw(value) };
    return own(OWNED_STREAM_EVENTS, Object.freeze(event));
  }
  if (value.type === 'tool_call' && onlyKeys(value, ['type', 'toolCall', 'raw'])) return own(OWNED_STREAM_EVENTS, Object.freeze({ type: 'tool_call', toolCall: parseModelToolCall(value.toolCall), ...optionalRaw(value) }));
  if (value.type === 'status' && typeof value.message === 'string' && value.message.trim().length > 0 && onlyKeys(value, ['type', 'message', 'raw'])) return own(OWNED_STREAM_EVENTS, Object.freeze({ type: 'status', message: value.message, ...optionalRaw(value) }));
  if (value.type === 'done' && onlyKeys(value, ['type', 'response'])) return own(OWNED_STREAM_EVENTS, Object.freeze({ type: 'done', response: parseModelResponse(value.response) }));
  throw contract('Invalid model stream event.', [`Malformed ${value.type} event.`]);
}

function own<T extends object>(owners: WeakSet<T>, value: T): T { owners.add(value); return value; }
function ownedBy<T extends object>(owners: WeakSet<T>, value: unknown): value is T { return typeof value === 'object' && value !== null && owners.has(value as T); }

export function decodeOwnedModelCapabilities(value: unknown): ModelCapabilities {
  if (!isRecord(value)) throw new Error('capabilities must be an object.');
  for (const name of ['streaming', 'toolCalling', 'jsonMode', 'jsonSchema', 'logprobs', 'temperature', 'topP']) if (typeof value[name] !== 'boolean') throw new Error(`capabilities.${name} must be boolean.`);
  if (!Array.isArray(value.supportedToolInputs) || !value.supportedToolInputs.every(isModelToolInputSupport)) throw new Error('capabilities.supportedToolInputs is invalid.');
  const reasoning = value.reasoning === undefined ? undefined : decodeOwnedModelReasoningCapabilities(value.reasoning);
  return Object.freeze({
    streaming: value.streaming as boolean, toolCalling: value.toolCalling as boolean,
    supportedToolInputs: Object.freeze(value.supportedToolInputs.map((input) => Object.freeze({ ...input }))),
    jsonMode: value.jsonMode as boolean, jsonSchema: value.jsonSchema as boolean, logprobs: value.logprobs as boolean,
    temperature: value.temperature as boolean, topP: value.topP as boolean, ...(reasoning ? { reasoning } : {})
  });
}
export function decodeOwnedModelReasoningCapabilities(value: unknown): NonNullable<ModelCapabilities['reasoning']> {
  if (!isRecord(value) || !Array.isArray(value.strategies) || !value.strategies.every((item) => item === 'toggle' || item === 'effort' || item === 'budget') || new Set(value.strategies).size !== value.strategies.length || typeof value.canDisable !== 'boolean' || typeof value.separateOutput !== 'boolean') throw new Error('capabilities.reasoning is invalid.');
  if (value.efforts !== undefined && (!Array.isArray(value.efforts) || !value.efforts.every(isReasoningEffort))) throw new Error('capabilities.reasoning is invalid.');
  if (value.strategies.includes('effort') !== (Array.isArray(value.efforts) && value.efforts.length > 0)) throw new Error('capabilities.reasoning is invalid.');
  if (value.modes !== undefined && (!stringArray(value.modes) || !value.modes.every((item) => item === 'standard' || item === 'pro') || !value.strategies.includes('effort'))) throw new Error('capabilities.reasoning is invalid.');
  if (value.summaries !== undefined && (!stringArray(value.summaries) || !value.summaries.every((item) => item === 'auto' || item === 'concise' || item === 'detailed'))) throw new Error('capabilities.reasoning is invalid.');
  const strategies = Object.freeze(value.strategies.filter(isReasoningStrategy));
  const efforts = Array.isArray(value.efforts) ? Object.freeze(value.efforts.filter(isReasoningEffort)) : undefined;
  const modes = Array.isArray(value.modes) ? Object.freeze(value.modes.filter(isReasoningMode)) : undefined;
  const summaries = Array.isArray(value.summaries) ? Object.freeze(value.summaries.filter(isReasoningSummary)) : undefined;
  return Object.freeze({ strategies, canDisable: value.canDisable, separateOutput: value.separateOutput, ...(efforts ? { efforts } : {}), ...(modes ? { modes } : {}), ...(summaries ? { summaries } : {}) });
}
function isReasoningStrategy(value: unknown): value is 'toggle' | 'effort' | 'budget' { return value === 'toggle' || value === 'effort' || value === 'budget'; }
function isReasoningEffort(value: unknown): value is ModelReasoningEffort { return typeof value === 'string' && REASONING_EFFORTS.has(value); }
function isReasoningMode(value: unknown): value is 'standard' | 'pro' { return value === 'standard' || value === 'pro'; }
function isReasoningSummary(value: unknown): value is 'auto' | 'concise' | 'detailed' { return value === 'auto' || value === 'concise' || value === 'detailed'; }
export function decodeOwnedModelModalities(value: unknown): ModelModalities {
  if (!isRecord(value) || !stringArray(value.input) || !stringArray(value.output)) throw new Error('modalities is invalid.');
  return Object.freeze({ input: Object.freeze([...value.input]), output: Object.freeze([...value.output]) });
}
export function decodeOwnedModelLimits(value: unknown): ModelLimits {
  if (!isRecord(value)) throw new Error('limits must be an object.');
  for (const name of ['contextTokens', 'maxInputTokens', 'outputTokens']) if (value[name] !== undefined && !positiveInteger(value[name])) throw new Error(`limits.${name} must be a positive integer.`);
  const contextTokens = positiveInteger(value.contextTokens) ? value.contextTokens : undefined;
  const maxInputTokens = positiveInteger(value.maxInputTokens) ? value.maxInputTokens : undefined;
  const outputTokens = positiveInteger(value.outputTokens) ? value.outputTokens : undefined;
  if (contextTokens !== undefined && maxInputTokens !== undefined && maxInputTokens > contextTokens) throw new Error('limits.maxInputTokens cannot exceed contextTokens.');
  if (contextTokens !== undefined && outputTokens !== undefined && outputTokens > contextTokens) throw new Error('limits.outputTokens cannot exceed contextTokens.');
  if (contextTokens !== undefined && maxInputTokens !== undefined && outputTokens !== undefined && maxInputTokens + outputTokens > contextTokens) throw new Error('limits.maxInputTokens + outputTokens cannot exceed contextTokens.');
  return Object.freeze({ ...(contextTokens === undefined ? {} : { contextTokens }), ...(maxInputTokens === undefined ? {} : { maxInputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) });
}
function decodePricing(value: unknown): ModelPricing {
  if (!isRecord(value) || typeof value.currency !== 'string' || value.currency.length === 0 || !isRecord(value.rates)) throw new Error('pricing must contain finite nonnegative numeric rates.');
  const rates: Record<string, number> = {};
  for (const name of ['input', 'output', 'cacheRead', 'cacheWrite']) { const rate = value.rates[name]; if (rate !== undefined) { if (!nonnegativeFinite(rate)) throw new Error('pricing must contain finite nonnegative numeric rates.'); rates[name] = rate; } }
  let inputTiers: readonly import('./index.js').ModelPricingTier[] | undefined;
  if (value.inputTiers !== undefined) {
    if (!Array.isArray(value.inputTiers)) throw new Error('pricing input tiers are invalid.');
    inputTiers = Object.freeze(value.inputTiers.map((tier) => { if (!isRecord(tier) || !nonnegativeInteger(tier.aboveInputTokens) || !positiveFinite(tier.inputMultiplier) || !positiveFinite(tier.outputMultiplier)) throw new Error('pricing input tiers are invalid.'); return Object.freeze({ aboveInputTokens: tier.aboveInputTokens, inputMultiplier: tier.inputMultiplier, outputMultiplier: tier.outputMultiplier }); }));
  }
  const metadata = value.metadata === undefined ? undefined : parseJsonObject(value.metadata, MODEL_JSON_LIMITS);
  return Object.freeze({ currency: value.currency, rates: Object.freeze(rates), ...(inputTiers ? { inputTiers } : {}), ...(metadata ? { metadata } : {}) });
}

export function decodeOwnedModelTransport(value: unknown, provider?: unknown): ModelTransportMetadata {
  if (!isRecord(value) || !onlyKeys(value, ['provider', 'strategy', 'responseId', 'reusedContinuation', 'fallbackReason'])) throw new Error('transport must be a valid transport metadata object.');
  if (typeof value.provider !== 'string' || value.provider.trim().length === 0) throw new Error('transport.provider must be a non-empty string.');
  if (typeof value.strategy !== 'string' || value.strategy.trim().length === 0) throw new Error('transport.strategy must be a non-empty string.');
  if (typeof provider === 'string' && value.provider !== provider) throw new Error('transport.provider must match response.provider.');
  if (value.responseId !== undefined && (typeof value.responseId !== 'string' || value.responseId.trim().length === 0)) throw new Error('transport.responseId must be a non-empty string.');
  if (value.reusedContinuation !== undefined && typeof value.reusedContinuation !== 'boolean') throw new Error('transport.reusedContinuation must be boolean.');
  if (value.fallbackReason !== undefined && (typeof value.fallbackReason !== 'string' || value.fallbackReason.trim().length === 0)) throw new Error('transport.fallbackReason must be a non-empty string.');
  return Object.freeze({
    provider: value.provider,
    strategy: value.strategy,
    ...(typeof value.responseId === 'string' ? { responseId: value.responseId } : {}),
    ...(typeof value.reusedContinuation === 'boolean' ? { reusedContinuation: value.reusedContinuation } : {}),
    ...(typeof value.fallbackReason === 'string' ? { fallbackReason: value.fallbackReason } : {})
  });
}
function parseFiniteNumberRecord(value: unknown): Record<string, number> {
  const parsed = parseJsonObject(value, MODEL_JSON_LIMITS);
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (!nonnegativeFinite(item)) throw new Error('Expected finite nonnegative numbers.');
    output[key] = item;
  }
  return Object.freeze(output);
}
function ownedOpaque(value: unknown): JsonValue {
  return normalizeJsonSafe(value, { maxDepth: 32, maxCollectionEntries: 20_000, maxStringBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }).value;
}
function validReasoningRequest(value: unknown): value is ModelReasoningRequest {
  if (!isRecord(value)) return false;
  if (value.strategy === 'disabled') return Object.keys(value).length === 1;
  if (value.strategy === 'enabled') return validSummary(value.summary) && onlyKeys(value, ['strategy', 'summary']);
  if (value.strategy === 'effort') return typeof value.effort === 'string' && value.effort !== 'none' && REASONING_EFFORTS.has(value.effort) && (value.mode === undefined || value.mode === 'standard' || value.mode === 'pro') && validSummary(value.summary) && onlyKeys(value, ['strategy', 'effort', 'mode', 'summary']);
  if (value.strategy === 'budget') return positiveInteger(value.maxTokens) && validSummary(value.summary) && onlyKeys(value, ['strategy', 'maxTokens', 'summary']);
  return false;
}
function decodeProviderOptions(value: unknown): ModelProviderOptions {
  if (!isRecord(value) || typeof value.provider !== 'string' || value.provider.trim().length === 0 || !onlyKeys(value, ['provider', 'values'])) throw new Error('providerOptions is invalid.');
  return Object.freeze({ provider: value.provider, values: parseJsonObject(value.values, MODEL_JSON_LIMITS) });
}
function validSummary(value: unknown): boolean { return value === undefined || value === 'auto' || value === 'concise' || value === 'detailed'; }
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)); }
function isAbortSignal(value: unknown): value is AbortSignal { return isRecord(value) && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function'; }
function decodeStringMetadata(value: unknown): Readonly<Record<string, string>> {
  const parsed = parseJsonObject(value, MODEL_JSON_LIMITS);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string') throw new Error('metadata must contain string values.');
    output[key] = item;
  }
  return Object.freeze(output);
}
function isModelTerminationReason(value: unknown): value is ModelTerminationReason {
  return value === 'stop' || value === 'tool_calls' || value === 'output_limit' || value === 'content_filter' || value === 'unknown';
}
function isModelToolInputSupport(value: unknown): value is ModelProfile['capabilities']['supportedToolInputs'][number] {
  if (!isRecord(value)) return false;
  if (value.kind === 'json' || value.kind === 'text') return onlyKeys(value, ['kind']);
  return value.kind === 'grammar' && typeof value.syntax === 'string' && value.syntax.length > 0 && onlyKeys(value, ['kind', 'syntax']);
}
function optionalRaw(value: Record<string, unknown>): { raw?: JsonValue } { return Object.hasOwn(value, 'raw') ? { raw: ownedOpaque(value.raw) } : {}; }
function finiteInRange(value: unknown, minimum: number, maximum: number): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum; }
function nonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function positiveFinite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_PARAMETERS = new Set(['temperature', 'topP', 'maxOutputTokens', 'responseFormat', 'tools', 'keepAlive', 'reasoning', 'logprobs', 'topLogprobs', 'metadata', 'providerOptions']);
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function nonnegativeFinite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function nonempty(value: unknown, name: string, issues: string[]): void { if (typeof value !== 'string' || value.trim().length === 0) issues.push(`${name} must be a non-empty string.`); }
function contract(message: string, issues: string[]): ModelContractError { return new ModelContractError(message, issues); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
