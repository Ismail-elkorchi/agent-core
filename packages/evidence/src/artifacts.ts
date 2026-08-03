import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeJsonSafe } from './json.js';
import {
  ArtifactIntegrityError,
  artifactExtension,
  freezeArtifactRef,
  hashArtifactBytes,
  safeArtifactLabel,
  validateArtifactRef,
  type ArtifactRef,
  type ArtifactRepository,
  type ArtifactStoreInput
} from './artifact-repository.js';

export interface LocalArtifactRepositoryOptions { readonly rootDir: string }

export class LocalArtifactRepository implements ArtifactRepository {
  private readonly rootDir: string;

  constructor(options: LocalArtifactRepositoryOptions | string) {
    this.rootDir = path.resolve(typeof options === 'string' ? options : options.rootDir);
  }

  async store(input: ArtifactStoreInput): Promise<ArtifactRef> {
    const bytes = new Uint8Array(input.content);
    const mediaType = input.mediaType ?? 'application/octet-stream';
    const sha256 = hashArtifactBytes(bytes);
    const artifactId = `${sha256}${artifactExtension(mediaType)}`;
    const target = this.confinedPath(artifactId);
    await fs.mkdir(this.rootDir, { recursive: true });
    const temporary = this.confinedPath(`tmp-${artifactId}-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try { await fs.rename(temporary, target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(nodeCode(error) ?? '')) throw error;
      await verifyFile(target, sha256, bytes.byteLength, artifactId);
    } finally { await fs.rm(temporary, { force: true }); }
    await verifyFile(target, sha256, bytes.byteLength, artifactId);
    return freezeArtifactRef({
      artifactId,
      sha256,
      size: bytes.byteLength,
      mediaType,
      label: safeArtifactLabel(input.label),
      ...(input.description ? { description: input.description } : {})
    });
  }

  storeText(label: string, content: string, description?: string): Promise<ArtifactRef> {
    return this.store({ label, content: new TextEncoder().encode(content), mediaType: 'text/plain; charset=utf-8', ...(description ? { description } : {}) });
  }

  storeJson(label: string, value: unknown, description?: string): Promise<ArtifactRef> {
    const normalized = normalizeJsonSafe(value);
    return this.store({
      label,
      content: new TextEncoder().encode(`${JSON.stringify(normalized.value, null, 2)}\n`),
      mediaType: 'application/json; charset=utf-8',
      ...(description ? { description } : {})
    });
  }

  storeBuffer(label: string, content: Uint8Array, mediaType = 'application/octet-stream', description?: string): Promise<ArtifactRef> {
    return this.store({ label, content, mediaType, ...(description ? { description } : {}) });
  }

  async readVerified(ref: ArtifactRef): Promise<Uint8Array> {
    validateArtifactRef(ref);
    const filePath = this.confinedPath(ref.artifactId);
    const bytes = new Uint8Array(await fs.readFile(filePath));
    if (bytes.byteLength !== ref.size) throw new ArtifactIntegrityError(ref.artifactId, `Artifact size mismatch for ${ref.artifactId}.`);
    if (hashArtifactBytes(bytes) !== ref.sha256) throw new ArtifactIntegrityError(ref.artifactId, `Artifact SHA-256 mismatch for ${ref.artifactId}.`);
    return bytes;
  }

  private confinedPath(artifactId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(artifactId)) throw new Error(`Invalid artifact identifier: ${artifactId}`);
    const target = path.resolve(this.rootDir, artifactId);
    const relative = path.relative(this.rootDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Artifact path escapes repository: ${artifactId}`);
    return target;
  }
}

async function verifyFile(filePath: string, sha256: string, size: number, artifactId: string): Promise<void> {
  const bytes = new Uint8Array(await fs.readFile(filePath));
  if (bytes.byteLength !== size || hashArtifactBytes(bytes) !== sha256) throw new ArtifactIntegrityError(artifactId, `Existing artifact does not match ${artifactId}.`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nodeCode(error: unknown): string | undefined { return isRecord(error) && typeof error.code === 'string' ? error.code : undefined; }
