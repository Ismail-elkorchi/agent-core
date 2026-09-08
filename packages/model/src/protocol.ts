import { parseJsonObject } from '@agent-core/json';
import {
  ModelContractError,
  parseModelRequest,
  parseModelUsage,
  parseProviderContextState
} from './validation.js';
import { modelInputIdentity } from './accounting.js';
import type {
  ModelInputItem,
  ModelProtocolCapabilities,
  ModelRequest,
  ModelResponse,
  ModelOutputItem,
  ProviderContextState,
  ModelContextTransformResult
} from './index.js';

export function conservativeProtocolCapabilities(
  endpoint: string,
  options: Partial<Omit<ModelProtocolCapabilities, 'version' | 'endpoint'>> = {}
): ModelProtocolCapabilities {
  return parseModelProtocolCapabilities({
    version: 1,
    revision: 'conservative-v1',
    endpoint,
    roles: ['system', 'user', 'assistant'],
    inputKinds: ['text', 'tool_call', 'tool_result'],
    outputKinds: ['text', 'tool_call'],
    state: 'none',
    continuation: 'replay',
    asyncTools: false,
    steering: 'next_request',
    contextTransforms: [],
    toolChoice: ['auto'],
    counting: 'estimate',
    ...options
  });
}
export function parseModelProtocolCapabilities(value: unknown): ModelProtocolCapabilities {
  const record = parseJsonObject(value);
  const roles = protocolChoices(record.roles, ['system', 'developer', 'user', 'assistant'] as const);
  const inputKinds = protocolChoices(record.inputKinds, [
    'text',
    'image',
    'audio',
    'video',
    'document',
    'tool_call',
    'tool_result',
    'protocol',
    'control'
  ] as const);
  const outputKinds = protocolChoices(record.outputKinds, [
    'text',
    'media',
    'tool_call',
    'protocol',
    'refusal'
  ] as const);
  const toolChoice = protocolChoices(record.toolChoice, ['auto', 'none', 'required', 'named'] as const);
  if (
    record.version !== 1 ||
    typeof record.revision !== 'string' ||
    !record.revision ||
    typeof record.endpoint !== 'string' ||
    !record.endpoint ||
    (record.state !== 'none' && record.state !== 'exact') ||
    (record.continuation !== 'replay' && record.continuation !== 'exact_prefix') ||
    typeof record.asyncTools !== 'boolean' ||
    (record.steering !== 'native' && record.steering !== 'next_request') ||
    !Array.isArray(record.contextTransforms) ||
    !record.contextTransforms.every((item) => typeof item === 'string') ||
    (record.counting !== 'estimate' && record.counting !== 'provider') ||
    (record.developerRole !== undefined &&
      record.developerRole !== 'native' &&
      record.developerRole !== 'system_if_no_system' &&
      record.developerRole !== 'unsupported') ||
    (record.reasoningAccounting !== undefined &&
      record.reasoningAccounting !== 'included_output' &&
      record.reasoningAccounting !== 'separate' &&
      record.reasoningAccounting !== 'unknown')
  )
    throw new ModelContractError('Invalid protocol capabilities.', [
      'An explicit version, endpoint, revision and legal capability combination are required.'
    ]);
  if (record.state === 'none' && (inputKinds.includes('protocol') || record.contextTransforms.length))
    throw new ModelContractError('Invalid protocol capabilities.', [
      'Protocol input and context transforms require exact state support.'
    ]);
  if (
    (record.developerRole === 'unsupported' && roles.includes('developer')) ||
    ((record.developerRole === 'native' || record.developerRole === 'system_if_no_system') &&
      !roles.includes('developer'))
  )
    throw new ModelContractError('Invalid protocol capabilities.', [
      'Developer role mapping conflicts with declared authority roles.'
    ]);
  return Object.freeze({
    version: 1,
    revision: record.revision,
    endpoint: record.endpoint,
    roles,
    ...(record.developerRole === undefined ? {} : { developerRole: record.developerRole }),
    inputKinds,
    outputKinds,
    toolChoice,
    state: record.state,
    continuation: record.continuation,
    asyncTools: record.asyncTools,
    steering: record.steering,
    contextTransforms: Object.freeze(
      record.contextTransforms.filter((item): item is string => typeof item === 'string')
    ),
    counting: record.counting,
    reasoningAccounting: record.reasoningAccounting ?? 'unknown'
  });
}
export function parseModelContextTransformResult(value: unknown): ModelContextTransformResult {
  const record = parseJsonObject(value, {
    maxDepth: 64,
    maxCollectionEntries: 100_000,
    maxStringBytes: 32 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024
  });
  if (
    Object.keys(record).some((key) => !['transformId', 'input', 'state', 'usage'].includes(key)) ||
    typeof record.transformId !== 'string' ||
    !record.transformId
  ) {
    throw new ModelContractError('Invalid context transform result.', [
      'A transform identity and declared result fields are required.'
    ]);
  }
  const state = parseProviderContextState(record.state);
  const input = parseModelRequest({ model: state.model, messages: record.input }).messages;
  return Object.freeze({
    transformId: record.transformId,
    state,
    input,
    ...(record.usage === undefined ? {} : { usage: parseModelUsage(record.usage) })
  });
}
function protocolChoices<T extends string>(value: unknown, choices: readonly T[]): readonly T[] {
  if (!Array.isArray(value))
    throw new ModelContractError('Invalid protocol capabilities.', ['Expected a capability list.']);
  const result: T[] = [];
  for (const item of value) {
    const choice = choices.find((choice) => choice === item);
    if (choice === undefined || result.includes(choice))
      throw new ModelContractError('Invalid protocol capabilities.', ['Unknown or duplicate capability.']);
    result.push(choice);
  }
  return Object.freeze(result);
}
export async function assertProviderContextCompatible(
  state: ProviderContextState,
  request: ModelRequest,
  endpoint: string,
  prefix: readonly ModelInputItem[],
  provider: string
): Promise<void> {
  state = parseProviderContextState(state);
  if (
    state.provider !== provider ||
    state.model !== request.model ||
    state.endpoint !== endpoint ||
    state.compatibility.model !== request.model ||
    state.compatibility.endpoint !== endpoint
  )
    throw new ModelContractError('Incompatible provider context state.', [
      'Provider, endpoint and model must match exactly.'
    ]);
  if (
    state.compatibility.requiresExactPrefix &&
    state.origin.inputIdentity !== (await modelInputIdentity(prefix))
  )
    throw new ModelContractError('Incompatible provider context state.', [
      'Earlier input was edited or reordered; required reasoning cannot be replayed.'
    ]);
}
export async function createProviderContextState(options: {
  readonly provider: string;
  readonly endpoint: string;
  readonly request: ModelRequest;
  readonly requestId: string;
  readonly kind: string;
  readonly data: unknown;
  readonly replay?: ProviderContextState['replay'];
  readonly requiresExactPrefix?: boolean;
  readonly tokenCount?: number;
  readonly tokenEstimate?: number;
}): Promise<ProviderContextState> {
  const request = parseModelRequest(options.request);
  return parseProviderContextState({
    version: 1,
    provider: options.provider,
    model: request.model,
    endpoint: options.endpoint,
    kind: options.kind,
    data: options.data,
    replay: options.replay ?? 'required',
    origin: { requestId: options.requestId, inputIdentity: await modelInputIdentity(request.messages) },
    compatibility: {
      model: request.model,
      endpoint: options.endpoint,
      requiresExactPrefix: options.requiresExactPrefix ?? true
    },
    ...(options.tokenCount === undefined ? {} : { tokenCount: options.tokenCount }),
    ...(options.tokenEstimate === undefined ? {} : { tokenEstimate: options.tokenEstimate })
  });
}
/** Display and protocol outputs are separate. No hidden state is recovered from raw. */
export function modelResponseOutput(response: ModelResponse): readonly ModelOutputItem[] {
  if (response.output?.length) return response.output;
  return Object.freeze([
    ...(response.providerState ? [{ type: 'protocol' as const, state: response.providerState }] : []),
    ...(response.content ? [{ type: 'text' as const, text: response.content }] : []),
    ...(response.toolCalls ?? []).map((toolCall) => ({ type: 'tool_call' as const, toolCall }))
  ]);
}
export function modelOutputToInput(output: readonly ModelOutputItem[]): readonly ModelInputItem[] {
  return output.map((item): ModelInputItem => {
    if (item.type === 'protocol') return { role: 'protocol', content: '', state: item.state };
    if (item.type === 'tool_call') return { role: 'assistant', content: '', toolCalls: [item.toolCall] };
    if (item.type === 'media') return { role: 'assistant', content: '', parts: [item.part] };
    return { role: 'assistant', content: item.text };
  });
}
