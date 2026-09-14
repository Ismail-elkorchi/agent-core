import { storedToolObservation, type StoredToolObservation } from './observation-source.js';
import { randomUUID } from 'node:crypto';
import {
  redactJson,
  type ArtifactRepository,
  type PublicArtifactRef
} from '@agent-core/persistence';
import { parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import type { ModelImage } from '@agent-core/model';
import {
  decodeOwnedToolObservationForPersistence,
  encodeToolObservation,
  updateToolObservation,
  defaultToolModelContent,
  decodeToolContent,
  serializeToolModelContent,
  recordObservedFacts,
  type ObservedFactRecord,
  type ToolContent,
  type ToolCall,
  type ToolDefinition,
  type ToolObservation
} from '@agent-core/tools';

export interface CommittedToolObservation {
  readonly id: string;
  readonly turnIndex: number;
  readonly call: ToolCall;
  readonly toolName: string;
  readonly canonicalSnapshot?: JsonValue;
  readonly tool: ToolDefinition | undefined;
  readonly fullObservation?: ToolObservation;
  readonly original: StoredToolObservation;
  readonly durableObservation?: ToolObservation;
  readonly modelContent: readonly ToolContent[];
  readonly modelContentRef?: PublicArtifactRef;
  readonly canonicalArtifact?: PublicArtifactRef;
  readonly durableStorageDegraded?: { readonly message: string };
  readonly createdAt: string;
}
export interface ToolObservationRecord extends CommittedToolObservation {
  readonly modelText: string;
  readonly modelImages: readonly ModelImage[];
  readonly imageArtifacts: readonly PublicArtifactRef[];
  readonly observedFacts: readonly ObservedFactRecord[];
}

/** Original storage and delivered content have independent, explicit boundaries. */
export class ObservationStore {
  private readonly artifacts: ArtifactRepository | undefined;
  constructor(options: { readonly artifacts?: ArtifactRepository } = {}) {
    this.artifacts = options.artifacts;
  }
  async commitToolObservation(input: {
    readonly turnIndex: number;
    readonly call: ToolCall;
    readonly canonicalSnapshot?: JsonValue;
    readonly tool: ToolDefinition | undefined;
    readonly observation: ToolObservation;
    readonly modelInputModalities?: readonly string[];
  }): Promise<CommittedToolObservation> {
    const durableObservation = await transformToolObservationForDurability(input.observation);
    const bytes = new TextEncoder().encode(serializeObservation(durableObservation));
    let canonicalArtifact: PublicArtifactRef | undefined;
    let durableStorageDegraded: { readonly message: string } | undefined;
    if (bytes.byteLength > 256 * 1024) {
      try {
        if (!this.artifacts)
          throw new Error('Original observation artifact storage is unavailable.');
        canonicalArtifact = await this.artifacts.store({
          label: `${input.call.name}-observation`,
          content: bytes,
          mediaType: 'application/json',
          description: 'Original redacted structured observation.'
        });
      } catch (error) {
        durableStorageDegraded = Object.freeze({
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const modelInputModalities = input.modelInputModalities ?? ['text'];
    const observation = durableObservation;
    let selected: readonly ToolContent[];
    try {
      selected = decodeToolContent(
        input.tool?.buildModelContent
          ? input.tool.buildModelContent({
              call: input.call,
              input: input.canonicalSnapshot,
              observation
            })
          : defaultToolModelContent(observation)
      );
    } catch {
      // A formatter failure cannot change invocation or domain outcome.
      selected = defaultToolModelContent(observation);
    }
    const filtered = selected.map((part): ToolContent =>
      part.type === 'image' && !modelInputModalities.includes('image')
        ? { type: 'artifact', artifact: part.artifact }
        : part
    );
    const unsupported =
      selected.some((part) => part.type === 'image') && !modelInputModalities.includes('image');
    let modelContent = decodeToolContent(
      redactJson(
        parseJsonValue(
          [
            ...filtered,
            ...(typeof durableObservation.metadata?.redactions === 'number' &&
            durableObservation.metadata.redactions > 0
              ? [{ type: 'text', text: 'Sensitive values were redacted from this observation.' }]
              : []),
            ...(unsupported
              ? [
                  {
                    type: 'text',
                    text: 'Image input is unavailable for this model; the original images remain available as artifacts.'
                  }
                ]
              : []),
            ...(durableStorageDegraded
              ? [
                  {
                    type: 'text',
                    text: `Original artifact storage unavailable: ${durableStorageDegraded.message}`
                  }
                ]
              : [])
          ],
          {
            maxDepth: 64,
            maxCollectionEntries: 100000,
            maxStringBytes: 8000000,
            maxTotalBytes: 16000000
          }
        )
      ).value
    );
    const modelContentBytes = new TextEncoder().encode(JSON.stringify(modelContent));
    let modelContentRef: PublicArtifactRef | undefined;
    if (modelContentBytes.byteLength > 256 * 1024) {
      try {
        if (!this.artifacts) throw new Error('Model content artifact storage is unavailable.');
        modelContentRef = await this.artifacts.store({
          label: `${input.call.name}-model-content`,
          content: modelContentBytes,
          mediaType: 'application/json',
          description: 'Exact selected tool model content.'
        });
      } catch (error) {
        durableStorageDegraded = {
          message: error instanceof Error ? error.message : String(error)
        };
        modelContent = decodeToolContent([
          {
            type: 'text',
            text: `${durableObservation.summary}\nInvocation disposition: ${durableObservation.kind}; execution state: ${durableObservation.execution?.state ?? 'not established'}. Detailed model content is unavailable because storage failed: ${durableStorageDegraded.message.slice(0, 1000)}. Original result coverage is unavailable in this representation.`
          }
        ]);
      }
    }
    const source = storedToolObservation(durableObservation, canonicalArtifact);
    const original: StoredToolObservation =
      bytes.byteLength > 256 * 1024 && !canonicalArtifact
        ? Object.freeze({
            storage: 'unavailable',
            kind: source.kind,
            summary: source.summary,
            digest: source.digest,
            coverage: source.coverage,
            ...(source.execution ? { execution: source.execution } : {}),
            bytes: bytes.byteLength,
            message:
              durableStorageDegraded?.message.slice(0, 1000) ?? 'Original storage is unavailable.'
          })
        : source;
    // Unavailable original data is recorded as loss, never as invented structured output.
    return Object.freeze({
      id: `obs_${randomUUID()}`,
      turnIndex: input.turnIndex,
      call: input.call,
      toolName: input.call.name,
      tool: input.tool,
      ...(input.canonicalSnapshot === undefined
        ? {}
        : { canonicalSnapshot: input.canonicalSnapshot }),
      ...(original.storage === 'unavailable'
        ? {}
        : { fullObservation: input.observation, durableObservation }),
      modelContent,
      ...(modelContentRef ? { modelContentRef } : {}),
      original,
      ...(canonicalArtifact ? { canonicalArtifact } : {}),
      ...(durableStorageDegraded ? { durableStorageDegraded } : {}),
      createdAt: new Date().toISOString()
    });
  }
  async projectToolObservation(
    committed: CommittedToolObservation
  ): Promise<ToolObservationRecord> {
    const modelContent = committed.modelContent;
    const imageParts = modelContent.filter((part) => part.type === 'image');
    const modelImages = await Promise.all(
      imageParts.map(async (part): Promise<ModelImage> => {
        if (!this.artifacts) throw new Error('Image artifact storage is unavailable.');
        return {
          type: 'bytes',
          data: await this.artifacts.readVerified(part.artifact),
          mediaType: part.artifact.mediaType as `image/${string}`,
          detail: part.detail
        };
      })
    );
    return Object.freeze({
      ...committed,
      modelContent,
      modelText: serializeToolModelContent(modelContent),
      modelImages: Object.freeze(modelImages),
      imageArtifacts: Object.freeze(imageParts.map((part) => part.artifact)),
      observedFacts: Object.freeze(
        recordObservedFacts(committed.durableObservation?.observedFacts, {
          observationId: committed.id,
          toolName: committed.toolName,
          createdAt: committed.createdAt
        })
      )
    });
  }
}

export async function transformToolObservationForDurability(
  observation: ToolObservation,
  options: { readonly artifacts?: ArtifactRepository; readonly retainUnredacted?: boolean } = {}
): Promise<ToolObservation> {
  const canonical = observation;
  const redacted = redactJson(encodeToolObservation(canonical));
  if (!isJsonObject(redacted.value)) throw new Error('Redacted tool observation is invalid.');
  let durable = decodeOwnedToolObservationForPersistence(redacted.value);
  if (redacted.redactions > 0 && options.retainUnredacted && options.artifacts) {
    const protectedArtifact = await options.artifacts.storeProtected({
      label: 'protected-tool-observation',
      content: new TextEncoder().encode(`${serializeObservation(canonical)}\n`),
      mediaType: 'application/json; charset=utf-8',
      description: 'Protected unredacted tool observation.'
    });
    durable = updateToolObservation(durable, {
      metadata: { ...(durable.metadata ?? {}), redactions: redacted.redactions, protectedArtifact }
    });
  } else if (redacted.redactions > 0) {
    durable = updateToolObservation(durable, {
      metadata: { ...(durable.metadata ?? {}), redactions: redacted.redactions }
    });
  }
  return durable;
}

/** Generic result-content assembly. It is intentionally independent of tool names. */
export function filterToolResultContentForModel(
  observation: ToolObservation,
  modelInputModalities: readonly string[]
): ToolObservation {
  if (
    !observation.content?.some((item) => item.type === 'image') ||
    modelInputModalities.includes('image')
  )
    return observation;
  const hiddenImages = observation.content.filter((item) => item.type === 'image');
  const content = observation.content.map((item) =>
    item.type === 'image'
      ? Object.freeze({ type: 'artifact' as const, artifact: item.artifact })
      : item
  );
  return updateToolObservation(observation, {
    summary: `${observation.summary} ${String(hiddenImages.length)} image${hiddenImages.length === 1 ? '' : 's'} exist as public artifacts but were not attached because the active model does not support image input.`,
    content,
    metadata: {
      ...(observation.metadata ?? {}),
      modelContentFilter: {
        unsupportedModality: 'image',
        convertedToArtifactMetadata: hiddenImages.map((item) => item.artifact)
      }
    }
  });
}

function serializeObservation(observation: ToolObservation): string {
  return JSON.stringify(encodeToolObservation(observation));
}
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
