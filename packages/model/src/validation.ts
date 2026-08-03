import type {
  ModelProfile,
  ModelReasoningRequest,
  ModelRequest,
  ModelProviderState,
  ModelResponse,
  ModelStreamEvent,
  ModelTerminationReason,
  ModelToolCall,
  ModelUsage
} from './index.js';

export class ModelContractError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super(`${message} ${issues.join(' ')}`.trim());
    this.name = 'ModelContractError';
    this.issues = Object.freeze([...issues]);
  }
}

export function parseModelProfile(value: unknown): ModelProfile {
  if (!isRecord(value)) throw contract('Invalid model profile.', ['Expected an object.']);
  const issues: string[] = [];
  nonempty(value.id, 'id', issues); nonempty(value.provider, 'provider', issues);
  if (value.displayName !== undefined && typeof value.displayName !== 'string') issues.push('displayName must be a string.');
  if (!isRecord(value.capabilities)) issues.push('capabilities must be an object.');
  else {
    for (const name of ['streaming', 'toolCalling', 'jsonMode', 'jsonSchema', 'logprobs', 'temperature', 'topP']) if (typeof value.capabilities[name] !== 'boolean') issues.push(`capabilities.${name} must be boolean.`);
    if (!Array.isArray(value.capabilities.supportedToolInputs) || !value.capabilities.supportedToolInputs.every(isModelToolInputSupport)) issues.push('capabilities.supportedToolInputs is invalid.');
    if (value.capabilities.reasoning !== undefined && !validReasoningCapabilities(value.capabilities.reasoning)) issues.push('capabilities.reasoning is invalid.');
  }
  if (!isRecord(value.modalities) || !stringArray(value.modalities.input) || !stringArray(value.modalities.output)) issues.push('modalities is invalid.');
  if (!isRecord(value.limits)) issues.push('limits must be an object.');
  else {
    for (const name of ['contextTokens', 'maxInputTokens', 'outputTokens']) if (value.limits[name] !== undefined && !positiveInteger(value.limits[name])) issues.push(`limits.${name} must be a positive integer.`);
    const context = positiveInteger(value.limits.contextTokens) ? value.limits.contextTokens : undefined;
    const input = positiveInteger(value.limits.maxInputTokens) ? value.limits.maxInputTokens : undefined;
    const output = positiveInteger(value.limits.outputTokens) ? value.limits.outputTokens : undefined;
    if (context !== undefined && input !== undefined && input > context) issues.push('limits.maxInputTokens cannot exceed contextTokens.');
    if (context !== undefined && output !== undefined && output > context) issues.push('limits.outputTokens cannot exceed contextTokens.');
    if (context !== undefined && input !== undefined && output !== undefined && input + output > context) issues.push('limits.maxInputTokens + outputTokens cannot exceed contextTokens.');
  }
  if (!stringArray(value.supportedParameters) || !value.supportedParameters.every((item) => MODEL_PARAMETERS.has(item))) issues.push('supportedParameters contains an unsupported canonical parameter.');
  else if (new Set(value.supportedParameters).size !== value.supportedParameters.length) issues.push('supportedParameters must not contain duplicates.');
  if (value.pricing !== undefined && !validPricing(value.pricing)) issues.push('pricing must contain finite nonnegative numeric rates.');
  if (value.metadata !== undefined && !isJsonObject(value.metadata)) issues.push('metadata must be a bounded JSON-safe object.');
  if (issues.length > 0) throw contract('Invalid model profile.', issues);
  if (!isModelProfile(value)) throw contract('Invalid model profile.', ['Validated fields did not form a model profile.']);
  return Object.freeze(value);
}

