import { decodeToolContent } from '@agent-core/tools';
import { parseJsonObject, parseJsonValue } from '@agent-core/json';
import { validateArtifactRef } from '@agent-core/persistence';
import type { AgentTurnIdentity, AgentToolCallAttemptIdentity } from '../run/contracts.js';
import type {
  BaseSessionEntry,
  SessionObservationEntry,
  SessionObservationInput
} from './contracts.js';

export function captureObservationInput(input: {
  runId: string;
  identity: AgentTurnIdentity &
    Partial<
      Pick<AgentToolCallAttemptIdentity, 'toolBatchId' | 'callIndex' | 'callId' | 'toolAttempt'>
    >;
  toolName: string;
  observation: SessionObservationInput;
}): Omit<SessionObservationEntry, keyof BaseSessionEntry | 'type'> {
  if ('ok' in input.observation)
    throw new Error('Session observation contains an unsupported ok field.');
  if (input.observation.originalArtifact) validateArtifactRef(input.observation.originalArtifact);
  if (input.observation.modelContentRef) validateArtifactRef(input.observation.modelContentRef);
  if (input.observation.modelContent && input.observation.modelContentRef)
    throw new Error('Conflicting model content representations.');
  const artifacts = input.observation.artifacts?.map((artifact) => {
    validateArtifactRef(artifact);
    return Object.freeze({ ...artifact });
  });
  return {
    runId: input.runId,
    ...input.identity,
    toolName: input.toolName,
    kind: input.observation.kind,
    ...(input.observation.originalUnavailable
      ? { originalUnavailable: Object.freeze({ ...input.observation.originalUnavailable }) }
      : {}),
    ...(input.observation.modelContentRef
      ? { modelContentRef: input.observation.modelContentRef }
      : {}),
    ...(input.observation.originalArtifact
      ? { originalArtifact: input.observation.originalArtifact }
      : {}),
    ...(input.observation.modelContent
      ? { modelContent: decodeToolContent(input.observation.modelContent) }
      : {}),
    summary: input.observation.summary,
    ...(input.observation.output === undefined
      ? {}
      : { output: parseJsonValue(input.observation.output) }),
    ...(artifacts && artifacts.length > 0 ? { artifacts: Object.freeze(artifacts) } : {}),
    ...(input.observation.metadata ? { metadata: parseJsonObject(input.observation.metadata) } : {})
  };
}
