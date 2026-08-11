import {
  type ModelImage,
  type ModelMessage,
  ModelProviderError,
  type ModelReasoningRequest,
  type ModelRequest,
  type ModelResponseFormat,
  type ModelTool,
  type ModelToolCall
} from '@agent-core/model';
import { OPENAI_CODEX_PROVIDER_ID } from './constants.js';

export function toCodexResponsesRequest(request: ModelRequest, stream: boolean): Record<string, unknown> {
  assertCodexRequestCompatibility(request);
  const { instructions, input } = toCodexInput(request.messages);
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
  if (unsupported.length > 0) throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: `OpenAI Codex does not declare request parameter(s): ${unsupported.join(', ')}.` });
  if (request.reasoning?.strategy === 'budget') throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: 'OpenAI Codex does not declare token-budget reasoning.' });
  if (request.reasoning?.strategy === 'enabled') throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: 'OpenAI Codex requires an explicit reasoning effort when reasoning is configured.' });
  if (request.reasoning?.strategy === 'effort' && request.reasoning.mode !== undefined) throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: 'The ChatGPT subscription transport does not declare Responses reasoning.mode support.' });
  if (request.reasoning?.strategy === 'effort' && request.reasoning.effort === 'max' && !request.model.startsWith('gpt-5.6')) throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: `OpenAI Codex max effort is not declared for ${request.model}.` });
}

function applyCodexProviderOptions(body: Record<string, unknown>, request: ModelRequest): void {
  if (!request.providerOptions) return;
  if (request.providerOptions.provider !== OPENAI_CODEX_PROVIDER_ID) throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: `Request options for ${request.providerOptions.provider} cannot be used with OpenAI Codex.` });
  const values = request.providerOptions.values;
  const unknown = Object.keys(values).filter((key) => key !== 'serviceTier');
  if (unknown.length > 0) throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: `Unsupported OpenAI Codex provider option(s): ${unknown.join(', ')}.` });
  if (values.serviceTier !== undefined && values.serviceTier !== 'default' && values.serviceTier !== 'priority') throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: 'OpenAI Codex serviceTier must be default or priority.' });
  if (values.serviceTier !== undefined) body.service_tier = values.serviceTier;
}

export function toCodexFunctionCallInput(toolCall: ModelToolCall): Record<string, unknown> {
  if (toolCall.input.kind === 'text') {
    return {
      type: 'custom_tool_call',
      call_id: toolCall.id ?? `call_${toolCall.name}`,
      name: toolCall.name,
      input: toolCall.input.value
    };
  }
  return {
    type: 'function_call',
    call_id: toolCall.id ?? `call_${toolCall.name}`,
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.input.value)
  };
}

function toCodexInput(messages: readonly ModelMessage[]): { instructions: string; input: unknown[] } {
  const instructionMessages = instructionMessagesFrom(messages);
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'tool') {
      input.push(toolCallOutputForCodexMessage(message));
      if (message.images && message.images.length > 0) input.push({ role: 'user', content: contentForCodexMessage({ role: 'user', content: '', images: message.images }) });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content.length > 0) {
        input.push({ role: 'assistant', content: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push(toCodexFunctionCallInput(toolCall));
      }
      continue;
    }
    input.push({
      role: 'user',
      content: contentForCodexMessage(message)
    });
  }
  return { instructions: instructionMessages.join('\n\n'), input };
}

function instructionMessagesFrom(messages: readonly ModelMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'system' && message.content.trim().length > 0)
    .map((message) => message.content);
}

function contentForCodexMessage(message: ModelMessage): string | Record<string, unknown>[] {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }
  return [
    ...(message.content.length > 0 ? [{ type: 'input_text', text: message.content }] : []),
    ...message.images.map((image) => ({
      type: 'input_image',
      image_url: `data:${image.mediaType};base64,${imageToBase64(image)}`,
      ...(image.detail ? { detail: image.detail } : {})
    }))
  ];
}

function imageToBase64(image: ModelImage): string {
  return image.type === 'base64' ? image.data : Buffer.from(image.data).toString('base64');
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

function toolCallOutputForCodexMessage(message: ModelMessage): Record<string, unknown> {
  const callId = message.toolCallId ?? message.toolName ?? message.name ?? 'call_unknown';
  if (message.toolCallType === 'custom') {
    return {
      type: 'custom_tool_call_output',
      call_id: callId,
      output: message.content
    };
  }
  return {
    type: 'function_call_output',
    call_id: callId,
    output: message.content
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
  if (reasoning.strategy === 'disabled') throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: 'The ChatGPT subscription transport does not declare a disabled reasoning mode.' });
  if (reasoning.strategy === 'enabled') throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: 'OpenAI Codex requires an explicit reasoning effort.' });
  if (reasoning.strategy === 'budget') throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'invalid_request', message: 'OpenAI Codex does not accept a reasoning token budget.' });
  return { effort: reasoning.effort, summary: reasoning.summary ?? 'auto' };
}
