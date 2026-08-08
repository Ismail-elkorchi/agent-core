import type { ArtifactRepository } from '@agent-core/evidence';
import { defineTool, requireToolService, ToolInputError } from '@agent-core/tools';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { readArtifactInputSchema, readArtifactOutputSchema } from './schema.js';

export const readArtifactTool = defineTool({
  name: 'read_artifact',
  implementationId: 'agent-core.read-artifact.v1',
  description: 'Read a byte range from an artifact produced by this runtime.',
  schema: readArtifactInputSchema,
  outputSchema: readArtifactOutputSchema,
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'artifacts' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    const limit = requireLocalToolConfiguration(context).artifact.maxReadBytes;
    return { ...input, byteCount: clampRequestedLimit(input.byteCount, limit) };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: `artifacts/${input.artifactId}` }], lockScopes: [], idempotency: 'pure' };
  },
  async invoke(input, context) {
    const repository = requireToolService<ArtifactRepository>(context, 'artifactRepository', isArtifactRepository, 'ArtifactRepository');
    const artifact = await repository.resolve(input.artifactId);
    if (!artifact) throw new ToolInputError(`Unknown artifact: ${input.artifactId}`, { artifactId: input.artifactId });
    if (input.offset > artifact.size) throw new ToolInputError(`Artifact offset exceeds its size: ${String(input.offset)} > ${String(artifact.size)}.`);
    const bytes = await repository.readVerified(artifact);
    const end = Math.min(artifact.size, input.offset + input.byteCount);
    const selected = bytes.subarray(input.offset, end);
    const coverage: 'complete' | 'partial' = input.offset === 0 && end === artifact.size ? 'complete' : 'partial';
    const contentType = classifyMediaType(artifact.mediaType);
    const text = contentType === 'text' ? new TextDecoder().decode(selected) : undefined;
    const output = {
      artifact,
      fullSize: artifact.size,
      returnedRange: { start: input.offset, end },
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
        : coverage === 'complete' && contentType === 'audio'
          ? [{ type: 'audio' as const, artifact }]
          : [{ type: 'artifact' as const, artifact }];
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Read bytes ${String(input.offset)}-${String(end)} of ${String(artifact.size)} from ${artifact.artifactId}.`,
      scope: { resources: [`artifacts/${artifact.artifactId}`], coverage, ...(coverage === 'partial' ? { cause: 'requested byte range does not cover the complete artifact' } : {}) },
      content,
      output
    };
  }
});

function isArtifactRepository(value: unknown): value is ArtifactRepository {
  return typeof value === 'object' && value !== null
    && typeof (value as ArtifactRepository).store === 'function'
    && typeof (value as ArtifactRepository).readVerified === 'function'
    && typeof (value as ArtifactRepository).resolve === 'function';
}

function classifyMediaType(mediaType: string): 'text' | 'image' | 'audio' | 'artifact' {
  if (mediaType.startsWith('text/') || mediaType.includes('json') || mediaType.includes('xml') || mediaType.includes('javascript')) return 'text';
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('audio/')) return 'audio';
  return 'artifact';
}
