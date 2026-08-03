import { createHash } from 'node:crypto';

export type EventActor = 'user' | 'runtime' | 'model' | 'tool' | 'system' | 'check';

export interface TypedEvent {
  type: string;
}

export interface EventEnvelope<TEvent extends TypedEvent = TypedEvent> {
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  schemaVersion: string;
  actor: EventActor;
  causationId?: string;
  correlationId?: string;
  idempotencyKey?: string;
  previousHash?: string;
  hash: string;
  event: TEvent;
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

export function hashRecord(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}
