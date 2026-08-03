import { createHash } from 'node:crypto';
import { normalizeJsonSafe } from './json.js';

export interface ArtifactRef {
  readonly artifactId: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly label?: string;
  readonly description?: string;
}

export interface ArtifactStoreInput {
  readonly label: string;
  readonly content: Uint8Array;
  readonly mediaType?: string;
  readonly description?: string;
}

export interface ArtifactRepository {
  store(input: ArtifactStoreInput): Promise<ArtifactRef>;
  readVerified(ref: ArtifactRef): Promise<Uint8Array>;
}

export class ArtifactIntegrityError extends Error {
  readonly artifactId: string;
  constructor(artifactId: string, message: string) {
    super(message);
    this.name = 'ArtifactIntegrityError';
    this.artifactId = artifactId;
  }
}

export class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly content = new Map<string, Uint8Array>();

  store(input: ArtifactStoreInput): Promise<ArtifactRef> {
    const bytes = new Uint8Array(input.content);
    const mediaType = input.mediaType ?? 'application/octet-stream';
    const sha256 = hashArtifactBytes(bytes);
    const artifactId = `${sha256}${artifactExtension(mediaType)}`;
    this.content.set(artifactId, bytes);
    return Promise.resolve(freezeArtifactRef({ artifactId, sha256, size: bytes.byteLength, mediaType, label: safeArtifactLabel(input.label), ...(input.description ? { description: input.description } : {}) }));
  }

  readVerified(ref: ArtifactRef): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      validateArtifactRef(ref);
      const bytes = this.content.get(ref.artifactId);
      if (!bytes) throw new Error(`Unknown artifact: ${ref.artifactId}`);
      if (bytes.byteLength !== ref.size || hashArtifactBytes(bytes) !== ref.sha256) throw new ArtifactIntegrityError(ref.artifactId, `Artifact verification failed for ${ref.artifactId}.`);
      return new Uint8Array(bytes);
    });
  }
}

export async function storeJsonArtifact(repository: ArtifactRepository, label: string, value: unknown, description?: string): Promise<ArtifactRef> {
  const normalized = normalizeJsonSafe(value);
  return repository.store({
    label,
    content: new TextEncoder().encode(`${JSON.stringify(normalized.value, null, 2)}\n`),
    mediaType: 'application/json; charset=utf-8',
    ...(description ? { description } : {})
  });
}

export function validateArtifactRef(value: unknown): asserts value is ArtifactRef {
  if (!isRecord(value) || typeof value.artifactId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value.artifactId)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 0
    || typeof value.mediaType !== 'string' || value.mediaType.trim().length === 0) {
    throw new Error('Invalid artifact reference.');
  }
}

export function hashArtifactBytes(content: Uint8Array): string { return createHash('sha256').update(content).digest('hex'); }
export function freezeArtifactRef(ref: ArtifactRef): ArtifactRef { return Object.freeze(ref); }
export function artifactExtension(mediaType: string): string {
  if (mediaType.includes('json')) return '.json';
  if (mediaType.includes('markdown')) return '.md';
  if (mediaType.startsWith('text/')) return '.txt';
  return '.bin';
}
export function safeArtifactLabel(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._:-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned.length > 0 ? cleaned : 'artifact';
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
