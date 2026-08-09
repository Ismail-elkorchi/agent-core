import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArtifactRepository } from '@agent-core/evidence';
import { artifactScope, defineTool, requireToolService, requireWorkspaceRoot, ToolInputError, workspaceFileScope } from '@agent-core/tools';
import { requireLocalToolConfiguration } from '../../core/configuration.js';
import { assertRealPathInsideRoot, canonicalWorkspacePath, resolveInsideRoot } from '../../core/filesystem.js';
import { builtInReadEvidence } from '../../core/read-evidence.js';
import { viewImageInputSchema, viewImageOutputSchema } from './schema.js';

export const viewImageTool = defineTool({
  name: 'view_image',
  implementationId: 'agent-core.view-image.v1',
  description: 'Load a workspace image as model image content without placing a data URL in the event log.',
  schema: viewImageInputSchema,
  outputSchema: viewImageOutputSchema,
  requirements: { services: ['workspaceRoot', 'artifactRepository', 'localToolConfiguration'], modelInputModalities: ['image'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'workspace/files' }], lockScopes: [] },
  async canonicalizeInput(input, context) {
    return { ...input, path: await canonicalWorkspacePath(requireWorkspaceRoot(context), input.path) };
  },
  deriveEffects(input) {
    return {
      accesses: [{ mode: 'read', scope: workspaceFileScope(input.path) }],
      lockScopes: [],
      idempotency: 'pure'
    };
  },
  async invoke(input, context) {
    const root = requireWorkspaceRoot(context);
    const absolute = resolveInsideRoot(root, input.path);
    await assertRealPathInsideRoot(root, absolute, input.path);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new ToolInputError(`Path is not a regular file: ${input.path}`);
    const maxBytes = requireLocalToolConfiguration(context).artifact.maxImageBytes;
    if (stat.size > maxBytes) throw new ToolInputError(`Image exceeds the host limit (${String(stat.size)} bytes, max ${String(maxBytes)}).`);
    const bytes = new Uint8Array(await fs.readFile(absolute));
    const image = inspectImage(bytes, input.path);
    const repository = requireToolService<ArtifactRepository>(context, 'artifactRepository', isArtifactRepository, 'ArtifactRepository');
    const artifact = await repository.store({
      label: path.basename(input.path),
      content: bytes,
      mediaType: image.mediaType,
      description: `Workspace image ${input.path}`
    });
    const output = {
      path: input.path,
      detail: input.detail,
      ...(image.width === undefined ? {} : { width: image.width }),
      ...(image.height === undefined ? {} : { height: image.height }),
      artifact
    };
    const scope = { resources: [workspaceFileScope(input.path), artifactScope(artifact.artifactId)], coverage: 'complete' as const };
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Loaded image ${input.path} (${String(stat.size)} bytes).`,
      scope,
      evidence: builtInReadEvidence('read', scope, `Read workspace image ${input.path}.`),
      content: [{ type: 'image' as const, artifact, detail: input.detail }],
      output
    };
  }
});

function inspectImage(bytes: Uint8Array, filePath: string): { mediaType: string; width?: number; height?: number } {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mediaType: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { mediaType: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mediaType: 'image/webp' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mediaType: 'image/jpeg' };
  }
  throw new ToolInputError(`Unsupported or invalid image file: ${filePath}`);
}

function isArtifactRepository(value: unknown): value is ArtifactRepository {
  return typeof value === 'object' && value !== null
    && typeof (value as ArtifactRepository).store === 'function'
    && typeof (value as ArtifactRepository).readVerified === 'function'
    && typeof (value as ArtifactRepository).readVerifiedRange === 'function'
    && typeof (value as ArtifactRepository).storeProtected === 'function'
    && typeof (value as ArtifactRepository).resolve === 'function';
}
