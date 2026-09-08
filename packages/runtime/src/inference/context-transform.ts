import { decodeOwnedArtifactRef, type ArtifactRef, type ArtifactRepository } from '@agent-core/persistence';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { parseModelContextTransformResult, type ModelInputItem } from '@agent-core/model';
import type { HistorySourceRef, HistoryView } from '../history/contracts.js';
import { sourceSchema } from '../history/schema.js';
import { sourceRef, sameHistorySource } from '../history/reader.js';

export interface ContextTransformReference {
  readonly format: 'agent-core.context-transform/1';
  readonly ownerId: string;
  readonly invocationId: string;
  readonly transformId: string;
  readonly artifact: ArtifactRef;
  readonly sources: readonly HistorySourceRef[];
}
export function encodeContextTransformReference(value: ContextTransformReference): JsonObject {
  return parseJsonObject(value);
}
function decodeReference(value: unknown): ContextTransformReference {
  const object = parseJsonObject(value);
  if (
    Object.keys(object).some(
      (key) => !['format', 'ownerId', 'invocationId', 'transformId', 'artifact', 'sources'].includes(key)
    ) ||
    object.format !== 'agent-core.context-transform/1' ||
    typeof object.ownerId !== 'string' ||
    !object.ownerId ||
    typeof object.invocationId !== 'string' ||
    !object.invocationId ||
    typeof object.transformId !== 'string' ||
    !object.transformId ||
    !Array.isArray(object.sources)
  )
    throw new Error('Invalid committed context transform reference.');
  return Object.freeze({
    format: object.format,
    ownerId: object.ownerId,
    invocationId: object.invocationId,
    transformId: object.transformId,
    artifact: decodeOwnedArtifactRef(parseJsonObject(object.artifact)),
    sources: Object.freeze(object.sources.map((item) => sourceSchema.parse(item)))
  });
}
/** The committed window contains a protected artifact reference, never model-readable opaque payloads. */
export async function readTransformedContext(input: {
  readonly view: HistoryView;
  readonly artifacts: ArtifactRepository;
  readonly provider: string;
  readonly model: string;
}): Promise<{
  readonly input: readonly ModelInputItem[];
  readonly represented: ReadonlySet<string>;
}> {
  const window = input.view.contextWindow;
  if (window?.selection.strategy !== 'provider') return { input: [], represented: new Set() };
  const reference = decodeReference(window.selection.providerState);
  if (reference.artifact.visibility !== 'protected')
    throw new Error('Context transform protocol artifact must be protected.');
  const retained = new Map(window.selection.retained.map((ref) => [ref.entryId, ref]));
  const actual = new Map(
    input.view.entries.map((entry) => {
      const ref = sourceRef(input.view.cut.sessionId, entry);
      return [ref.entryId, ref] as const;
    })
  );
  const represented = new Set<string>();
  for (const source of reference.sources) {
    const selected = retained.get(source.entryId);
    const original = actual.get(source.entryId);
    if (
      !selected ||
      !original ||
      !sameHistorySource(source, selected) ||
      !sameHistorySource(source, original) ||
      represented.has(source.entryId)
    )
      throw new Error('Context transform source identity is unavailable or changed.');
    represented.add(source.entryId);
  }
  const result = parseModelContextTransformResult(
    JSON.parse(new TextDecoder().decode(await input.artifacts.readVerified(reference.artifact))) as unknown
  );
  if (
    result.transformId !== reference.transformId ||
    result.state.provider !== input.provider ||
    result.state.model !== input.model
  )
    throw new Error('Context transform changed its admitted model or identity.');
  return Object.freeze({ input: result.input, represented });
}