export function parseModelRequest(value: unknown): ModelRequest {
  if (!isRecord(value)) throw contract('Invalid model request.', ['Expected an object.']);
  const issues: string[] = [];
  if (!onlyKeys(value, ['model', 'messages', 'temperature', 'topP', 'maxOutputTokens', 'responseFormat', 'tools', 'keepAlive', 'reasoning', 'logprobs', 'topLogprobs', 'providerOptions', 'metadata', 'signal'])) issues.push('request contains unsupported fields.');
  nonempty(value.model, 'model', issues);
  if (!Array.isArray(value.messages) || value.messages.length === 0) issues.push('messages must be a non-empty array.');
  else value.messages.forEach((message, index) => { validateMessage(message, index, issues); });
  if (value.temperature !== undefined && !finiteInRange(value.temperature, 0, 2)) issues.push('temperature must be finite and between 0 and 2.');
  if (value.topP !== undefined && !finiteInRange(value.topP, 0, 1)) issues.push('topP must be finite and between 0 and 1.');
  if (value.maxOutputTokens !== undefined && !positiveInteger(value.maxOutputTokens)) issues.push('maxOutputTokens must be a positive integer.');
  if (value.responseFormat !== undefined && !validResponseFormat(value.responseFormat)) issues.push('responseFormat is invalid or not JSON-safe.');
  if (value.tools !== undefined && (!Array.isArray(value.tools) || !value.tools.every(validModelTool))) issues.push('tools contains an invalid definition.');
  if (value.keepAlive !== undefined && !(typeof value.keepAlive === 'string' || nonnegativeFinite(value.keepAlive))) issues.push('keepAlive must be a string or finite nonnegative number.');
  if (value.logprobs !== undefined && typeof value.logprobs !== 'boolean') issues.push('logprobs must be a boolean.');
  if (value.topLogprobs !== undefined && !nonnegativeInteger(value.topLogprobs)) issues.push('topLogprobs must be a nonnegative integer.');
  if (value.topLogprobs !== undefined && value.logprobs !== true) issues.push('topLogprobs requires logprobs=true.');
  if (value.reasoning !== undefined && !validReasoningRequest(value.reasoning)) issues.push('reasoning must be a valid discriminated strategy.');
  if (value.providerOptions !== undefined && !validProviderOptions(value.providerOptions)) issues.push('providerOptions must be namespaced to a provider and contain JSON-safe values.');
  if (value.metadata !== undefined && (!isRecord(value.metadata) || !Object.values(value.metadata).every((item) => typeof item === 'string'))) issues.push('metadata must contain string values.');
  if (value.signal !== undefined && !isAbortSignal(value.signal)) issues.push('signal must be an AbortSignal.');
  if (issues.length > 0) throw contract('Invalid model request.', issues);
  if (!isModelRequest(value)) throw contract('Invalid model request.', ['Validated fields did not form a model request.']);
  return Object.freeze(value);
}

