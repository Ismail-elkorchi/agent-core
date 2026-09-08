import { parseJsonObject } from '@agent-core/json';
import {
  ModelProviderError,
  createProviderContextState,
  modelOutputToInput,
  type ModelContentPart,
  type ModelInputItem,
  type ModelOutputItem,
  type ModelRequest,
  type ModelToolCall
} from '@agent-core/model';
import { decodeResponsesPayload, type ResponsesOutputItem } from './index.js';

export function responsesInput(
  request: ModelRequest,
  provider: string,
  systemInstructions = false
): { instructions: string; input: unknown[] } {
  const input: unknown[] = [];
  const instructions: string[] = [];
  for (const [index, item] of request.messages.entries()) {
    if (item.role === 'system' && systemInstructions) {
      instructions.push(item.content);
      if (item.parts?.length)
        throw invalid(provider, 'System content parts cannot be lowered into the instructions channel.');
      continue;
    }
    if (item.role === 'protocol') {
      if (
        !['responses.reasoning', 'responses.compaction'].includes(item.state.kind) ||
        !Array.isArray(item.state.data.items)
      )
        throw invalid(provider, 'Unsupported Responses protocol state.');
      if (item.state.kind === 'responses.compaction') {
        if (
          request.messages
            .slice(0, index)
            .some((prefix) => prefix.role !== 'system' && prefix.role !== 'developer')
        )
          throw invalid(provider, 'A native compacted window must precede ordinary conversation input.');
        // Replay the complete canonical window, then append current host authority at its original roles.
        // Authority is current request configuration, not old transcript to insert ahead of the window.
        input.unshift(...validatedResponsesReplayItems(item.state.data.items, provider));
      } else input.push(...validatedResponsesReplayItems(item.state.data.items, provider));
      continue;
    }
    if (item.role === 'control') {
      if (item.update.reasoning.strategy !== 'effort')
        throw invalid(provider, 'Configuration updates require an explicit reasoning effort.');
      input.push({ type: 'configuration_update', reasoning: { effort: item.update.reasoning.effort } });
      continue;
    }
    if (item.role === 'tool') {
      if (!item.toolCallId) throw invalid(provider, 'Tool results require the original call identity.');
      input.push({
        type: item.toolCallType === 'custom' ? 'custom_tool_call_output' : 'function_call_output',
        call_id: item.toolCallId,
        output: item.content
      });
      if (item.images?.length || item.parts?.length)
        input.push({ role: 'user', content: responsesContent({ ...item, content: '' }, provider) });
      continue;
    }
    if (item.role === 'assistant') {
      if (item.content || item.parts?.length)
        input.push({ role: 'assistant', content: responsesContent(item, provider) });
      for (const call of item.toolCalls ?? []) input.push(responsesToolCall(call, provider));
      continue;
    }
    input.push({ role: item.role, content: responsesContent(item, provider) });
  }
  return { instructions: instructions.join('\n\n'), input };
}
export function responsesToolCall(call: ModelToolCall, provider: string): Record<string, unknown> {
  if (!call.id) throw invalid(provider, 'Responses tool calls require the original call identity.');
  const asyncField = call.async === undefined ? {} : { async: call.async };
  return call.type === 'custom'
    ? {
        ...asyncField,
        type: 'custom_tool_call',
        call_id: call.id,
        name: call.name,
        input: call.input.value
      }
    : {
        ...asyncField,
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.input.value)
      };
}
function responsesContent(item: ModelInputItem, provider: string): string | Record<string, unknown>[] {
  if (!item.images?.length && !item.parts?.length) return item.content;
  return [
    ...(item.content
      ? [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.content }]
      : []),
    ...(item.images ?? []).map((image) => responsePart({ type: 'image', image }, provider, item.role)),
    ...(item.parts ?? []).map((part) => responsePart(part, provider, item.role))
  ];
}
function responsePart(
  part: ModelContentPart,
  provider: string,
  role: ModelInputItem['role']
): Record<string, unknown> {
  if (part.type === 'text')
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
  if (role !== 'user' && role !== 'tool')
    throw invalid(provider, `Media is not supported in the ${role} channel.`);
  if (part.type === 'image')
    return {
      type: 'input_image',
      image_url: `data:${part.image.mediaType};base64,${part.image.type === 'base64' ? part.image.data : Buffer.from(part.image.data).toString('base64')}`,
      ...(part.image.detail ? { detail: part.image.detail } : {})
    };
  if (part.type === 'document')
    return {
      type: 'input_file',
      ...(part.source.type === 'url'
        ? { file_url: part.source.value }
        : part.source.type === 'file'
          ? { file_id: part.source.value }
          : { filename: 'document.pdf', file_data: `data:${part.mediaType};base64,${part.source.value}` })
    };
  throw invalid(provider, `Unsupported Responses media kind: ${part.type}.`);
}
export async function responsesOutput(options: {
  request: ModelRequest;
  provider: string;
  endpoint: string;
  requestId: string;
  protocolRevision: string;
  items: readonly ResponsesOutputItem[];
}): Promise<readonly ModelOutputItem[]> {
  const output: ModelOutputItem[] = [];
  for (const item of options.items) {
    if (item.type === 'reasoning' || item.type === 'compaction') {
      const prefix = [...options.request.messages, ...modelOutputToInput(output)];
      const state = await createProviderContextState({
        provider: options.provider,
        protocolRevision: options.protocolRevision,
        endpoint: options.endpoint,
        request: { ...options.request, messages: prefix },
        requestId: options.requestId,
        kind: item.type === 'reasoning' ? 'responses.reasoning' : 'responses.compaction',
        data: { items: [item] }
      });
      output.push({ type: 'protocol', state });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (!item.call_id || !item.name)
        throw invalidOutput(options.provider, 'Missing native tool identity.');
      if (item.async !== undefined && typeof item.async !== 'boolean')
        throw invalidOutput(options.provider, 'Invalid async tool-call mode.');
      if (
        item.async === true &&
        !options.request.tools?.some(
          (tool) =>
            tool.async === true && (tool.type === 'function' ? tool.function.name : tool.name) === item.name
        )
      )
        throw invalidOutput(
          options.provider,
          'Provider returned an asynchronous call that was not advertised as asynchronous.'
        );
      const toolCall: ModelToolCall =
        item.type === 'custom_tool_call'
          ? {
              ...(typeof item.async === 'boolean' ? { async: item.async } : {}),
              id: item.call_id,
              name: item.name,
              type: 'custom',
              input: { kind: 'text', value: item.input ?? '' }
            }
          : {
              ...(typeof item.async === 'boolean' ? { async: item.async } : {}),
              id: item.call_id,
              name: item.name,
              type: 'function',
              input: { kind: 'json', value: parseJsonObject(JSON.parse(item.arguments ?? '{}') as unknown) }
            };
      output.push({ type: 'tool_call', toolCall });
    } else if (item.type === 'message' || item.role === 'assistant') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' || part.type === 'text')
          output.push({ type: 'text', text: part.text ?? part.output_text ?? '' });
        else if (part.type === 'refusal' && typeof part.refusal === 'string')
          output.push({ type: 'refusal', text: part.refusal });
        else
          throw invalidOutput(
            options.provider,
            `Unsupported Responses output content: ${String(part.type)}.`
          );
      }
    } else
      throw invalidOutput(options.provider, `Unsupported required Responses output: ${String(item.type)}.`);
  }
  return Object.freeze(output);
}
function invalid(provider: string, message: string): ModelProviderError {
  return new ModelProviderError({ provider, code: 'invalid_request', message });
}
function invalidOutput(provider: string, message: string): ModelProviderError {
  return new ModelProviderError({ provider, code: 'malformed_response', message });
}

