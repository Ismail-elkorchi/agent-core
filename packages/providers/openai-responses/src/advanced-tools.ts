import { canonicalJsonString, parseJsonObject, type JsonObject } from '@agent-core/json';
import { ModelProviderError, type ModelRequest, type ModelToolCaller } from '@agent-core/model';
import type { ResponsesOutputItem } from './index.js';
import { responsesTool } from './tools.js';

export function responsesCaller(value: unknown, provider: string): ModelToolCaller | undefined {
  if (value === undefined || value === null) return undefined;
  let object: JsonObject;
  try { object = parseJsonObject(value); }
  catch { throw malformed(provider, 'Invalid tool caller.'); }
  if (object.type === 'direct' && Object.keys(object).length === 1) return undefined;
  if (object.type !== 'program' || typeof object.caller_id !== 'string' || !object.caller_id.trim() || object.caller_id.length > 1024 || Object.keys(object).some(key => key !== 'type' && key !== 'caller_id'))
    throw malformed(provider, 'Invalid program caller.');
  return Object.freeze({ type: 'programmatic', callerId: object.caller_id });
}
export function responsesCallerWire(caller: ModelToolCaller): JsonObject {
  return { type: 'program', caller_id: caller.callerId };
}
export function isResponsesToolProtocol(item: ResponsesOutputItem): boolean {
  return ['program', 'program_output', 'tool_search_call', 'tool_search_output'].includes(item.type ?? '');
}
export function validateResponsesToolProtocol(item: ResponsesOutputItem, provider: string): void {
  if (item.type === 'program') {
    if (!item.call_id || typeof item.code !== 'string' || typeof item.fingerprint !== 'string' || !item.fingerprint)
      throw malformed(provider, 'Malformed program continuation.');
  } else if (item.type === 'program_output') {
    if (!item.call_id || typeof item.result !== 'string' || !['completed', 'incomplete'].includes(item.status ?? ''))
      throw malformed(provider, 'Malformed program output.');
  } else if (item.type === 'tool_search_call' || item.type === 'tool_search_output') {
    if (item.execution !== 'server' || item.call_id != null || item.status !== 'completed')
      throw malformed(provider, 'Only completed admitted hosted discovery is supported.');
    if (item.type === 'tool_search_output' && !Array.isArray(item.tools))
      throw malformed(provider, 'Malformed loaded tool definitions.');
    if (item.type === 'tool_search_call') {
      try { parseJsonObject(item.arguments); }
      catch { throw malformed(provider, 'Malformed hosted discovery arguments.'); }
    }
  } else throw malformed(provider, 'Unsupported tool protocol item.');
}
/** Validates native exposure against the inventory already admitted by the application. */
export function responsesExposure(request: ModelRequest, provider: string) {
  const inventory = new Map((request.tools ?? []).map(tool => [tool.type === 'function' ? tool.function.name : tool.name, tool]));
  const loaded = new Set([...inventory].filter(([,tool]) => !tool.deferLoading).map(([name]) => name));
  const programs = new Map<string, ReadonlySet<string>>();
  const endedPrograms = new Set<string>();
  const observe = (item: ResponsesOutputItem): void => {
    validateResponsesToolProtocol(item, provider);
    if (item.type === 'program' || item.type === 'program_output') {
      if (![...inventory.values()].some(tool => tool.allowedCallers?.includes('programmatic')))
        throw malformed(provider, 'Unadvertised program execution.');
      if (!item.call_id) throw malformed(provider, 'Program identity is missing.');
      if (item.type === 'program') {
        if (programs.has(item.call_id)) throw malformed(provider, 'Program identity was reused.');
        programs.set(item.call_id, new Set(loaded));
      } else {
        if (!programs.has(item.call_id)) throw malformed(provider, 'Program output has no retained origin.');
        if (endedPrograms.has(item.call_id)) throw malformed(provider, 'Program output repeated a terminal origin.');
        endedPrograms.add(item.call_id);
      }
    } else {
      if (![...inventory.values()].some(tool => tool.deferLoading)) throw malformed(provider, 'Unadvertised tool search.');
      if (item.type === 'tool_search_output') for (const raw of item.tools as unknown[]) {
        const tool = parseJsonObject(raw);
        if (typeof tool.name !== 'string') throw malformed(provider, 'Loaded tool has no identity.');
        const known = inventory.get(tool.name);
        if (!known || canonicalJsonString(tool) !== canonicalJsonString(responsesTool(known)))
          throw malformed(provider, 'Hosted search changed an admitted tool definition.');
        loaded.add(tool.name);
      }
    }
  };
  for (const message of request.messages) if (message.role === 'protocol' && message.state.kind === 'responses.tools') {
    for (const item of message.state.data.items as readonly ResponsesOutputItem[]) observe(item);
  }
  return { observe, assertCall(item: ResponsesOutputItem) {
    const tool = item.name ? inventory.get(item.name) : undefined;
    const caller = responsesCaller(item.caller, provider);
    if (tool?.deferLoading && !loaded.has(item.name ?? ''))
      throw malformed(provider, 'Tool call was not loaded in the admitted catalog.');
    if (caller && (!programs.get(caller.callerId)?.has(item.name ?? '') || endedPrograms.has(caller.callerId) || !tool?.allowedCallers?.includes('programmatic')))
      throw malformed(provider, 'Program call has no authorized advertised origin.');
    if (!caller && tool?.allowedCallers && !tool.allowedCallers.includes('direct'))
      throw malformed(provider, 'Direct invocation was not advertised.');
    if (tool && ((item.type === 'function_call') !== (tool.type === 'function')))
      throw malformed(provider, 'Tool call kind does not match the admitted definition.');
    return caller;
  } };
}
function malformed(provider: string, message: string) {
  return new ModelProviderError({ provider, code: 'malformed_response', message });
}