/** Enforces a discovered profile against an actual request at the provider boundary. */
export function assertModelRequestSupported(profileValue: unknown, requestValue: unknown): void {
  const profile = parseModelProfile(profileValue);
  const request = parseModelRequest(requestValue);
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
  if (request.messages.some((message) => message.role === 'user' && (message.images?.length ?? 0) > 0) && !profile.modalities.input.includes('image')) issues.push(`image input is not supported by ${profile.id}.`);
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

export function assertModelReasoningSupported(profileValue: unknown, reasoning: ModelReasoningRequest | undefined): void {
  const profile = parseModelProfile(profileValue);
  if (reasoning !== undefined) parseModelReasoningRequest(reasoning);
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

function validateMessage(value: unknown, index: number, issues: string[]): void {
  const path = `messages[${String(index)}]`;
  if (!isRecord(value)) { issues.push(`${path} must be an object.`); return; }
  if (typeof value.content !== 'string') issues.push(`${path}.content must be a string.`);
  if (value.name !== undefined && typeof value.name !== 'string') issues.push(`${path}.name must be a string.`);
  if (value.role === 'system') {
    if (!onlyKeys(value, ['role', 'content', 'name'])) issues.push(`${path} contains fields that are illegal for a system message.`);
    return;
  }
  if (value.role === 'user') {
    if (!onlyKeys(value, ['role', 'content', 'name', 'images'])) issues.push(`${path} contains fields that are illegal for a user message.`);
    if (value.images !== undefined && (!Array.isArray(value.images) || !value.images.every(validImage))) issues.push(`${path}.images is invalid.`);
    return;
  }
  if (value.role === 'assistant') {
    if (!onlyKeys(value, ['role', 'content', 'name', 'reasoning', 'toolCalls'])) issues.push(`${path} contains fields that are illegal for an assistant message.`);
    if (value.reasoning !== undefined && typeof value.reasoning !== 'string') issues.push(`${path}.reasoning must be a string.`);
    if (value.toolCalls !== undefined) {
      if (!Array.isArray(value.toolCalls)) issues.push(`${path}.toolCalls must be an array.`);
      else for (const call of value.toolCalls) try { parseModelToolCall(call); } catch (error) { issues.push(`${path}.${errorMessage(error)}`); }
    }
    return;
  }
  if (value.role === 'tool') {
    if (!onlyKeys(value, ['role', 'content', 'name', 'toolName', 'toolCallId', 'toolCallType'])) issues.push(`${path} contains fields that are illegal for a tool message.`);
    nonempty(value.toolName, `${path}.toolName`, issues);
    if (value.toolCallId !== undefined && typeof value.toolCallId !== 'string') issues.push(`${path}.toolCallId must be a string.`);
    if (value.toolCallType !== 'function' && value.toolCallType !== 'custom') issues.push(`${path}.toolCallType must be function or custom.`);
    return;
  }
  issues.push(`${path}.role is invalid.`);
}

function validImage(value: unknown): boolean {
  if (!isRecord(value) || (value.type !== 'base64' && value.type !== 'bytes') || typeof value.mediaType !== 'string' || !value.mediaType.startsWith('image/') || (value.detail !== undefined && value.detail !== 'auto' && value.detail !== 'low' && value.detail !== 'high' && value.detail !== 'original')) return false;
  if (!onlyKeys(value, ['type', 'data', 'mediaType', 'detail'])) return false;
  return value.type === 'base64' ? typeof value.data === 'string' : value.data instanceof Uint8Array;
}

function validResponseFormat(value: unknown): boolean {
  if (value === 'text' || value === 'json') return true;
  return isRecord(value) && value.type === 'json_schema' && isJsonObject(value.schema) && onlyKeys(value, ['type', 'schema']);
}

function validModelTool(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'function') {
    if (!onlyKeys(value, ['type', 'function']) || !isRecord(value.function) || !onlyKeys(value.function, ['name', 'description', 'parameters'])) return false;
    return typeof value.function.name === 'string' && value.function.name.trim().length > 0
      && (value.function.description === undefined || typeof value.function.description === 'string')
      && (value.function.parameters === undefined || isJsonObject(value.function.parameters));
  }
  if (value.type !== 'custom' || !onlyKeys(value, ['type', 'name', 'description', 'format']) || typeof value.name !== 'string' || value.name.trim().length === 0 || (value.description !== undefined && typeof value.description !== 'string') || !isRecord(value.format)) return false;
  if (value.format.type === 'text') return onlyKeys(value.format, ['type']);
  return value.format.type === 'grammar' && typeof value.format.syntax === 'string' && value.format.syntax.length > 0 && typeof value.format.definition === 'string' && value.format.definition.length > 0 && onlyKeys(value.format, ['type', 'syntax', 'definition']);
}

export function parseModelReasoningRequest(value: unknown): ModelReasoningRequest {
  if (!validReasoningRequest(value)) throw contract('Invalid model reasoning request.', ['Expected a legal disabled, enabled, effort, or budget strategy.']);
  return Object.freeze(value);
}

export function parseModelUsage(value: unknown): ModelUsage {
  if (!isRecord(value)) throw contract('Invalid model usage.', ['Expected an object.']);
  const issues = ['promptTokens', 'completionTokens', 'totalTokens'].filter((name) => !nonnegativeFinite(value[name])).map((name) => `${name} must be finite and nonnegative.`);
  for (const name of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) if (value[name] !== undefined && !nonnegativeFinite(value[name])) issues.push(`${name} must be finite and nonnegative when provided.`);
  if (nonnegativeFinite(value.totalTokens) && nonnegativeFinite(value.promptTokens) && nonnegativeFinite(value.completionTokens) && value.totalTokens !== value.promptTokens + value.completionTokens) issues.push('totalTokens must equal promptTokens + completionTokens.');
  if (issues.length > 0) throw contract('Invalid model usage.', issues);
  if (!isModelUsage(value)) throw contract('Invalid model usage.', ['Validated fields did not form model usage.']);
  return Object.freeze(value);
}

export function parseModelTerminationReason(value: unknown): ModelTerminationReason {
  if (!isModelTerminationReason(value)) throw contract('Invalid model termination.', ['Unsupported termination reason.']);
  return value;
}

export function parseModelToolCall(value: unknown): ModelToolCall {
  if (!isRecord(value)) throw contract('Invalid model tool call.', ['Expected an object.']);
  const issues: string[] = [];
  nonempty(value.name, 'name', issues);
  if (value.id !== undefined && typeof value.id !== 'string') issues.push('id must be a string.');
  if (value.type !== 'function' && value.type !== 'custom') issues.push('type must be function or custom.');
  if (!isRecord(value.input) || (value.input.kind !== 'json' && value.input.kind !== 'text')) issues.push('input is invalid.');
  else if (value.input.kind === 'text' ? typeof value.input.value !== 'string' : !isJsonObject(value.input.value)) issues.push('input value is invalid.');
  if (value.type === 'function' && isRecord(value.input) && value.input.kind !== 'json') issues.push('function tool calls require JSON input.');
  if (value.type === 'custom' && isRecord(value.input) && value.input.kind !== 'text') issues.push('custom tool calls require text input.');
  if (issues.length > 0) throw contract('Invalid model tool call.', issues);
  if (!isModelToolCall(value)) throw contract('Invalid model tool call.', ['Validated fields did not form a model tool call.']);
  return Object.freeze(value);
}

export function parseModelProviderState(value: unknown): ModelProviderState {
  if (!isRecord(value) || typeof value.provider !== 'string' || value.provider.length === 0 || typeof value.model !== 'string' || value.model.length === 0 || typeof value.kind !== 'string' || value.kind.length === 0 || !isJsonObject(value.data)) {
    throw contract('Invalid provider continuation state.', ['State identity and data must be JSON-safe.']);
  }
  return Object.freeze({ provider: value.provider, model: value.model, kind: value.kind, data: value.data });
}

export function parseModelResponse(value: unknown): ModelResponse {
  if (!isRecord(value)) throw contract('Invalid model response.', ['Expected an object.']);
  const issues: string[] = [];
  if (typeof value.content !== 'string') issues.push('content must be a string.');
  nonempty(value.model, 'model', issues); nonempty(value.provider, 'provider', issues);
  try { parseModelTerminationReason(value.terminationReason); } catch (error) { issues.push(errorMessage(error)); }
  if (value.usage !== undefined) try { parseModelUsage(value.usage); } catch (error) { issues.push(errorMessage(error)); }
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls)) issues.push('toolCalls must be an array.');
    else for (const call of value.toolCalls) try { parseModelToolCall(call); } catch (error) { issues.push(errorMessage(error)); }
  }
  if (value.providerState !== undefined) try { parseModelProviderState(value.providerState); } catch (error) { issues.push(errorMessage(error)); }
  if (isRecord(value.providerState) && typeof value.provider === 'string' && value.providerState.provider !== value.provider) issues.push('providerState.provider must match response.provider.');
  if (value.requestId !== undefined) nonempty(value.requestId, 'requestId', issues);
  if (value.providerTerminationReason !== undefined) nonempty(value.providerTerminationReason, 'providerTerminationReason', issues);
  if (value.transport !== undefined) validateTransport(value.transport, value.provider, issues);
  if (value.reasoning !== undefined && typeof value.reasoning !== 'string') issues.push('reasoning must be a string.');
  if (value.reasoningSummary !== undefined && typeof value.reasoningSummary !== 'string') issues.push('reasoningSummary must be a string.');
  if (value.timings !== undefined && (!isRecord(value.timings) || !Object.values(value.timings).every(nonnegativeFinite))) issues.push('timings must contain finite nonnegative numbers.');
  if (issues.length > 0) throw contract('Invalid model response.', issues);
  if (!isModelResponse(value)) throw contract('Invalid model response.', ['Validated fields did not form a model response.']);
  return Object.freeze(value);
}

