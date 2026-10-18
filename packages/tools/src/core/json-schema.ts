import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import * as z from 'zod';

export interface JsonSchemaValidationIssue { readonly message: string }
export type JsonSchemaValidator = (value: JsonValue) => readonly JsonSchemaValidationIssue[] | undefined;
const contracts = new WeakMap<z.core.$ZodType, JsonObject>();
const limits = { maxDepth: 64, maxCollectionEntries: 50_000, maxStringBytes: 1_000_000, maxTotalBytes: 4_000_000 };

/** Compile the exact owned JSON Schema with an author-supplied, synchronous validator. */
export function defineJsonSchema(schema: unknown, compileValidator: (schema: JsonObject) => JsonSchemaValidator): z.ZodType<JsonValue> {
  const owned = parseJsonObject(schema, limits);
  rewriteReferences(owned, ''); // Reject unbound schema resources before compilation.
  const validate = compileValidator(owned);
  if (typeof validate !== 'function') throw new TypeError('JSON Schema compiler must return a synchronous validator.');
  const validator = z.unknown().nonoptional().superRefine((value, context) => {
    let json: JsonValue;
    try { json = parseJsonValue(value); }
    catch { context.addIssue({ code: 'custom', message: 'Value must be JSON.' }); return; }
    const issues = validate(json);
    if (issues !== undefined && !Array.isArray(issues)) throw new TypeError('JSON Schema validation must return synchronous issues or undefined.');
    const validatedIssues: readonly JsonSchemaValidationIssue[] = issues ?? [];
    for (const issue of validatedIssues) {
      if (typeof issue.message !== 'string') throw new TypeError('JSON Schema validation issues require a message.');
      context.addIssue({ code: 'custom', message: issue.message });
    }
  });
  contracts.set(validator, owned);
  // The refinement establishes JSON ownership and delegates every schema assertion
  // to the validator compiled from that same captured schema. No transformations.
  return validator as z.ZodType<JsonValue>;
}

export function registeredJsonSchema(schema: z.core.$ZodType): JsonObject | undefined { return contracts.get(schema); }

/** Preserve an owned schema's local references when embedding it at a JSON path. */
export function embedJsonSchema(schema: JsonObject, path: readonly string[]): JsonObject {
  const segments: readonly string[] = path;
  if (!Array.isArray(path) || path.length > 64 || path.some(segment => typeof segment !== 'string'))
    throw new TypeError('JSON Schema embedding requires a bounded path of property names.');
  const prefix = segments.map(segment => `/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
  return parseJsonObject(rewriteReferences(parseJsonObject(schema, limits), prefix), limits);
}

/** One exporter for Zod contracts and exact externally compiled schema resources. */
export function exportToolJsonSchema(schema: z.ZodType, normalizeDefaults: boolean): Record<string, unknown> {
  const owned = contracts.get(schema);
  if (owned) return { ...owned };
  const external = new Map<string, JsonObject>();
  const result = { ...z.toJSONSchema(schema, { io: 'output', override(context) {
    const contract = contracts.get(context.zodSchema);
    if (!contract) return;
    const name = `external_${hashJson(contract)}`;
    external.set(name, contract);
    for (const key of Object.keys(context.jsonSchema)) Reflect.deleteProperty(context.jsonSchema, key);
    context.jsonSchema.$ref = `#/$defs/${name}`;
  } }) };
  delete result.$schema;
  const output = normalizeDefaults ? normalizeJsonSchema(result) : result;
  if (!object(output)) throw new TypeError('Tool schema export must produce an object.');
  if (external.size) {
    const defs: Record<string, unknown> = object(output.$defs) ? { ...output.$defs } : {};
    for (const [name, contract] of external) {
      if (Object.hasOwn(defs, name)) throw new TypeError('JSON Schema definition identity collision.');
      defs[name] = embedJsonSchema(contract, ['$defs', name]);
    }
    output.$defs = defs;
  }
  return output;
}

const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const children = new Set(['additionalProperties', 'unevaluatedProperties', 'items', 'additionalItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'unevaluatedItems', 'contentSchema']);
const alternatives = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
/** Rebase schema references only; literal const/enum/default/example data is untouched. */
function rewriteReferences(schema: JsonObject, prefix: string): JsonObject {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema' && value !== 'https://json-schema.org/draft/2020-12/schema')
      throw new TypeError('Portable external JSON Schema must use draft 2020-12.');
    if (['$id', '$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveRef', '$recursiveAnchor'].includes(key))
      throw new TypeError('Portable external JSON Schema supports local pointer references without separate resources or dynamic anchors.');
    if (key === '$ref') {
      if (typeof value !== 'string' || (value !== '#' && !value.startsWith('#/')))
        throw new TypeError('Portable external JSON Schema references must be local JSON pointers.');
      output[key] = `#${prefix}${value.slice(1)}`;
    } else if (maps.has(key) && object(value)) {
      output[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, schemaChild(child, prefix)]));
    } else if (children.has(key)) output[key] = schemaChild(value, prefix);
    else if (alternatives.has(key) && Array.isArray(value)) {
      const values: readonly JsonValue[] = value;
      output[key] = values.map(child => schemaChild(child, prefix));
    }
    else output[key] = value;
  }
  return output;
}
function schemaChild(value: JsonValue, prefix: string): JsonValue {
  return object(value) ? rewriteReferences(value, prefix) : value;
}
function normalizeJsonSchema(value: unknown): unknown {
  if (!object(value)) return value;
  const normalized = Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (maps.has(key) && object(item))
      return [key, Object.fromEntries(Object.entries(item).map(([name, child]) => [name, normalizeJsonSchema(child)]))];
    if (children.has(key)) return [key, normalizeJsonSchema(item)];
    if (alternatives.has(key) && Array.isArray(item)) return [key, item.map(normalizeJsonSchema)];
    return [key, item];
  }));
  const properties = normalized.properties;
  if (object(properties) && Array.isArray(normalized.required)) {
    const required = normalized.required.filter((item): item is string => typeof item === 'string' &&
      !(object(properties[item]) && Object.hasOwn(properties[item], 'default')));
    if (required.length > 0) normalized.required = required;
    else delete normalized.required;
  }
  return normalized;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
