import { parseJsonObject } from '@agent-core/evidence';
import type { ToolDefinition } from './definition.js';
import { validateToolEffectEnvelope } from './authorization.js';
import { isToolAvailable, type ToolPolicy } from './policy.js';
import { validateToolRequirements } from './resources.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  constructor(tools: readonly ToolDefinition[] = []) { for (const tool of tools) this.register(tool); }
  register<TDecodedInput, TCanonicalInput, TOutput>(tool: ToolDefinition<TDecodedInput, TCanonicalInput, TOutput>): void {
    const owned = validateToolDefinition(tool);
    if (this.tools.has(owned.name)) throw new Error('Tool already registered: ' + owned.name);
    this.tools.set(owned.name, owned);
  }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name); }
  require(name: string): ToolDefinition {
    const tool = this.get(name);
    if (!tool) throw new Error('Unknown tool: ' + name);
    return tool;
  }
  list(): ToolDefinition[] { return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')); }
  available(policy: ToolPolicy): ToolDefinition[] { return this.list().filter((tool) => isToolAvailable(tool, policy)); }
}

export function validateToolDefinitions(tools: readonly ToolDefinition[]): readonly ToolDefinition[] {
  const registry = new ToolRegistry(tools);
  return Object.freeze(registry.list());
}

export function validateToolDefinition(tool: unknown): ToolDefinition {
  if (!record(tool)) throw new Error('Tool definition must be an object.');
  const unexpected = Object.keys(tool).filter((key) => !KEYS.has(key));
  if (unexpected.length > 0) throw new Error('Tool definition has unsupported fields: ' + unexpected.sort().join(', ') + '.');
  const name = nonEmpty(tool.name, 'name');
  const implementationId = nonEmpty(tool.implementationId, 'implementationId');
  const description = nonEmpty(tool.description, 'description');
  if (!schema(tool.outputSchema)) throw new Error('Tool ' + name + ' outputSchema must be a Zod schema.');
  for (const member of ['decodeInput', 'canonicalizeInput', 'deriveEffects', 'invoke'] as const) if (typeof tool[member] !== 'function') throw new Error('Tool ' + name + ' ' + member + ' must be callable.');
  if (tool.promptGuide !== undefined && typeof tool.promptGuide !== 'string' && typeof tool.promptGuide !== 'function') throw new Error('Tool promptGuide is invalid.');
  if (tool.isAvailable !== undefined && typeof tool.isAvailable !== 'function') throw new Error('Tool isAvailable is invalid.');
  if (tool.presentObservation !== undefined && typeof tool.presentObservation !== 'function') throw new Error('Tool presentObservation is invalid.');
  const textInput = tool.textInput === undefined ? undefined : snapshotTextInput(tool.textInput);
  const jsonSchema = parseJsonObject(tool.jsonSchema, { maxDepth: 64, maxCollectionEntries: 50_000, maxStringBytes: 1_000_000, maxTotalBytes: 4_000_000 });
  const requirements = validateToolRequirements(tool.requirements);
  return Object.freeze({
    name, implementationId, description,
    ...(tool.promptGuide !== undefined ? { promptGuide: tool.promptGuide as NonNullable<ToolDefinition['promptGuide']> } : {}),
    jsonSchema,
    outputSchema: tool.outputSchema,
    ...(textInput ? { textInput } : {}),
    effectEnvelope: validateToolEffectEnvelope(tool.effectEnvelope),
    ...(requirements !== undefined ? { requirements } : {}),
    ...(tool.isAvailable ? { isAvailable: tool.isAvailable as NonNullable<ToolDefinition['isAvailable']> } : {}),
    decodeInput: tool.decodeInput as ToolDefinition['decodeInput'],
    canonicalizeInput: tool.canonicalizeInput as ToolDefinition['canonicalizeInput'],
    deriveEffects: tool.deriveEffects as ToolDefinition['deriveEffects'],
    invoke: tool.invoke as ToolDefinition['invoke'],
    ...(tool.presentObservation ? { presentObservation: tool.presentObservation as NonNullable<ToolDefinition['presentObservation']> } : {})
  });
}

const KEYS = new Set(['name', 'implementationId', 'description', 'promptGuide', 'jsonSchema', 'outputSchema', 'textInput', 'effectEnvelope', 'requirements', 'isAvailable', 'decodeInput', 'canonicalizeInput', 'deriveEffects', 'invoke', 'presentObservation']);
function snapshotTextInput(value: unknown): NonNullable<ToolDefinition['textInput']> {
  if (!record(value) || !record(value.format) || typeof value.decode !== 'function') throw new Error('Tool textInput is invalid.');
  if (value.description !== undefined && typeof value.description !== 'string') throw new Error('Tool textInput description is invalid.');
  if (value.promptGuide !== undefined && typeof value.promptGuide !== 'string' && typeof value.promptGuide !== 'function') throw new Error('Tool textInput promptGuide is invalid.');
  const format = value.format.type === 'text'
    ? Object.freeze({ type: 'text' as const })
    : value.format.type === 'grammar' && typeof value.format.syntax === 'string' && typeof value.format.definition === 'string'
      ? Object.freeze({ type: 'grammar' as const, syntax: value.format.syntax, definition: value.format.definition })
      : undefined;
  if (!format) throw new Error('Tool textInput format is invalid.');
  return Object.freeze({ format, ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(value.promptGuide ? { promptGuide: value.promptGuide as NonNullable<ToolDefinition['promptGuide']> } : {}), decode: value.decode as (text: string) => unknown });
}
function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Tool ' + field + ' must be a non-empty string.');
  return value;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function schema(value: unknown): value is import('zod').ZodType { return record(value) && typeof value.safeParse === 'function'; }
