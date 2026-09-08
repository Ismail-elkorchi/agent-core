export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface SafeJsonParseLimits {
  readonly maxDepth: number;
  readonly maxCollectionEntries: number;
  readonly maxStringBytes: number;
  readonly maxTotalBytes: number;
}
export const DEFAULT_SAFE_JSON_PARSE_LIMITS: SafeJsonParseLimits = Object.freeze({
  maxDepth: 32,
  maxCollectionEntries: 20_000,
  maxStringBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024
});

interface JsonShape {
  entries: number;
  maxStringBytes: number;
  depth: number;
  totalBytes: number;
}
interface Snapshot {
  readonly value: JsonValue;
  readonly shape: JsonShape;
}
const ownedSnapshots = new WeakMap<object, JsonShape>();

/** Only snapshots captured here carry an ownership proof; Object.freeze alone is insufficient. */
export function isOwnedJsonValue(value: unknown): value is JsonObject | readonly JsonValue[] {
  return value !== null && typeof value === 'object' && ownedSnapshots.has(value);
}

/** Captures external JSON once, without invoking accessors or coercing unsupported values. */
export function parseJsonValue(input: unknown, requested: Partial<SafeJsonParseLimits> = {}): JsonValue {
  const limits = { ...DEFAULT_SAFE_JSON_PARSE_LIMITS, ...requested };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`JSON limit ${name} must be a positive safe integer.`);
  }
  let entries = 0;
  let bytes = 0;
  const ancestors = new WeakSet();
  function charge(size: number, count = 0): void {
    bytes += size;
    entries += count;
    if (bytes > limits.maxTotalBytes) throw new TypeError('JSON value exceeds the total byte limit.');
    if (entries > limits.maxCollectionEntries)
      throw new TypeError('JSON value exceeds the collection limit.');
  }
  function stringSize(value: string): number {
    // UTF-16 length is a lower bound on UTF-8 bytes, including replacement of lone surrogates.
    if (value.length > limits.maxStringBytes)
      throw new TypeError('JSON value exceeds the string byte limit.');
    if (value.length > limits.maxTotalBytes - bytes)
      throw new TypeError('JSON value exceeds the total byte limit.');
    const size = utf8Bytes(value);
    if (size > limits.maxStringBytes) throw new TypeError('JSON value exceeds the string byte limit.');
    return size;
  }
  function capture(value: unknown, depth: number): Snapshot {
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string'
    ) {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new TypeError('JSON contains a non-finite number.');
      const maxStringBytes = typeof value === 'string' ? stringSize(value) : 0;
      const totalBytes = utf8Bytes(JSON.stringify(value));
      charge(totalBytes);
      return { value, shape: { entries: 0, maxStringBytes, depth: 0, totalBytes } };
    }
    if (typeof value !== 'object') throw new TypeError('JSON contains a non-JSON value.');
    const proof = ownedSnapshots.get(value);
    if (proof) {
      if (depth + proof.depth > limits.maxDepth) throw new TypeError('JSON exceeds the depth limit.');
      if (proof.maxStringBytes > limits.maxStringBytes)
        throw new TypeError('JSON exceeds the string byte limit.');
      charge(proof.totalBytes, proof.entries);
      return { value: value as JsonObject | readonly JsonValue[], shape: proof };
    }
    if (depth >= limits.maxDepth) throw new TypeError('JSON exceeds the depth limit.');
    if (ancestors.has(value)) throw new TypeError('JSON contains a cycle.');
    ancestors.add(value);
    const shape: JsonShape = { entries: 0, maxStringBytes: 0, depth: 1, totalBytes: 2 };
    charge(2);
    function child(input: unknown, keyBytes: number, keySize: number): JsonValue {
      const punctuation = keyBytes + (shape.entries === 0 ? 0 : 1);
      charge(punctuation, 1);
      const nested = capture(input, depth + 1);
      shape.entries += nested.shape.entries + 1;
      shape.totalBytes += punctuation + nested.shape.totalBytes;
      shape.depth = Math.max(shape.depth, nested.shape.depth + 1);
      shape.maxStringBytes = Math.max(shape.maxStringBytes, keySize, nested.shape.maxStringBytes);
      return nested.value;
    }
    let output: JsonObject | readonly JsonValue[];
    if (Array.isArray(value)) {
      const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
        throw new TypeError('Invalid JSON array length.');
      if (entries + length > limits.maxCollectionEntries)
        throw new TypeError('JSON exceeds the collection limit.');
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== length + 1 ||
        keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)))
      )
        throw new TypeError('JSON arrays must be dense and have no extra properties.');
      const items: JsonValue[] = [];
      for (let index = 0; index < length; index += 1)
        items.push(child(dataProperty(value, String(index)), 0, 0));
      output = Object.freeze(items);
    } else {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('JSON requires a plain object prototype.');
      const keys = Reflect.ownKeys(value);
      if (entries + keys.length > limits.maxCollectionEntries)
        throw new TypeError('JSON exceeds the collection limit.');
      if (keys.some((key) => typeof key !== 'string')) throw new TypeError('JSON contains a symbol key.');
      const record: JsonObject = {};
      for (const key of (keys as string[]).sort()) {
        const keySize = stringSize(key);
        const nested = child(dataProperty(value, key), utf8Bytes(JSON.stringify(key)) + 1, keySize);
        Object.defineProperty(record, key, { value: nested, enumerable: true });
      }
      output = Object.freeze(record);
    }
    ancestors.delete(value);
    ownedSnapshots.set(output, shape);
    return { value: output, shape };
  }
  return capture(input, 0).value;
}

export function parseJsonObject(input: unknown, requested: Partial<SafeJsonParseLimits> = {}): JsonObject {
  const value = parseJsonValue(input, requested);
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new TypeError('JSON value must be an object.');
  return value as JsonObject;
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !('value' in descriptor))
    throw new TypeError('JSON properties must be enumerable data properties, without accessors.');
  return descriptor.value;
}

const utf8Encoder = new TextEncoder();
const utf8Scratch = new Uint8Array(64 * 1024);

function utf8Bytes(value: string): number {
  let consumed = 0;
  let bytes = 0;
  while (consumed < value.length) {
    const chunk = utf8Encoder.encodeInto(value.slice(consumed), utf8Scratch);
    consumed += chunk.read;
    bytes += chunk.written;
  }
  return bytes;
}
