import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { ToolCall, ToolCallInput, ToolInput } from './definition.js';

const ownedCalls = new WeakSet();
const LIMITS = { maxDepth: 32, maxCollectionEntries: 20_000, maxStringBytes: 4_000_000, maxTotalBytes: 8_000_000 } as const;

export function createToolCall(input: ToolCallInput): ToolCall {
  if (ownedCalls.has(input)) return input as ToolCall;
  if (input.name.trim().length === 0) throw new Error('Tool call name must be non-empty.');
  const toolInput: ToolInput = input.input.kind === 'json'
    ? Object.freeze({ kind: 'json', value: parseJsonObject(input.input.value, LIMITS) })
    : Object.freeze({ kind: 'text', value: input.input.value });
  return own(Object.freeze({ ...(input.id === undefined ? {} : { id: input.id }), name: input.name, input: toolInput }));
}

export function decodeToolCall(value: unknown): ToolCall { return decodeOwnedToolCall(parseJsonObject(value, LIMITS)); }

export function decodeOwnedToolCall(record: JsonObject): ToolCall {
  if (Object.keys(record).some((key) => key !== 'id' && key !== 'name' && key !== 'input') || typeof record.name !== 'string' || record.name.trim().length === 0
    || (record.id !== undefined && typeof record.id !== 'string') || !jsonObject(record.input)) throw new Error('Tool call does not match the strict JSON tool-call contract.');
  const input = record.input;
  if (input.kind === 'json' && jsonObject(input.value)) return own(Object.freeze({ ...(typeof record.id === 'string' ? { id: record.id } : {}), name: record.name, input: Object.freeze({ kind: 'json', value: input.value }) }));
  if (input.kind === 'text' && typeof input.value === 'string') return own(Object.freeze({ ...(typeof record.id === 'string' ? { id: record.id } : {}), name: record.name, input: Object.freeze({ kind: 'text', value: input.value }) }));
  throw new Error('Tool call input does not match the strict JSON tool-call contract.');
}

export function isOwnedToolCall(value: ToolCallInput): value is ToolCall { return ownedCalls.has(value); }
function own(value: ToolCallInput): ToolCall { ownedCalls.add(value); return value as ToolCall; }
function jsonObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
