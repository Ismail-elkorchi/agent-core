import type * as z from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { defineJsonSchema } from '@agent-core/tools';
import { jsonLimits } from './limits.js';

const validator = new Ajv2020({
  strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false,
  ownProperties: true, validateSchema: true, allErrors: false,
  coerceTypes: false, useDefaults: false, removeAdditional: false,
  // Draft 2020-12's format vocabulary is annotation-only. Custom vocabularies
  // and schema-defined regular expressions are unavailable in this bounded adapter.
  validateFormats: false, addUsedSchema: false, loopRequired: 32, loopEnum: 32
});

/** The original schema owns both validation and the serialized portable contract. */
export function mcpSchema(value: unknown, maxBytes: number): z.ZodType<JsonValue> {
  const schema = parseJsonObject(value, { ...jsonLimits(maxBytes), maxDepth: 16, maxCollectionEntries: 2048 });
  checkSchema(schema);
  return defineJsonSchema(schema, owned => {
    try {
      const check = validator.compile(owned);
      return input => {
        // A fixed work boundary precedes synchronous assertion evaluation. Schema
        // maxima cannot make uniqueItems/combinators validate unbounded collections.
        try { parseJsonValue(input, { ...jsonLimits(1_000_000), maxCollectionEntries: 1024 }); }
        catch { return [{ message: 'MCP schema validation work limit exceeded.' }]; }
        return check(input) ? undefined : [{ message: 'Value violates the MCP JSON Schema.' }];
      };
    } finally {
      // Keep compiled closures owned by their tool rather than accumulating stale
      // server revisions in a process-wide schema cache.
      validator.removeSchema(owned);
    }
  });
}
function checkSchema(schema: JsonObject): void {
  for (const key of ['$ref', '$dynamicRef', '$id', '$anchor', '$dynamicAnchor', '$vocabulary', '$async', 'pattern', 'patternProperties']) {
    if (Object.hasOwn(schema, key)) throw new Error(`MCP schema capability is unavailable: ${key}.`);
  }
  if (schema.$schema !== undefined && schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error('MCP schemas must use JSON Schema 2020-12.');
  }
  // Visit schema positions only: a const/default/enum may legitimately contain
  // keys such as "$ref" as ordinary result data.
  for (const key of ['properties', '$defs', 'dependentSchemas']) {
    const entries = schema[key];
    if (entries === undefined) continue;
    if (!object(entries)) throw new Error('Invalid MCP schema map.');
    for (const item of Object.values(entries)) child(item);
  }
  for (const key of ['additionalProperties', 'items', 'contains', 'propertyNames', 'unevaluatedProperties',
    'unevaluatedItems', 'if', 'then', 'else', 'not', 'contentSchema']) {
    const item = schema[key];
    if (item !== undefined) child(item);
  }
  for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) {
    const items = schema[key];
    if (items === undefined) continue;
    if (!Array.isArray(items)) throw new Error('Invalid MCP subschema list.');
    const children: readonly JsonValue[] = items;
    for (const item of children) child(item);
  }
}
function child(value: JsonValue): void {
  if (typeof value === 'boolean') return;
  if (!object(value)) throw new Error('Invalid MCP subschema.');
  checkSchema(value);
}
function object(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
