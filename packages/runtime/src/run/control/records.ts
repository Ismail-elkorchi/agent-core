import {
  decodeStoredToolObservation,
  resolveToolObservation,
  resolveToolModelContent
} from '../../orchestration/observation-source.js';
import {
  canonicalJsonString,
  parseJsonObject,
  parseJsonValue,
  type JsonObject
} from '@agent-core/json';
import {
  validatePublicArtifactRef,
  decodeOwnedArtifactRef,
  type ArtifactRef,
  type ArtifactRepository
} from '@agent-core/persistence';
import { decodeOwnedToolPhase, type AgentToolPhase } from './tool-state.js';
import { encodeToolObservation } from '@agent-core/tools';

/** Protected, run-scoped original material. Artifacts outlive every operational reference. */
export interface AgentRunRecordRef {
  readonly runId: string;
  readonly kind:
    | 'tool_call'
    | 'tool_source'
    | 'tool_plan'
    | 'tool_approval'
    | 'tool_input'
    | 'tool_settlement'
    | 'tool_effect';
  readonly artifact: ArtifactRef;
}
export interface AgentToolWorkRecord {
  readonly source: AgentRunRecordRef;
  readonly calls: readonly JsonObject[];
}

export function decodeAgentRunRecordRef(value: unknown): AgentRunRecordRef {
  const record = parseJsonObject(value);
  if (
    Object.keys(record).some((key) => !['runId', 'kind', 'artifact'].includes(key)) ||
    typeof record.runId !== 'string' ||
    !record.runId
  )
    throw new TypeError('Invalid run record reference.');
  const artifact = decodeOwnedArtifactRef(parseJsonObject(record.artifact));
  if (artifact.visibility !== 'protected')
    throw new TypeError('Run control records require protected storage.');
  const kind = record.kind;
  if (
    kind !== 'tool_call' &&
    kind !== 'tool_source' &&
    kind !== 'tool_plan' &&
    kind !== 'tool_approval' &&
    kind !== 'tool_input' &&
    kind !== 'tool_settlement' &&
    kind !== 'tool_effect'
  )
    throw new TypeError('Invalid run record kind.');
  return Object.freeze({ runId: record.runId, kind, artifact });
}

export class AgentRunRecordStorageError extends Error {
  constructor(
    readonly runId: string,
    readonly recordKind: AgentRunRecordRef['kind'],
    cause: unknown
  ) {
    super(`Immutable ${recordKind} storage failed for run ${runId}.`, { cause });
    this.name = 'AgentRunRecordStorageError';
  }
}

export class AgentRunRecords {
  constructor(readonly artifacts: ArtifactRepository) {}

  async store(
    runId: string,
    kind: AgentRunRecordRef['kind'],
    value: unknown
  ): Promise<AgentRunRecordRef> {
    // Each original has its own input bound. No aggregate historical quota is applied.
    const envelope = parseJsonObject({ runId, kind, value });
    const artifact = await this.artifacts
      .storeProtected({
        label: `run-${kind}`,
        mediaType: 'application/json',
        content: new TextEncoder().encode(canonicalJsonString(envelope))
      })
      .catch((cause: unknown) => {
        throw new AgentRunRecordStorageError(runId, kind, cause);
      });
    return Object.freeze({ runId, kind, artifact });
  }

  async read(
    runId: string,
    kind: AgentRunRecordRef['kind'],
    reference: AgentRunRecordRef
  ): Promise<import('@agent-core/json').JsonValue> {
    if (
      reference.runId !== runId ||
      reference.kind !== kind ||
      reference.artifact.visibility !== 'protected'
    )
      throw new Error('Run record is outside the requested authority scope.');
    if (reference.artifact.size > 4 * 1024 * 1024)
      throw new Error('Run record exceeds its independent byte bound.');
    const envelope = parseJsonObject(
      JSON.parse(new TextDecoder().decode(await this.artifacts.readVerified(reference.artifact)))
    );
    if (
      envelope.runId !== runId ||
      envelope.kind !== kind ||
      Object.keys(envelope).some((key) => !['runId', 'kind', 'value'].includes(key))
    )
      throw new Error('Run record scope or kind does not match its immutable reference.');
    if (envelope.value === undefined) throw new TypeError('Run record has no original value.');
    return envelope.value;
  }

