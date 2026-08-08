import type { ToolDefinition } from './definition.js';
import { validateToolEffectEnvelope } from './authorization.js';
import { isToolAvailable, type ToolPolicy } from './policy.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register<TDecodedInput, TCanonicalInput, TOutput>(
    tool: ToolDefinition<TDecodedInput, TCanonicalInput, TOutput>,
  ): void {
    validateToolDefinition(tool);
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  require(name: string): ToolDefinition {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  available(policy: ToolPolicy): ToolDefinition[] {
    return this.list().filter((tool) => isToolAvailable(tool, policy));
  }

}

export function validateToolDefinitions(tools: readonly ToolDefinition[]): readonly ToolDefinition[] {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return Object.freeze(registry.list());
}

export function validateToolDefinition(tool: unknown): ToolDefinition {
  if (!isRecord(tool)) throw new Error('Tool definition must be an object.');
  const definition = tool;
  const unexpected = Object.keys(definition).filter((key) => !TOOL_DEFINITION_KEYS.has(key));
  if (unexpected.length > 0) throw new Error(`Tool definition has unsupported fields: ${unexpected.sort().join(', ')}.`);
  nonEmpty(definition.name, 'name');
  nonEmpty(definition.implementationId, 'implementationId');
  nonEmpty(definition.description, 'description');
  if (typeof definition.jsonSchema !== 'object' || definition.jsonSchema === null || Array.isArray(definition.jsonSchema)) throw new Error(`Tool ${definition.name} jsonSchema must be an object.`);
  validateToolEffectEnvelope(definition.effectEnvelope);
  if (!isZodSchema(definition.outputSchema)) throw new Error(`Tool ${definition.name} outputSchema must be a Zod schema.`);
  if (typeof definition.decodeInput !== 'function') throw new Error(`Tool ${definition.name} decodeInput must be callable.`);
  if (typeof definition.invoke !== 'function') throw new Error(`Tool ${definition.name} invoke must be callable.`);
  if (typeof definition.canonicalizeInput !== 'function') throw new Error(`Tool ${definition.name} canonicalizeInput must be callable.`);
  if (typeof definition.deriveEffects !== 'function') throw new Error(`Tool ${definition.name} deriveEffects must be callable.`);
  if (definition.promptGuide !== undefined && typeof definition.promptGuide !== 'string' && typeof definition.promptGuide !== 'function') throw new Error(`Tool ${definition.name} promptGuide must be text or callable.`);
  if (definition.isAvailable !== undefined && typeof definition.isAvailable !== 'function') throw new Error(`Tool ${definition.name} isAvailable must be callable when provided.`);
  if (definition.presentObservation !== undefined && typeof definition.presentObservation !== 'function') throw new Error(`Tool ${definition.name} presentObservation must be callable when provided.`);
  if (definition.textInput !== undefined && !isTextInputDefinition(definition.textInput)) throw new Error(`Tool ${definition.name} textInput is invalid.`);
  if (!isToolDefinition(definition)) throw new Error(`Tool ${definition.name} did not satisfy the validated definition contract.`);
  return definition;
}

const TOOL_DEFINITION_KEYS = new Set([
  'name', 'implementationId', 'description', 'promptGuide', 'jsonSchema', 'outputSchema', 'textInput', 'effectEnvelope',
  'isAvailable', 'decodeInput', 'canonicalizeInput', 'deriveEffects', 'invoke', 'presentObservation'
]);

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Tool ${field} must be a non-empty string.`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isZodSchema(value: unknown): value is import('zod').ZodType { return isRecord(value) && typeof value.safeParse === 'function'; }
function isTextInputDefinition(value: unknown): value is NonNullable<ToolDefinition['textInput']> {
  if (!isRecord(value) || !isRecord(value.format) || typeof value.decode !== 'function') return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  if (value.promptGuide !== undefined && typeof value.promptGuide !== 'string' && typeof value.promptGuide !== 'function') return false;
  return value.format.type === 'text' || (value.format.type === 'grammar' && typeof value.format.syntax === 'string' && typeof value.format.definition === 'string');
}
function isToolDefinition(value: Record<string, unknown>): value is Record<string, unknown> & ToolDefinition {
  return typeof value.name === 'string' && value.name.trim().length > 0 && typeof value.implementationId === 'string' && value.implementationId.trim().length > 0
    && typeof value.description === 'string' && value.description.trim().length > 0 && isRecord(value.jsonSchema) && isZodSchema(value.outputSchema) && hasValidEnvelope(value.effectEnvelope)
    && typeof value.decodeInput === 'function' && typeof value.invoke === 'function'
    && typeof value.canonicalizeInput === 'function'
    && typeof value.deriveEffects === 'function'
    && (value.promptGuide === undefined || typeof value.promptGuide === 'string' || typeof value.promptGuide === 'function')
    && (value.textInput === undefined || isTextInputDefinition(value.textInput))
    && (value.isAvailable === undefined || typeof value.isAvailable === 'function')
    && (value.presentObservation === undefined || typeof value.presentObservation === 'function');
}
function hasValidEnvelope(value: unknown): boolean { try { validateToolEffectEnvelope(value); return true; } catch { return false; } }
