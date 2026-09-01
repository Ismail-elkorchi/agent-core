import type { ArtifactRepository } from '@agent-core/persistence';
import { artifactScope, defineTool, requireToolService, ToolInputError } from '@agent-core/tools';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { presentReadArtifactObservation } from '../../core/presenters.js';
import { builtInObservedFacts } from '../../core/read-observed-facts.js';
import { readArtifactInputSchema, readArtifactOutputSchema } from './schema.js';

export const readArtifactTool = defineTool({
  name: 'read_artifact',
  implementationId: 'agent-core.read-artifact.v1',
  description: 'Read a byte range from an artifact produced by this runtime.',
  schema: readArtifactInputSchema,
  outputSchema: readArtifactOutputSchema,
  presentObservation: presentReadArtifactObservation,
  requirements: { services: ['artifactRepository', 'localToolConfiguration'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'artifacts' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    const limit = requireLocalToolConfiguration(context).artifact.maxReadBytes;
    return { ...input, byteCount: clampRequestedLimit(input.byteCount, limit) };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: artifactScope(input.artifactId) }], lockScopes: [], recovery: { kind: 'unknown' } };
  },
  async invoke(input, context) {
    const repository = requireToolService<ArtifactRepository>(context, 'artifactRepository', isArtifactRepository, 'ArtifactRepository');
    const artifact = await repository.resolve(input.artifactId);
    if (!artifact) throw new ToolInputError(`Unknown artifact: ${input.artifactId}`, { artifactId: input.artifactId });
    if (input.offset > artifact.size) throw new ToolInputError(`Artifact offset exceeds its size: ${String(input.offset)} > ${String(artifact.size)}.`);
    const range = await repository.readVerifiedRange(artifact, { offset: input.offset, length: input.byteCount });
    const end = range.end;
    const selected = range.bytes;
    const coverage: 'complete' | 'partial' = range.offset === 0 && end === artifact.size ? 'complete' : 'partial';
    const contentType = classifyMediaType(artifact.mediaType);
    const text = contentType === 'text' ? new TextDecoder('utf-8', { fatal: true }).decode(selected) : undefined;
    const output = {
      artifact,
      fullSize: artifact.size,
      returnedRange: { start: range.offset, end },
      returnedBytes: selected.byteLength,
      ...(end < artifact.size ? { nextOffset: end } : {}),
      coverage,
      ...(text === undefined ? {} : { text }),
      contentType
    };
    const content = contentType === 'text'
      ? [{ type: 'text' as const, text: text ?? '', mediaType: artifact.mediaType }]
      : coverage === 'complete' && contentType === 'image'
        ? [{ type: 'image' as const, artifact, detail: 'original' as const }]
        : [{ type: 'artifact' as const, artifact }];
    const scope = { resources: [artifactScope(artifact.artifactId)], coverage, ...(coverage === 'partial' ? { causes: ['requested_range'], limits: { offset: input.offset, byteCount: input.byteCount } } : {}) } as const;
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Read bytes ${String(input.offset)}-${String(end)} of ${String(artifact.size)} from ${artifact.artifactId}.`,
      scope,
      observedFacts: builtInObservedFacts('read', scope, `Read ${String(selected.byteLength)} bytes from artifact ${artifact.artifactId}.`),
      content,
      output
    };
  }
});

function isArtifactRepository(value: unknown): value is ArtifactRepository {
  return typeof value === 'object' && value !== null
    && typeof (value as ArtifactRepository).store === 'function'
    && typeof (value as ArtifactRepository).readVerified === 'function'
    && typeof (value as ArtifactRepository).readVerifiedRange === 'function'
    && typeof (value as ArtifactRepository).storeProtected === 'function'
    && typeof (value as ArtifactRepository).resolve === 'function';
}

function classifyMediaType(mediaType: string): 'text' | 'image' | 'artifact' {
  if (mediaType.startsWith('text/') || mediaType.includes('json') || mediaType.includes('xml') || mediaType.includes('javascript')) return 'text';
  if (mediaType.startsWith('image/')) return 'image';
  return 'artifact';
}
