import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import * as z from 'zod';
import type { ToolDefinition, ToolInvocationMode } from './definition.js';
import { exportToolJsonSchema, registeredJsonSchema } from './json-schema.js';

/** Stable portable definition identity shared by admission, discovery, and authorization. */
export function toolDefinitionHash(tool: ToolDefinition): string {
  return hashJson({
    name: tool.name,
    implementationId: tool.implementationId,
    description: tool.description,
    jsonSchema: tool.jsonSchema,
    outputJsonSchema: tool.outputJsonSchema,
    effectEnvelope: tool.effectEnvelope,
    invocationModes: tool.invocationModes,
    ...(tool.requirements ? { requirements: tool.requirements } : {}),
    ...(tool.textInput ? {
      textInput: {
        description: tool.textInput.description ?? '',
        format: tool.textInput.format
      }
    } : {})
  });
}

/** Output defaults remain required: this describes validated results, not accepted inputs. */
export function compileOutputJsonSchema(schema: z.ZodType): JsonObject {
  if (!(schema instanceof z.ZodType)) throw new TypeError('Tool outputSchema must be a Zod schema.');
  // Zod's exporter adds a non-enumerable Standard Schema implementation handle.
  // Only its enumerable JSON Schema payload crosses the owned JSON boundary.
  const contract = exportToolJsonSchema(schema, false);
  if (!registeredJsonSchema(schema) && !['type', '$ref', 'const', 'enum', 'anyOf', 'oneOf', 'allOf', 'not'].some(key => Object.hasOwn(contract, key)))
    throw new TypeError('Tool outputSchema must declare a portable JSON result contract.');
  return parseJsonObject(contract, {
    maxDepth: 64,
    maxCollectionEntries: 50_000,
    maxStringBytes: 1_000_000,
    maxTotalBytes: 4_000_000
  });
}

export function normalizeToolInvocationModes(value: unknown): readonly ToolInvocationMode[] {
  if (value === undefined) return Object.freeze(['direct']);
  if (!Array.isArray(value) || value.length === 0 ||
      value.some(mode => mode !== 'direct' && mode !== 'programmatic') ||
      new Set(value).size !== value.length)
    throw new TypeError('Tool invocationModes must be a non-empty list of unique invocation modes.');
  return Object.freeze(['direct', 'programmatic'].filter(mode => value.includes(mode)) as ToolInvocationMode[]);
}
