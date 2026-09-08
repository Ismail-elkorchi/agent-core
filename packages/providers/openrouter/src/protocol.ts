import { parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  createProviderContextState,
  ModelProviderError,
  type ModelInputItem,
  type ModelOutputItem,
  type ModelRequest,
  type ModelToolCall
} from '@agent-core/model';

export function chatProtocolMessages(
  items: readonly ModelInputItem[],
  serialize: (item: ModelInputItem) => Record<string, unknown>
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  let fields: JsonObject | undefined;
  for (const item of items) {
    if (item.role === 'protocol') {
      if (fields || item.state.kind !== 'chat.reasoning')
        throw new ModelProviderError({
          provider: 'openrouter',
          code: 'invalid_request',
          message: 'Unsupported or misplaced Chat reasoning state.'
        });
      fields = parseJsonObject(item.state.data.fields);
      if (
        Object.keys(fields).some(
          (key) => !['reasoning', 'reasoning_content', 'reasoning_details'].includes(key)
        )
      )
        throw new ModelProviderError({
          provider: 'openrouter',
          code: 'invalid_request',
          message: 'Unknown required Chat reasoning field.'
        });
      continue;
    }
    if (fields && item.role !== 'assistant')
      throw new ModelProviderError({
        provider: 'openrouter',
        code: 'invalid_request',
        message: 'Reasoning state must precede its original assistant message.'
      });
    const message = serialize(item);
    if (fields) {
      Object.assign(message, fields);
      fields = undefined;
    }
    const previous = messages.at(-1);
    // Typed output separates text and calls; Chat carries both in the same assistant envelope.
    if (item.role === 'assistant' && previous?.role === 'assistant') {
      if (typeof message.content === 'string')
        previous.content = `${typeof previous.content === 'string' ? previous.content : ''}${message.content}`;
      if (Array.isArray(message.tool_calls))
        previous.tool_calls = [
          ...(Array.isArray(previous.tool_calls) ? (previous.tool_calls as unknown[]) : []),
          ...(message.tool_calls as unknown[])
        ];
      for (const field of ['reasoning', 'reasoning_content', 'reasoning_details'])
        if (message[field] !== undefined) previous[field] = message[field];
    } else messages.push(message);
  }
  if (fields) messages.push({ role: 'assistant', content: null, ...fields });
  return messages;
}
export async function chatOutput(
  request: ModelRequest,
  endpoint: string,
  requestId: string,
  fields: JsonObject,
  content: string,
  toolCalls: readonly ModelToolCall[]
): Promise<readonly ModelOutputItem[]> {
  const output: ModelOutputItem[] = [];
  if (Object.keys(fields).length)
    output.push({
      type: 'protocol',
      state: await createProviderContextState({
        protocolRevision: 'openrouter-chat-2026-09-07-v1',
        request,
        endpoint,
        requestId,
        provider: 'openrouter',
        kind: 'chat.reasoning',
        data: { fields }
      })
    });
  if (content) output.push({ type: 'text', text: content });
  output.push(...toolCalls.map((toolCall) => ({ type: 'tool_call' as const, toolCall })));
  return output;
}
/** Assemble documented reasoning deltas by their stable index without altering signed strings. */
export function mergeReasoningDetails(current: Map<number, JsonObject>, value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw new Error('reasoning_details must be an array.');
  for (const [position, raw] of value.entries()) {
    const part = parseJsonObject(raw);
    if (
      part.type !== 'reasoning.text' &&
      part.type !== 'reasoning.encrypted' &&
      part.type !== 'reasoning.summary'
    )
      throw new Error('Unknown required reasoning_details type.');
    const index = typeof part.index === 'number' ? part.index : position;
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid reasoning detail index.');
    const previous = current.get(index);
    if (!previous) {
      current.set(index, part);
      continue;
    }
    const merged: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(part)) {
      if (['text', 'data', 'signature', 'summary'].includes(key) && typeof value === 'string')
        merged[key] = `${typeof previous[key] === 'string' ? previous[key] : ''}${value}`;
      else {
        if (previous[key] !== undefined && JSON.stringify(previous[key]) !== JSON.stringify(value))
          throw new Error('Reasoning detail identity changed while streaming.');
        merged[key] = value;
      }
    }
    current.set(index, parseJsonObject(merged));
  }
}
