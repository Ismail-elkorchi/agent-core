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
  resolve(artifactId: string): Promise<ArtifactRef | undefined>;
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
  private readonly references = new Map<string, ArtifactRef>();

  store(input: ArtifactStoreInput): Promise<ArtifactRef> {
    const bytes = new Uint8Array(input.content);
    const mediaType = input.mediaType ?? 'application/octet-stream';
    const sha256 = hashArtifactBytes(bytes);
    const artifactId = `${sha256}${artifactExtension(mediaType)}`;
    this.content.set(artifactId, bytes);
    const ref = freezeArtifactRef({ artifactId, sha256, size: bytes.byteLength, mediaType, label: safeArtifactLabel(input.label), ...(input.description ? { description: input.description } : {}) });
    this.references.set(artifactId, ref);
    return Promise.resolve(ref);
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

  resolve(artifactId: string): Promise<ArtifactRef | undefined> { return Promise.resolve(this.references.get(artifactId)); }
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
  if (mediaType.startsWith('image/png')) return '.png';
  if (mediaType.startsWith('image/jpeg')) return '.jpg';
  if (mediaType.startsWith('image/webp')) return '.webp';
  if (mediaType.startsWith('image/gif')) return '.gif';
  if (mediaType.startsWith('audio/mpeg')) return '.mp3';
  if (mediaType.startsWith('audio/wav') || mediaType.startsWith('audio/x-wav')) return '.wav';
  if (mediaType.startsWith('audio/ogg')) return '.ogg';
  if (mediaType.includes('json')) return '.json';
  if (mediaType.includes('markdown')) return '.md';
  if (mediaType.startsWith('text/')) return '.txt';
  return '.bin';
}

export function mediaTypeFromArtifactId(artifactId: string): string {
  if (artifactId.endsWith('.png')) return 'image/png';
  if (artifactId.endsWith('.jpg')) return 'image/jpeg';
  if (artifactId.endsWith('.webp')) return 'image/webp';
  if (artifactId.endsWith('.gif')) return 'image/gif';
  if (artifactId.endsWith('.mp3')) return 'audio/mpeg';
  if (artifactId.endsWith('.wav')) return 'audio/wav';
  if (artifactId.endsWith('.ogg')) return 'audio/ogg';
  if (artifactId.endsWith('.json')) return 'application/json; charset=utf-8';
  if (artifactId.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (artifactId.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
export function safeArtifactLabel(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._:-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned.length > 0 ? cleaned : 'artifact';
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
