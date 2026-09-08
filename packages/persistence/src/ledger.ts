import { createHash } from 'node:crypto';
import { canonicalJsonString } from '@agent-core/json';

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
  readonly driverGeneration: number;
  readonly event: TEvent;
}

export interface EventAppendReceipt {
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
  readonly driverGeneration: number;
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

export function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalJsonString(value)).digest('hex');
}