export function parseModelStreamEvent(value: unknown): ModelStreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') throw contract('Invalid model stream event.', ['Expected a discriminated object.']);
  if (value.type === 'content' && typeof value.content === 'string' && value.content.length > 0 && typeof value.accumulated === 'string' && value.accumulated.endsWith(value.content) && onlyKeys(value, ['type', 'content', 'accumulated', 'raw'])) {
    return Object.freeze({ type: 'content', content: value.content, accumulated: value.accumulated, ...optionalRaw(value) });
  }
  if (value.type === 'reasoning' && typeof value.reasoning === 'string' && value.reasoning.length > 0 && typeof value.accumulatedReasoning === 'string' && value.accumulatedReasoning.endsWith(value.reasoning) && (value.channel === undefined || value.channel === 'reasoning' || value.channel === 'summary') && onlyKeys(value, ['type', 'reasoning', 'accumulatedReasoning', 'channel', 'raw'])) {
    if (value.channel === 'reasoning') {
      const event: ModelStreamEvent = { type: 'reasoning', reasoning: value.reasoning, accumulatedReasoning: value.accumulatedReasoning, channel: 'reasoning', ...optionalRaw(value) };
      return Object.freeze(event);
    }
    if (value.channel === 'summary') {
      const event: ModelStreamEvent = { type: 'reasoning', reasoning: value.reasoning, accumulatedReasoning: value.accumulatedReasoning, channel: 'summary', ...optionalRaw(value) };
      return Object.freeze(event);
    }
    const event: ModelStreamEvent = { type: 'reasoning', reasoning: value.reasoning, accumulatedReasoning: value.accumulatedReasoning, ...optionalRaw(value) };
    return Object.freeze(event);
  }
  if (value.type === 'tool_call' && onlyKeys(value, ['type', 'toolCall', 'raw'])) return Object.freeze({ type: 'tool_call', toolCall: parseModelToolCall(value.toolCall), ...optionalRaw(value) });
  if (value.type === 'status' && typeof value.message === 'string' && value.message.trim().length > 0 && onlyKeys(value, ['type', 'message', 'raw'])) return Object.freeze({ type: 'status', message: value.message, ...optionalRaw(value) });
  if (value.type === 'done' && onlyKeys(value, ['type', 'response'])) return Object.freeze({ type: 'done', response: parseModelResponse(value.response) });
  throw contract('Invalid model stream event.', [`Malformed ${value.type} event.`]);
}