/** Exact Responses payload locations; tool arguments named data/signature remain fully counted. */
export function responsesPayloadPaths(
  body: Readonly<Record<string, unknown>>
): readonly (readonly (string | number)[])[] {
  const paths: (string | number)[][] = [];
  if (!Array.isArray(body.input)) return paths;
  for (const [index, raw] of (body.input as unknown[]).entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Readonly<Record<string, unknown>>;
    if (item.type === 'reasoning' || item.type === 'compaction') {
      paths.push(['input', index]);
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const [partIndex, rawPart] of (item.content as unknown[]).entries()) {
      if (!rawPart || typeof rawPart !== 'object') continue;
      const part = rawPart as Readonly<Record<string, unknown>>;
      if (part.type === 'input_image' && part.image_url !== undefined)
        paths.push(['input', index, 'content', partIndex, 'image_url']);
      if (part.type === 'input_file')
        for (const field of ['file_data', 'file_url', 'file_id'])
          if (part[field] !== undefined) paths.push(['input', index, 'content', partIndex, field]);
    }
  }
  return paths;
}

/** Provider extensions are bounded and kind-checked before exact replay. */
export function validatedResponsesReplayItems(
  value: unknown,
  provider: string
): readonly ResponsesOutputItem[] {
  const payload = decodeResponsesPayload({ output: value });
  const items = payload.output ?? [];
  for (const item of items) {
    if (item.type === 'reasoning') {
      if (!item.id || (item.encrypted_content === undefined && item.summary === undefined))
        throw invalid(provider, 'Malformed Responses reasoning state.');
    } else if (item.type === 'compaction') {
      if (!item.encrypted_content) throw invalid(provider, 'Compaction state lacks its encrypted payload.');
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (
        !item.call_id ||
        !item.name ||
        (item.type === 'function_call'
          ? typeof item.arguments !== 'string'
          : typeof item.input !== 'string')
      )
        throw invalid(provider, 'Malformed native call in replay window.');
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (!item.call_id || (typeof item.output !== 'string' && !Array.isArray(item.output)))
        throw invalid(provider, 'Malformed native tool result in replay window.');
    } else if (item.type === 'message' || item.type === undefined) {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role ?? '') || !item.content)
        throw invalid(provider, 'Malformed native message in replay window.');
      for (const part of item.content)
        if (
          !['text', 'input_text', 'output_text', 'input_image', 'input_file', 'refusal'].includes(
            part.type ?? ''
          )
        )
          throw invalid(provider, 'Unsupported native message content in replay window.');
    } else if (item.type === 'configuration_update') {
      const reasoning = parseJsonObject(item.reasoning);
      if (typeof reasoning.effort !== 'string')
        throw invalid(provider, 'Malformed native configuration update.');
    } else throw invalid(provider, `Unsupported required native replay item: ${item.type}.`);
  }
  return items;
}