  async storeTools(runId: string, batch: AgentToolPhase): Promise<AgentToolWorkRecord> {
    const { callStates, ...source } = batch;
    const calls: JsonObject[] = [];
    for (const call of callStates) {
      const record = new Map<string, unknown>(Object.entries(call));
      for (const [field, kind] of materialFields) {
        const value = record.get(field);
        if (value === undefined) continue;
        let material: unknown = value;
        if (field === 'plan' || field === 'approval')
          material = await this.storeInput(runId, field, value);
        if (field === 'settlement' && 'settlement' in call) {
          const settlement = call.settlement;
          material = Object.fromEntries(
            Object.entries(settlement).filter(
              ([key]) =>
                key !== 'observation' && !(key === 'modelContent' && settlement.modelContentRef)
            )
          );
        }
        if (field === 'approved') {
          const approved = parseJsonObject(value);
          material = {
            ...approved,
            approval: await this.storeInput(runId, 'approval', approved.approval)
          };
        }
        record.set(`${field}Ref`, parseJsonObject(await this.store(runId, kind, material)));
        record.delete(field);
      }
      calls.push(parseJsonObject(Object.fromEntries(record)));
    }
    const storeCall = async (call: { readonly input: unknown }) => {
      const { input, ...identity } = call;
      return { ...identity, inputRef: await this.store(runId, 'tool_input', input) };
    };
    const sourceRecord = {
      ...source,
      calls: await Promise.all(source.calls.map(storeCall)),
      modelCalls: await Promise.all(source.modelCalls.map(storeCall))
    };
    return Object.freeze({
      source: await this.store(runId, 'tool_source', sourceRecord),
      calls: Object.freeze(calls)
    });
  }

  async loadTools(runId: string, record: AgentToolWorkRecord): Promise<AgentToolPhase> {
    const storedSource = parseJsonObject(await this.read(runId, 'tool_source', record.source));
    const loadCalls = async (values: unknown) => {
      if (!Array.isArray(values))
        throw new TypeError('Tool source requires immutable original calls.');
      return Promise.all(
        values.map(async (value) => {
          const { inputRef, ...identity } = parseJsonObject(value);
          const input = await this.read(runId, 'tool_input', decodeAgentRunRecordRef(inputRef));
          return { ...identity, input };
        })
      );
    };
    const source = {
      ...storedSource,
      calls: await loadCalls(storedSource.calls),
      modelCalls: await loadCalls(storedSource.modelCalls)
    };
    const callStates: JsonObject[] = [];
    for (const stored of record.calls) {
      const call = { ...stored };
      if (call.stage === 'resolved') {
        const original = parseJsonObject(
          await this.read(runId, 'tool_call', decodeAgentRunRecordRef(call.record))
        );
        const originalSource = decodeAgentRunRecordRef(original.source);
        const originalCall = parseJsonObject(original.call);
        if (
          original.callIndex !== callStates.length ||
          originalSource.artifact.sha256 !== record.source.artifact.sha256 ||
          originalCall.stage !== 'recorded' ||
          (parseJsonObject(storedSource.source).nativeCatalogIdentity !== undefined &&
            parseJsonObject(originalCall.delivery).status !== 'applied')
        )
          throw new Error(
            'Resolved tool reference does not prove original recording and delivery.'
          );
      }

      for (const [field, kind] of materialFields) {
        const ref = call[`${field}Ref`];
        if (ref === undefined) continue;
        let value = await this.read(runId, kind, decodeAgentRunRecordRef(ref));
        if (field === 'plan' || field === 'approval')
          value = await this.loadInput(runId, field, value);
        if (field === 'settlement') {
          const settlement = parseJsonObject(value);
          const original = decodeStoredToolObservation(settlement.original);
          const content =
            settlement.modelContentRef === undefined
              ? undefined
              : parseJsonValue(
                  await resolveToolModelContent(
                    { modelContentRef: decodePublicContentRef(settlement.modelContentRef) },
                    this.artifacts
                  ),
                  {
                    maxDepth: 40,
                    maxCollectionEntries: 100000,
                    maxStringBytes: 16000000,
                    maxTotalBytes: 16000000
                  }
                );
          value = {
            ...settlement,
            ...(original.storage === 'unavailable'
              ? {}
              : {
                  observation: encodeToolObservation(
                    await resolveToolObservation(original, this.artifacts)
                  )
                }),
            ...(content === undefined ? {} : { modelContent: content })
          };
        }
        if (field === 'approved') {
          const approved = parseJsonObject(value);
          value = {
            ...approved,
            approval: await this.loadInput(runId, 'approval', approved.approval)
          };
        }
        call[field] = value;
      }
      callStates.push(
        Object.fromEntries(
          Object.entries(call).filter(
            ([key]) => !materialFields.some(([field]) => key === `${field}Ref`)
          )
        )
      );
    }
    return decodeOwnedToolPhase({ ...source, callStates });
  }

