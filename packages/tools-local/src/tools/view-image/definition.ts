import type { ArtifactRepository } from '@agent-core/persistence';
import { artifactScope, defineTool, requireToolService } from '@agent-core/tools';
import path from 'node:path';
import { requireLocalToolConfiguration } from '../../core/configuration.js';
import { readRootedImage } from '../../core/image.js';
import { builtInObservedFacts } from '../../core/read-observed-facts.js';
import { fileScope } from '../../core/resources.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import { viewImageInputSchema, viewImageOutputSchema } from './schema.js';

export const viewImageTool = defineTool({
  name: 'view_image',
  implementationId: 'agent-core.view-image.v1',
  description: 'Load a rooted image as model image content without placing a data URL in the event log.',
  schema: viewImageInputSchema,
  outputSchema: viewImageOutputSchema,
  requirements: {
    services: ['rootedFileAuthority', 'artifactRepository', 'localToolConfiguration'],
    modelInputModalities: ['image']
  },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'files' }], lockScopes: [] },
  canonicalizeInput(input, context) {
    return { ...input, path: requireRootedFileAuthority(context).canonicalPath(input.path) };
  },
  deriveEffects(input) {
    return {
      accesses: [{ mode: 'read', scope: fileScope(input.path) }],
      lockScopes: [],
      recovery: { kind: 'unknown' }
    };
  },
  async invoke(input, context) {
    const root = requireRootedFileAuthority(context);
    const limits = requireLocalToolConfiguration(context).artifact;
    const { bytes, ...image } = await readRootedImage(root, input.path, limits, {
      signal: context.signal,
      onReading: () =>
        context.emitProgress?.({
          type: 'status',
          stage: 'image_reading',
          message: `Reading stable image ${input.path}.`
        })
    });
    const repository = requireToolService<ArtifactRepository>(
      context,
      'artifactRepository',
      isArtifactRepository,
      'ArtifactRepository'
    );
    const artifact = await repository.store({
      label: path.basename(input.path),
      content: bytes,
      mediaType: image.mediaType,
      description: `Rooted image ${input.path}`
    });
    const output = {
      path: input.path,
      detail: input.detail,
      ...(image.width === undefined ? {} : { width: image.width }),
      ...(image.height === undefined ? {} : { height: image.height }),
      encodedBytes: bytes.byteLength,
      artifact
    };
    const scope = {
      resources: [fileScope(input.path), artifactScope(artifact.artifactId)],
      coverage: 'complete' as const
    };
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Loaded image ${input.path} (${String(bytes.byteLength)} encoded bytes).`,
      scope,
      observedFacts: builtInObservedFacts('read', scope, `Read rooted image ${input.path}.`),
      content: [{ type: 'image' as const, artifact, detail: input.detail }],
      output
    };
  }
});

function isArtifactRepository(value: unknown): value is ArtifactRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ArtifactRepository).store === 'function' &&
    typeof (value as ArtifactRepository).readVerified === 'function' &&
    typeof (value as ArtifactRepository).readVerifiedRange === 'function' &&
    typeof (value as ArtifactRepository).storeProtected === 'function' &&
    typeof (value as ArtifactRepository).resolve === 'function'
  );
}
