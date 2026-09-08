import { parseJsonObject, parseJsonValue } from '@agent-core/json';
import { validateArtifactRef } from '@agent-core/persistence';
import type { AgentTurnIdentity, AgentToolCallAttemptIdentity } from '../run/contracts.js';
import type { BaseSessionEntry, SessionObservationEntry, SessionObservationInput } from './contracts.js';

export function captureObservationInput(input: {
  runId: string;
  identity: AgentTurnIdentity &
    Partial<Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>>;
  toolName: string;
  observation: SessionObservationInput;
}): Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'> {
  const artifacts = input.observation.artifacts?.map((artifact) => {
    validateArtifactRef(artifact);
    return Object.freeze({ ...artifact });
  });
  return {
    runId: input.runId,
    ...input.identity,
    toolName: input.toolName,
    ok: input.observation.ok,
    summary: input.observation.summary,
    ...(input.observation.output === undefined ? {} : { output: parseJsonValue(input.observation.output) }),
    ...(artifacts && artifacts.length > 0 ? { artifacts: Object.freeze(artifacts) } : {}),
    ...(input.observation.metadata ? { metadata: parseJsonObject(input.observation.metadata) } : {})
  };
}