  private async storeInput(runId: string, field: string, value: unknown): Promise<JsonObject> {
    const record = { ...parseJsonObject(value) };
    const key = field === 'plan' ? 'canonicalInput' : 'input';
    const inputRef = await this.store(runId, 'tool_input', record[key]);
    if (field === 'plan') delete record.canonicalInput;
    else delete record.input;
    if (field === 'plan' && record.approval !== undefined)
      record.approval = await this.storeInput(runId, 'approval', record.approval);
    return { ...record, inputRef: parseJsonObject(inputRef) };
  }

  private async loadInput(runId: string, field: string, value: unknown): Promise<JsonObject> {
    const record = { ...parseJsonObject(value) };
    const input = await this.read(runId, 'tool_input', decodeAgentRunRecordRef(record.inputRef));
    delete record.inputRef;
    if (field === 'plan' && record.approval !== undefined)
      record.approval = await this.loadInput(runId, 'approval', record.approval);
    return parseJsonObject({ ...record, [field === 'plan' ? 'canonicalInput' : 'input']: input });
  }
}

const materialFields = [
  ['plan', 'tool_plan'],
  ['approval', 'tool_approval'],
  ['approved', 'tool_approval'],
  ['settlement', 'tool_settlement'],
  ['effect', 'tool_effect']
] as const;

export function decodeAgentToolWorkRecord(value: unknown): AgentToolWorkRecord {
  const record = parseJsonObject(value);
  if (
    Object.keys(record).some((key) => !['source', 'calls'].includes(key)) ||
    !Array.isArray(record.calls)
  )
    throw new TypeError(
      'Incompatible persisted tool work: immutable source and call record references are required; start a new run and retain old data.'
    );
  const source = decodeAgentRunRecordRef(record.source);
  const calls = record.calls.map((value) => {
    const call = parseJsonObject(value);
    const allowed = [
      'stage',
      'toolAttempt',
      'delivery',
      'record',
      ...materialFields.map(([field]) => `${field}Ref`)
    ];
    if (Object.keys(call).some((key) => !allowed.includes(key)))
      throw new TypeError(
        'Obsolete inline tool material is not supported; retain the original run data.'
      );
    for (const [field] of materialFields)
      if (call[`${field}Ref`] !== undefined) decodeAgentRunRecordRef(call[`${field}Ref`]);
    return call;
  });
  return Object.freeze({ source, calls: Object.freeze(calls) });
}

function decodePublicContentRef(
  value: unknown
): import('@agent-core/persistence').PublicArtifactRef {
  const ref = parseJsonObject(value);
  validatePublicArtifactRef(ref);
  return ref;
}
