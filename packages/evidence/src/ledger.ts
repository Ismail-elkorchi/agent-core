import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue } from '@agent-core/json';

export type EventActor = 'user' | 'runtime' | 'model' | 'tool' | 'system' | 'check';

export interface TypedEvent {
  type: string;
}

export interface EventEnvelope<TEvent extends TypedEvent = TypedEvent> {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly schemaVersion: string;
  readonly actor: EventActor;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly previousHash?: string;
  readonly hash: string;
  readonly event: TEvent & JsonObject;
}

export interface AppendEventOptions {
  actor?: EventActor;
  causationId?: string;
  correlationId?: string;
  timestamp?: string;
}

export interface LedgerIntegrityReport {
  ok: boolean;
  records: number;
  errors: string[];
}

export function hashJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalJsonString(value)).digest('hex');
}

export function canonicalJsonString(value: JsonValue): string {
  return canonicalJson(value, '$', new WeakSet());
}

function canonicalJson(value: unknown, path: string, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number.`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError(`${path} is outside the canonical JSON domain.`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value as object, String(index));
        if (!descriptor || !('value' in descriptor)) throw new TypeError(`${path}[${String(index)}] is sparse or accessor-backed.`);
        entries.push(canonicalJson(descriptor.value as unknown, `${path}[${String(index)}]`, ancestors));
      }
      if (Reflect.ownKeys(value).some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)))) throw new TypeError(`${path} has non-JSON array properties.`);
      return `[${entries.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain JSON object.`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) throw new TypeError(`${path} has symbol properties.`);
    const stringKeys: string[] = [];
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError(`${path} has symbol properties.`);
      stringKeys.push(key);
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError(`${path}.${key} is non-enumerable or accessor-backed.`);
    }
    stringKeys.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${stringKeys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) throw new TypeError(`${path}.${key} is accessor-backed.`);
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value as unknown, `${path}.${key}`, ancestors)}`;
    }).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
