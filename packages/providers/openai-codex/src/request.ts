import { responsesInput, responsesToolCall } from '@agent-core/provider-openai-responses';
import type { CompiledModelRequest } from '@agent-core/model';
import {
  ModelProviderError,
  type ModelReasoningRequest,
  type ModelRequest,
  type ModelResponseFormat,
  type ModelTool,
  type ModelToolCall
} from '@agent-core/model';
import { OPENAI_CODEX_PROVIDER_ID } from './constants.js';

const compiledRequests = new WeakMap<ModelRequest, CompiledModelRequest>();
export function cacheCodexCompiledRequest(compiled: CompiledModelRequest): void {
  compiledRequests.set(compiled.logicalRequest, compiled);
}
export function codexCompiledRequest(request: ModelRequest): CompiledModelRequest | undefined {
  return compiledRequests.get(request);
}

export function toCodexResponsesRequest(request: ModelRequest, stream: boolean): Record<string, unknown> {
  const compiled = compiledRequests.get(request);
  if (compiled) return { ...compiled.body, stream };
  assertCodexRequestCompatibility(request);
  const { instructions, input } = responsesInput(request, OPENAI_CODEX_PROVIDER_ID, true);
  const body: Record<string, unknown> = {
    model: request.model,
    input,
    stream,
    store: false,
    tool_choice: 'auto',
    parallel_tool_calls: true
  };
  if (instructions.length > 0) body.instructions = instructions;
  body.text = toCodexTextConfig(request.responseFormat);
  if (request.tools && request.tools.length > 0) body.tools = request.tools.map(toCodexTool);
  const reasoning = toCodexReasoning(request.reasoning);
  if (reasoning) body.reasoning = reasoning;
  if (request.metadata && Object.keys(request.metadata).length > 0) body.metadata = request.metadata;
  applyCodexProviderOptions(body, request);
  return body;
}

function assertCodexRequestCompatibility(request: ModelRequest): void {
  const unsupported = [
    request.temperature === undefined ? undefined : 'temperature',
    request.topP === undefined ? undefined : 'topP',
    request.maxOutputTokens === undefined ? undefined : 'maxOutputTokens',
    request.logprobs === undefined ? undefined : 'logprobs',
    request.topLogprobs === undefined ? undefined : 'topLogprobs',
    request.keepAlive === undefined ? undefined : 'keepAlive'
  ].filter((value): value is string => value !== undefined);
  if (unsupported.length > 0)
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: `OpenAI Codex does not declare request parameter(s): ${unsupported.join(', ')}.`
    });
  if (request.reasoning?.strategy === 'budget')
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: 'OpenAI Codex does not declare token-budget reasoning.'
    });
  if (request.reasoning?.strategy === 'enabled')
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: 'OpenAI Codex requires an explicit reasoning effort when reasoning is configured.'
    });
  if (request.reasoning?.strategy === 'effort' && request.reasoning.mode !== undefined)
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: 'The ChatGPT subscription transport does not declare Responses reasoning.mode support.'
    });
}

function applyCodexProviderOptions(body: Record<string, unknown>, request: ModelRequest): void {
  if (!request.providerOptions) return;
  if (request.providerOptions.provider !== OPENAI_CODEX_PROVIDER_ID)
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: `Request options for ${request.providerOptions.provider} cannot be used with OpenAI Codex.`
    });
  const values = request.providerOptions.values;
  const unknown = Object.keys(values).filter((key) => key !== 'serviceTier');
  if (unknown.length > 0)
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: `Unsupported OpenAI Codex provider option(s): ${unknown.join(', ')}.`
    });
  if (
    values.serviceTier !== undefined &&
    values.serviceTier !== 'default' &&
    values.serviceTier !== 'priority'
  )
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: 'OpenAI Codex serviceTier must be default or priority.'
    });
  if (values.serviceTier !== undefined) body.service_tier = values.serviceTier;
}

export function toCodexFunctionCallInput(toolCall: ModelToolCall): Record<string, unknown> {
  return responsesToolCall(toolCall, OPENAI_CODEX_PROVIDER_ID);
}

function toCodexTool(tool: ModelTool): Record<string, unknown> {
  if (tool.type === 'custom') {
    return {
      type: 'custom',
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      format: tool.format
    };
  }
  return {
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    ...(tool.function.parameters ? { parameters: tool.function.parameters } : {})
  };
}

function toCodexTextConfig(format: ModelResponseFormat | undefined): Record<string, unknown> {
  if (!format || format === 'text') {
    return { verbosity: 'low' };
  }
  if (format === 'json') {
    return { format: { type: 'json_object' } };
  }
  return {
    format: {
      type: 'json_schema',
      name: 'agent_core_response',
      strict: true,
      schema: format.schema
    }
  };
}

function toCodexReasoning(reasoning: ModelReasoningRequest | undefined): Record<string, unknown> | undefined {
  if (!reasoning) {
    return { summary: 'auto' };
  }
  if (reasoning.strategy === 'disabled')
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: 'The ChatGPT subscription transport does not declare a disabled reasoning mode.'
    });
  if (reasoning.strategy === 'enabled')
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: 'OpenAI Codex requires an explicit reasoning effort.'
    });
  if (reasoning.strategy === 'budget')
    throw new ModelProviderError({
      provider: OPENAI_CODEX_PROVIDER_ID,
      code: 'invalid_request',
      message: 'OpenAI Codex does not accept a reasoning token budget.'
    });
  return { effort: reasoning.effort, summary: reasoning.summary ?? 'auto' };
}
