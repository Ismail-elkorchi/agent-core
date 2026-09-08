import { parseJsonObject } from '@agent-core/json';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import type { BaseSessionEntry, SessionSteeringEntry } from './contracts.js';
import { decodeSessionInputRelationship, ownSessionSubmissionInput } from './submission-lifecycle.js';

type SteeringInput = Omit<SessionSteeringEntry, keyof BaseSessionEntry | 'type'>;

export function ownSessionSteeringInput(input: SteeringInput): SteeringInput {
  const value = parseJsonObject(input);
  if (
    typeof value.runId !== 'string' ||
    !value.runId ||
    typeof value.content !== 'string' ||
    !value.content.trim() ||
    (value.deliveryId !== undefined && (typeof value.deliveryId !== 'string' || !value.deliveryId))
  ) {
    throw new TypeError('Steering requires original content and valid run/delivery identities.');
  }
  return Object.freeze({
    runId: value.runId,
    content: value.content,
    ...(value.deliveryId === undefined ? {} : { deliveryId: value.deliveryId }),
    ...(value.originalInput === undefined
      ? {}
      : { originalInput: ownSessionSubmissionInput(value.originalInput) }),
    ...(value.relationship === undefined
      ? {}
      : { relationship: decodeSessionInputRelationship(value.relationship) })
  });
}

export function sameSessionSteering(
  existing: SessionSteeringEntry,
  input: SteeringInput
): SessionSteeringEntry {
  if (hashJson(parseJsonObject(ownSessionSteeringInput(existing))) !== hashJson(parseJsonObject(input)))
    throw new PersistenceConflictError('Steering delivery identity has conflicting original input.');
  return existing;
}
