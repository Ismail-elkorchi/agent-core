import { parseJsonObject, type JsonObject } from '@agent-core/json';
import type { ArtifactRepository } from '@agent-core/persistence';
import { embedJsonSchema, encodeToolObservation } from '@agent-core/tools';
import type { AgentToolSettlementRecord } from '../run/control/tool-state.js';
import { resolveToolObservation } from './observation-source.js';

/** The same durable, redacted value is delivered to portable and provider-hosted programs. */
export async function createProgramResult(input: {
  readonly runId: string;
  readonly toolBatchId: string;
  readonly callId?: string;
  readonly toolName: string;
  readonly settlement: AgentToolSettlementRecord;
  readonly artifacts?: ArtifactRepository;
}): Promise<JsonObject> {
  const settled = input.settlement;
  const identity = { runId: input.runId, toolBatchId: input.toolBatchId,
    ...(input.callId ? { callId: input.callId } : {}), toolName: input.toolName,
    observationId: settled.observationId };
  const unavailable = (diagnostic: string) => parseJsonObject({
    receipt: { ...identity, status: 'unavailable', kind: settled.original.kind,
      summary: settled.original.summary, coverage: settled.original.coverage,
      execution: settled.original.execution ?? null, diagnostic: diagnostic.slice(0, 2000) }, observation: null
  });
  if (settled.original.storage === 'unavailable') return unavailable(settled.original.message);
  let observation;
  try { observation = settled.observation ?? await resolveToolObservation(settled.original, input.artifacts); }
  catch (error) { return unavailable(`Original observation could not be verified: ${error instanceof Error ? error.message : String(error)}`); }
  const encoded = encodeToolObservation(observation);
  let original = settled.original.storage === 'artifact' ? settled.original.artifact : undefined;
  let diagnostic: string | undefined;
  if (!original && input.artifacts) {
    try {
      original = await input.artifacts.store({ label: `${input.toolName}-program-observation`, mediaType: 'application/json',
        content: new TextEncoder().encode(JSON.stringify(encoded)), description: 'Durably redacted original program child observation.' });
    } catch (error) {
      diagnostic = `Original artifact copy unavailable; durable observation ${settled.observationId} remains recorded: ${(error instanceof Error ? error.message : String(error)).slice(0, 1000)}`;
    }
  }
  return parseJsonObject({ receipt: { ...identity, status: 'recorded', kind: observation.kind,
    summary: observation.summary, coverage: observation.scope.coverage, execution: observation.execution ?? null,
    ...(original ? { original } : {}), ...(diagnostic ? { diagnostic } : {}) }, observation: encoded },
  { maxDepth: 48, maxCollectionEntries: 100_000, maxStringBytes: 8_000_000, maxTotalBytes: 16_000_000 });
}

/** Public call-result schema, including host failures, redaction and unavailable original data. */
export function programResultSchema(outputJsonSchema: JsonObject): JsonObject {
  const execution = { type: 'object', properties: { state: { enum: ['not_started', 'settled', 'active', 'unknown'] } },
    required: ['state'], additionalProperties: false };
  const scope = { type: 'object', properties: { resources: { type: 'array', items: { type: 'string' } },
    coverage: { enum: ['complete', 'partial'] }, filters: { type: 'object' }, limits: { type: 'object' },
    omitted: { type: 'object' }, truncated: { type: 'boolean' }, causes: { type: 'array', items: { type: 'string' } } },
    required: ['resources', 'coverage'], additionalProperties: false };
  const observation = { type: 'object', properties: {
    kind: { enum: ['result', 'failure'] }, summary: { type: 'string' }, execution, scope, output: {},
    content: { type: 'array', items: { type: 'object' } }, metadata: { type: 'object' }, observedFacts: { type: 'object' }
  }, required: ['kind', 'summary', 'scope', 'output'], additionalProperties: false,
  anyOf: [
    { properties: { kind: { const: 'result' }, output: { $ref: '#/$defs/toolOutput' } } },
    { properties: { kind: { const: 'failure' }, output: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
    { properties: { kind: { const: 'result' }, execution: { properties: { state: { const: 'not_started' } } } }, required: ['execution'] },
    { properties: { metadata: { properties: { redactions: { type: 'integer', minimum: 1 } }, required: ['redactions'] } }, required: ['metadata'] }
  ] };
  return parseJsonObject({ type: 'object', properties: {
    receipt: { type: 'object', properties: {
      runId: { type: 'string' }, toolBatchId: { type: 'string' }, callId: { type: 'string' }, toolName: { type: 'string' },
      observationId: { type: 'string' }, status: { enum: ['recorded', 'unavailable'] }, kind: { enum: ['result', 'failure'] },
      summary: { type: 'string' }, coverage: { enum: ['complete', 'partial'] }, execution: { anyOf: [execution, { type: 'null' }] },
      original: { type: 'object' }, diagnostic: { type: 'string' }
    }, required: ['runId', 'toolBatchId', 'toolName', 'observationId', 'status', 'kind', 'summary', 'coverage', 'execution'], additionalProperties: false },
    observation: { anyOf: [observation, { type: 'null' }] }
  }, required: ['receipt', 'observation'], additionalProperties: false,
  $defs: { toolOutput: embedJsonSchema(outputJsonSchema, ['$defs', 'toolOutput']) } });
}