function validPricing(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.currency !== 'string' || value.currency.length === 0 || !isRecord(value.rates)) return false;
  const rates = value.rates;
  if (!['input', 'output', 'cacheRead', 'cacheWrite'].every((name) => rates[name] === undefined || nonnegativeFinite(rates[name]))) return false;
  if (value.inputTiers !== undefined && (!Array.isArray(value.inputTiers) || !value.inputTiers.every((tier) => isRecord(tier) && nonnegativeInteger(tier.aboveInputTokens) && positiveFinite(tier.inputMultiplier) && positiveFinite(tier.outputMultiplier)))) return false;
  if (value.metadata !== undefined && !isJsonObject(value.metadata)) return false;
  return true;
}
function validReasoningCapabilities(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.strategies) || !value.strategies.every((item) => item === 'toggle' || item === 'effort' || item === 'budget') || typeof value.canDisable !== 'boolean' || typeof value.separateOutput !== 'boolean') return false;
  if (new Set(value.strategies).size !== value.strategies.length) return false;
  if (value.efforts !== undefined && (!stringArray(value.efforts) || !value.efforts.every((item) => REASONING_EFFORTS.has(item)))) return false;
  if (value.strategies.includes('effort') !== (Array.isArray(value.efforts) && value.efforts.length > 0)) return false;
  if (value.modes !== undefined && (!stringArray(value.modes) || !value.modes.every((item) => item === 'standard' || item === 'pro'))) return false;
  if (value.modes !== undefined && !value.strategies.includes('effort')) return false;
  return value.summaries === undefined || (stringArray(value.summaries) && value.summaries.every((item) => item === 'auto' || item === 'concise' || item === 'detailed'));
}

