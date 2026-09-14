import { parseJsonObject, type JsonObject } from '@agent-core/json';
import {
  hashJson,
  validatePublicArtifactRef,
  type PublicArtifactRef,
  type ArtifactRepository
} from '@agent-core/persistence';
import {
  decodeToolContent,
  decodeOwnedToolObservationForPersistence,
  encodeToolObservation,
  type ToolObservation
} from '@agent-core/tools';

/** Address of the original structured observation, independent of delivered content. */
interface StoredObservationIdentity {
  readonly kind: ToolObservation['kind'];
  readonly summary: string;
  readonly digest: string;
  readonly coverage: 'complete' | 'partial';
  readonly execution?: import('@agent-core/tools').ToolExecutionObservation;
}
export type StoredToolObservation = StoredObservationIdentity &
  (
    | { readonly storage: 'inline'; readonly observation: ToolObservation }
    | { readonly storage: 'artifact'; readonly artifact: PublicArtifactRef }
    | { readonly storage: 'unavailable'; readonly bytes: number; readonly message: string }
  );

export function storedToolObservation(
  observation: ToolObservation,
  artifact?: PublicArtifactRef
): StoredToolObservation {
  const common = {
    kind: observation.kind,
    summary: observation.summary,
    digest: hashJson(encodeToolObservation(observation)),
    coverage: observation.scope.coverage,
    ...(observation.execution ? { execution: observation.execution } : {})
  };
  return Object.freeze(
    artifact
      ? { ...common, storage: 'artifact', artifact }
      : { ...common, storage: 'inline', observation }
  );
}
export function encodeStoredToolObservation(value: StoredToolObservation): JsonObject {
  const { storage, ...common } = value;
  return parseJsonObject(
    value.storage === 'inline'
      ? { ...common, storage, observation: encodeToolObservation(value.observation) }
      : value,
    { maxDepth: 40, maxCollectionEntries: 100000, maxStringBytes: 8000000, maxTotalBytes: 16000000 }
  );
}
export function decodeStoredToolObservation(value: unknown): StoredToolObservation {
  const record = parseJsonObject(value, {
    maxDepth: 40,
    maxCollectionEntries: 100000,
    maxStringBytes: 8000000,
    maxTotalBytes: 16000000
  });
  if (
    typeof record.summary !== 'string' ||
    (record.kind !== 'result' && record.kind !== 'failure') ||
    typeof record.digest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.digest) ||
    (record.coverage !== 'complete' && record.coverage !== 'partial')
  )
    throw new Error('Invalid original observation identity.');
  const execution = decodeExecution(record.execution);
  const common: StoredObservationIdentity = {
    kind: record.kind,
    summary: record.summary,
    digest: record.digest,
    coverage: record.coverage,
    ...(execution ? { execution } : {})
  };
  const commonKeys = ['storage', 'kind', 'summary', 'digest', 'coverage', 'execution'];
  if (
    record.storage === 'inline' &&
    Object.keys(record).every((key) => [...commonKeys, 'observation'].includes(key))
  ) {
    const observation = decodeOwnedToolObservationForPersistence(
      parseJsonObject(record.observation, {
        maxDepth: 40,
        maxCollectionEntries: 100000,
        maxStringBytes: 8000000,
        maxTotalBytes: 16000000
      })
    );
    if (
      observation.kind !== record.kind ||
      observation.summary !== record.summary ||
      observation.scope.coverage !== record.coverage ||
      observation.execution?.state !== execution?.state ||
      hashJson(encodeToolObservation(observation)) !== record.digest
    )
      throw new Error('Original observation identity mismatch.');
    return storedToolObservation(observation);
  }
  if (
    record.storage === 'artifact' &&
    Object.keys(record).every((key) => [...commonKeys, 'artifact'].includes(key))
  ) {
    const artifact = parseJsonObject(record.artifact);
    validatePublicArtifactRef(artifact);
    return Object.freeze({ ...common, storage: 'artifact', artifact });
  }
  if (
    record.storage === 'unavailable' &&
    Object.keys(record).every((key) => [...commonKeys, 'bytes', 'message'].includes(key)) &&
    typeof record.bytes === 'number' &&
    Number.isSafeInteger(record.bytes) &&
    record.bytes >= 0 &&
    typeof record.message === 'string'
  )
    return Object.freeze({
      ...common,
      storage: 'unavailable',
      bytes: record.bytes,
      message: record.message
    });
  throw new Error('Incompatible stored observation: an explicit original source is required.');
}
export async function resolveToolObservation(
  source:
    | StoredToolObservation
    | Pick<
        Extract<StoredToolObservation, { storage: 'artifact' }>,
        'storage' | 'kind' | 'summary' | 'artifact'
      >,
  artifacts?: ArtifactRepository
): Promise<ToolObservation> {
  if (source.storage === 'inline') return source.observation;
  if (source.storage === 'unavailable')
    throw new Error(`Original observation unavailable: ${source.message}`);
  if (!artifacts) throw new Error('Original observation artifact storage is unavailable.');
  const observation = decodeOwnedToolObservationForPersistence(
    parseJsonObject(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await artifacts.readVerified(source.artifact)
        )
      ),
      {
        maxDepth: 40,
        maxCollectionEntries: 100000,
        maxStringBytes: 8000000,
        maxTotalBytes: 16000000
      }
    )
  );
  if (
    observation.kind !== source.kind ||
    observation.summary !== source.summary ||
    ('digest' in source &&
      (hashJson(encodeToolObservation(observation)) !== source.digest ||
        observation.scope.coverage !== source.coverage ||
        observation.execution?.state !== source.execution?.state))
  )
    throw new Error('Original observation identity mismatch.');
  return observation;
}

function decodeExecution(
  value: unknown
): import('@agent-core/tools').ToolExecutionObservation | undefined {
  if (value === undefined) return undefined;
  const record = parseJsonObject(value);
  if (Object.keys(record).length !== 1) throw new Error('Invalid original execution facts.');
  const state = record.state;
  if (state !== 'not_started' && state !== 'settled' && state !== 'active' && state !== 'unknown')
    throw new Error('Invalid original execution state.');
  return Object.freeze({ state });
}

export interface RecordedToolModelContent {
  readonly modelContent?: readonly import('@agent-core/tools').ToolContent[];
  readonly modelContentRef?: PublicArtifactRef;
}
export async function resolveToolModelContent(
  record: RecordedToolModelContent,
  artifacts?: ArtifactRepository
): Promise<readonly import('@agent-core/tools').ToolContent[]> {
  if (record.modelContent !== undefined && record.modelContentRef !== undefined)
    throw new Error('Model content has conflicting stored representations.');
  if (record.modelContent) return record.modelContent;
  if (!record.modelContentRef) throw new Error('Recorded model content is unavailable.');
  if (!artifacts) throw new Error('Recorded model content artifact storage is unavailable.');
  return decodeToolContent(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await artifacts.readVerified(record.modelContentRef)
      )
    )
  );
}
export function decodeRecordedToolModelContent(
  value: RecordedToolModelContent
): RecordedToolModelContent {
  if ((value.modelContent === undefined) === (value.modelContentRef === undefined))
    throw new Error('Exactly one recorded model content representation is required.');
  if (value.modelContentRef) {
    validatePublicArtifactRef(value.modelContentRef);
    return Object.freeze({ modelContentRef: Object.freeze({ ...value.modelContentRef }) });
  }
  return Object.freeze({ modelContent: decodeToolContent(value.modelContent) });
}
