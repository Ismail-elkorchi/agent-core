import { isOwnedJsonValue } from './value.js';

const canonicalSnapshots = new WeakMap<object, string>();
const MAX_CACHED_CANONICAL_LENGTH = 8 * 1024;

/** Exact, deterministic JSON encoding. Rejects values outside JSON instead of coercing or truncating them. */
export function canonicalJsonString(value: unknown): string {
  return canonicalJson(value, '$', new WeakSet());
}

function canonicalJson(value: unknown, path: string, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number.`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError(`${path} is outside the canonical JSON domain.`);
  const owned = isOwnedJsonValue(value);
  const cached = owned ? canonicalSnapshots.get(value) : undefined;
  if (cached !== undefined) return cached;
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
        throw new TypeError(`${path} has an invalid array length.`);
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== length + 1 ||
        keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)))
      )
        throw new TypeError(`${path} is sparse or has non-JSON array properties.`);
      const entries: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value as object, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new TypeError(`${path}[${String(index)}] is sparse or accessor-backed.`);
        entries.push(canonicalJson(descriptor.value as unknown, `${path}[${String(index)}]`, ancestors));
      }
      return rememberCanonical(value, `[${entries.join(',')}]`, owned);
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${path} must be a plain JSON object.`);
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError(`${path} has symbol properties.`);
      keys.push(key);
    }
    const entries: string[] = [];
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new TypeError(`${path}.${key} is non-enumerable or accessor-backed.`);
      entries.push(
        `${JSON.stringify(key)}:${canonicalJson(descriptor.value as unknown, `${path}.${key}`, ancestors)}`
      );
    }
    const text = `{${entries.join(',')}}`;
    return rememberCanonical(value, text, owned);
  } finally {
    ancestors.delete(value);
  }
}

function rememberCanonical(value: object, text: string, owned: boolean): string {
  if (owned && text.length <= MAX_CACHED_CANONICAL_LENGTH) canonicalSnapshots.set(value, text);
  return text;
}