function validateTransport(value: unknown, provider: unknown, issues: string[]): void {
  if (!isRecord(value) || !onlyKeys(value, ['provider', 'strategy', 'responseId', 'reusedContinuation', 'fallbackReason'])) {
    issues.push('transport must be a valid transport metadata object.');
    return;
  }
  nonempty(value.provider, 'transport.provider', issues);
  nonempty(value.strategy, 'transport.strategy', issues);
  if (typeof provider === 'string' && value.provider !== provider) issues.push('transport.provider must match response.provider.');
  if (value.responseId !== undefined) nonempty(value.responseId, 'transport.responseId', issues);
  if (value.reusedContinuation !== undefined && typeof value.reusedContinuation !== 'boolean') issues.push('transport.reusedContinuation must be boolean.');
  if (value.fallbackReason !== undefined) nonempty(value.fallbackReason, 'transport.fallbackReason', issues);
}
function validReasoningRequest(value: unknown): value is ModelReasoningRequest {
  if (!isRecord(value)) return false;
  if (value.strategy === 'disabled') return Object.keys(value).length === 1;
  if (value.strategy === 'enabled') return validSummary(value.summary) && onlyKeys(value, ['strategy', 'summary']);
  if (value.strategy === 'effort') return typeof value.effort === 'string' && value.effort !== 'none' && REASONING_EFFORTS.has(value.effort) && (value.mode === undefined || value.mode === 'standard' || value.mode === 'pro') && validSummary(value.summary) && onlyKeys(value, ['strategy', 'effort', 'mode', 'summary']);
  if (value.strategy === 'budget') return positiveInteger(value.maxTokens) && validSummary(value.summary) && onlyKeys(value, ['strategy', 'maxTokens', 'summary']);
  return false;
}
function validProviderOptions(value: unknown): boolean { return isRecord(value) && typeof value.provider === 'string' && value.provider.trim().length > 0 && isJsonObject(value.values) && onlyKeys(value, ['provider', 'values']); }
function validSummary(value: unknown): boolean { return value === undefined || value === 'auto' || value === 'concise' || value === 'detailed'; }
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)); }
function isAbortSignal(value: unknown): value is AbortSignal { return isRecord(value) && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function'; }
function isModelProfile(value: Record<string, unknown>): value is Record<string, unknown> & ModelProfile {
  if (typeof value.id !== 'string' || value.id.trim().length === 0 || typeof value.provider !== 'string' || value.provider.trim().length === 0
    || (value.displayName !== undefined && typeof value.displayName !== 'string')) return false;
  const capabilities = value.capabilities;
  if (!isRecord(capabilities)
    || !['streaming', 'toolCalling', 'jsonMode', 'jsonSchema', 'logprobs', 'temperature', 'topP'].every((name) => typeof capabilities[name] === 'boolean')
    || !Array.isArray(capabilities.supportedToolInputs) || !capabilities.supportedToolInputs.every(isModelToolInputSupport)
    || (capabilities.reasoning !== undefined && !validReasoningCapabilities(capabilities.reasoning))) return false;
  const modalities = value.modalities;
  if (!isRecord(modalities) || !stringArray(modalities.input) || !stringArray(modalities.output)) return false;
  const limits = value.limits;
  return isRecord(limits)
    && ['contextTokens', 'maxInputTokens', 'outputTokens'].every((name) => limits[name] === undefined || positiveInteger(limits[name]))
    && Array.isArray(value.supportedParameters) && value.supportedParameters.every(isModelParameter)
    && (value.pricing === undefined || validPricing(value.pricing))
    && (value.metadata === undefined || isJsonObject(value.metadata));
}
function isModelRequest(value: Record<string, unknown>): value is Record<string, unknown> & ModelRequest {
  return typeof value.model === 'string' && value.model.trim().length > 0
    && Array.isArray(value.messages) && value.messages.length > 0 && value.messages.every(isModelMessage)
    && (value.temperature === undefined || finiteInRange(value.temperature, 0, 2))
    && (value.topP === undefined || finiteInRange(value.topP, 0, 1))
    && (value.maxOutputTokens === undefined || positiveInteger(value.maxOutputTokens))
    && (value.responseFormat === undefined || validResponseFormat(value.responseFormat))
    && (value.tools === undefined || (Array.isArray(value.tools) && value.tools.every(validModelTool)))
    && (value.keepAlive === undefined || typeof value.keepAlive === 'string' || nonnegativeFinite(value.keepAlive))
    && (value.reasoning === undefined || validReasoningRequest(value.reasoning))
    && (value.logprobs === undefined || typeof value.logprobs === 'boolean')
    && (value.topLogprobs === undefined || nonnegativeInteger(value.topLogprobs))
    && (value.providerOptions === undefined || validProviderOptions(value.providerOptions))
    && (value.metadata === undefined || (isRecord(value.metadata) && Object.values(value.metadata).every((item) => typeof item === 'string')))
    && (value.signal === undefined || isAbortSignal(value.signal));
}
function isModelMessage(value: unknown): value is ModelRequest['messages'][number] {
  if (!isRecord(value) || typeof value.content !== 'string' || (value.name !== undefined && typeof value.name !== 'string')) return false;
  if (value.role === 'system') return onlyKeys(value, ['role', 'content', 'name']);
  if (value.role === 'user') return onlyKeys(value, ['role', 'content', 'name', 'images']) && (value.images === undefined || (Array.isArray(value.images) && value.images.every(validImage)));
  if (value.role === 'assistant') return onlyKeys(value, ['role', 'content', 'name', 'reasoning', 'toolCalls'])
    && (value.reasoning === undefined || typeof value.reasoning === 'string')
    && (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isModelToolCall)));
  return value.role === 'tool' && onlyKeys(value, ['role', 'content', 'name', 'toolName', 'toolCallId', 'toolCallType'])
    && typeof value.toolName === 'string' && value.toolName.trim().length > 0
    && (value.toolCallId === undefined || typeof value.toolCallId === 'string')
    && (value.toolCallType === 'function' || value.toolCallType === 'custom');
}
function isModelUsage(value: Record<string, unknown>): value is Record<string, unknown> & ModelUsage {
  return nonnegativeFinite(value.promptTokens) && nonnegativeFinite(value.completionTokens) && nonnegativeFinite(value.totalTokens)
    && (value.cacheReadTokens === undefined || nonnegativeFinite(value.cacheReadTokens))
    && (value.cacheWriteTokens === undefined || nonnegativeFinite(value.cacheWriteTokens))
    && (value.reasoningTokens === undefined || nonnegativeFinite(value.reasoningTokens));
}
function isModelToolCall(value: unknown): value is ModelToolCall {
  return isRecord(value) && typeof value.name === 'string' && value.name.trim().length > 0
    && (value.id === undefined || typeof value.id === 'string') && isRecord(value.input)
    && ((value.type === 'function' && value.input.kind === 'json' && isJsonObject(value.input.value))
      || (value.type === 'custom' && value.input.kind === 'text' && typeof value.input.value === 'string'));
}
function isModelResponse(value: Record<string, unknown>): value is Record<string, unknown> & ModelResponse {
  return typeof value.content === 'string' && typeof value.model === 'string' && value.model.trim().length > 0
    && typeof value.provider === 'string' && value.provider.trim().length > 0 && isModelTerminationReason(value.terminationReason)
    && (value.providerState === undefined || isModelProviderState(value.providerState))
    && (value.requestId === undefined || (typeof value.requestId === 'string' && value.requestId.trim().length > 0))
    && (value.usage === undefined || (isRecord(value.usage) && isModelUsage(value.usage)))
    && (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isModelToolCall)))
    && (value.reasoning === undefined || typeof value.reasoning === 'string')
    && (value.reasoningSummary === undefined || typeof value.reasoningSummary === 'string')
    && (value.providerTerminationReason === undefined || (typeof value.providerTerminationReason === 'string' && value.providerTerminationReason.trim().length > 0))
    && (value.timings === undefined || (isRecord(value.timings) && Object.values(value.timings).every(nonnegativeFinite)));
}
function isModelProviderState(value: unknown): value is ModelProviderState {
  return isRecord(value) && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0 && typeof value.kind === 'string' && value.kind.length > 0 && isJsonObject(value.data);
}
function isModelTerminationReason(value: unknown): value is ModelTerminationReason {
  return value === 'stop' || value === 'tool_calls' || value === 'output_limit' || value === 'content_filter' || value === 'unknown';
}
function isModelParameter(value: unknown): value is ModelProfile['supportedParameters'][number] { return typeof value === 'string' && MODEL_PARAMETERS.has(value); }
function isModelToolInputSupport(value: unknown): value is ModelProfile['capabilities']['supportedToolInputs'][number] {
  if (!isRecord(value)) return false;
  if (value.kind === 'json' || value.kind === 'text') return onlyKeys(value, ['kind']);
  return value.kind === 'grammar' && typeof value.syntax === 'string' && value.syntax.length > 0 && onlyKeys(value, ['kind', 'syntax']);
}
function optionalRaw(value: Record<string, unknown>): { raw?: unknown } { return Object.hasOwn(value, 'raw') ? { raw: value.raw } : {}; }
function finiteInRange(value: unknown, minimum: number, maximum: number): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum; }
function nonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function positiveFinite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_PARAMETERS = new Set(['temperature', 'topP', 'maxOutputTokens', 'responseFormat', 'tools', 'keepAlive', 'reasoning', 'logprobs', 'topLogprobs', 'metadata', 'providerOptions']);
function isJsonObject(value: unknown): value is import('./index.js').ModelProviderStateObject { return isRecord(value) && isJsonContainer(value, new WeakSet(), 0); }
function isJson(value: unknown, seen: WeakSet<object>, depth: number): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  return isJsonContainer(value, seen, depth);
}
function isJsonContainer(value: object, seen: WeakSet<object>, depth: number): boolean {
  if (depth > 64 || seen.has(value)) return false;
  seen.add(value);
  const values = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : undefined;
  const valid = values !== undefined && values.length <= 10_000 && values.every((item) => isJson(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function nonnegativeFinite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function nonempty(value: unknown, name: string, issues: string[]): void { if (typeof value !== 'string' || value.trim().length === 0) issues.push(`${name} must be a non-empty string.`); }
function contract(message: string, issues: string[]): ModelContractError { return new ModelContractError(message, issues); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
