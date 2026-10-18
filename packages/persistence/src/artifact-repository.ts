import { createHash } from 'node:crypto';
import { isTextMediaType } from './text.js';
import type { JsonObject } from '@agent-core/json';

type ArtifactRefBase = Readonly<{
  readonly artifactId: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly label?: string;
  readonly description?: string;
}>;
export type PublicArtifactRef = ArtifactRefBase & Readonly<{ readonly visibility: 'public' }>;
export type ProtectedArtifactRef = ArtifactRefBase & Readonly<{ readonly visibility: 'protected' }>;
export type ArtifactRef = PublicArtifactRef | ProtectedArtifactRef;

export interface ArtifactStoreInput {
  readonly label: string;
  readonly content: Uint8Array;
  readonly mediaType?: string;
  readonly description?: string;
}
export interface ArtifactRange {
  readonly offset: number;
  readonly end: number;
  readonly bytes: Uint8Array;
  readonly fullSize: number;
}

export interface ArtifactRepository {
  store(input: ArtifactStoreInput): Promise<PublicArtifactRef>;
  storeProtected(input: ArtifactStoreInput): Promise<ProtectedArtifactRef>;
  readVerified(ref: ArtifactRef): Promise<Uint8Array>;
  readVerifiedRange(ref: ArtifactRef, input: { readonly offset: number; readonly length: number }): Promise<ArtifactRange>;
  resolve(artifactId: string): Promise<PublicArtifactRef | undefined>;
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

  store(input: ArtifactStoreInput): Promise<PublicArtifactRef> {
    return this.storeWithPrefix(input, '');
  }

  storeProtected(input: ArtifactStoreInput): Promise<ProtectedArtifactRef> {
    return this.storeWithPrefix(input, 'protected-');
  }

  private storeWithPrefix(input: ArtifactStoreInput, prefix: ''): Promise<PublicArtifactRef>;
  private storeWithPrefix(input: ArtifactStoreInput, prefix: 'protected-'): Promise<ProtectedArtifactRef>;
  private storeWithPrefix(input: ArtifactStoreInput, prefix: '' | 'protected-'): Promise<PublicArtifactRef | ProtectedArtifactRef> {
    const bytes = new Uint8Array(input.content);
    const mediaType = input.mediaType ?? 'application/octet-stream';
    const sha256 = hashArtifactBytes(bytes);
    const artifactId = artifactIdentity(sha256, mediaType, prefix === 'protected-' ? 'protected' : 'public');
    this.content.set(artifactId, bytes);
    const ref = freezeArtifactRef({ artifactId, sha256, size: bytes.byteLength, mediaType, visibility: prefix === 'protected-' ? 'protected' : 'public', label: safeArtifactLabel(input.label), ...(input.description ? { description: input.description } : {}) });
    if (!this.references.has(artifactId)) this.references.set(artifactId, ref);
    return Promise.resolve(ref);
  }

  readVerified(ref: ArtifactRef): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      validateArtifactRef(ref);
      const stored = this.references.get(ref.artifactId);
      if (!stored) throw new Error(`Unknown artifact: ${ref.artifactId}`);
      if (!sameArtifactIdentity(stored, ref)) throw new ArtifactIntegrityError(ref.artifactId, `Artifact representation verification failed for ${ref.artifactId}.`);
      const bytes = this.content.get(ref.artifactId);
      if (!bytes) throw new Error(`Unknown artifact: ${ref.artifactId}`);
      if (bytes.byteLength !== ref.size || hashArtifactBytes(bytes) !== ref.sha256) throw new ArtifactIntegrityError(ref.artifactId, `Artifact verification failed for ${ref.artifactId}.`);
      return new Uint8Array(bytes);
    });
  }

  async readVerifiedRange(ref: ArtifactRef, input: { readonly offset: number; readonly length: number }): Promise<ArtifactRange> {
    validateRange(input, ref);
    const bytes = await this.readVerified(ref);
    const range = adjustedRange(ref, bytes, input.offset, input.length);
    return Object.freeze({ offset: range.offset, end: range.end, bytes: new Uint8Array(bytes.subarray(range.offset, range.end)), fullSize: bytes.byteLength });
  }

  resolve(artifactId: string): Promise<PublicArtifactRef | undefined> {
    const value = artifactId.startsWith('protected-') ? undefined : this.references.get(artifactId);
    return Promise.resolve(value?.visibility === 'public' ? value : undefined);
  }
}

export function validateArtifactRef(value: unknown): asserts value is ArtifactRef {
  if (!isRecord(value) || typeof value.artifactId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value.artifactId)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0
    || typeof value.mediaType !== 'string' || value.mediaType.trim().length === 0
    || (value.visibility !== 'public' && value.visibility !== 'protected')
    || (value.visibility === 'protected') !== value.artifactId.startsWith('protected-')) {
    throw new Error('Invalid artifact reference.');
  }
}

export function validatePublicArtifactRef(value: unknown): asserts value is PublicArtifactRef {
  validateArtifactRef(value);
  if (value.visibility !== 'public') throw new Error('Protected artifacts are not model-readable.');
}

export function decodeOwnedArtifactRef(value: JsonObject): ArtifactRef {
  const allowed = new Set(['artifactId', 'sha256', 'size', 'mediaType', 'visibility', 'label', 'description']);
  if (Object.keys(value).some((key) => !allowed.has(key)) || (value.label !== undefined && typeof value.label !== 'string') || (value.description !== undefined && typeof value.description !== 'string')) throw new Error('Invalid artifact reference.');
  validateArtifactRef(value);
  return value;
}

export function hashArtifactBytes(content: Uint8Array): string { return createHash('sha256').update(content).digest('hex'); }
export function freezeArtifactRef<T extends ArtifactRef>(ref: T): T { return Object.freeze(ref); }
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

/** Labels and descriptions are presentation annotations, not immutable representation identity. */
export function sameArtifactIdentity(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.artifactId === right.artifactId && left.sha256 === right.sha256 && left.size === right.size
    && left.mediaType === right.mediaType && left.visibility === right.visibility;
}
export function artifactIdentity(sha256: string, mediaType: string, visibility: ArtifactRef['visibility']): string {
  const representation = hashArtifactBytes(new TextEncoder().encode(mediaType));
  return `${visibility === 'protected' ? 'protected-' : ''}${sha256}-${representation}${artifactExtension(mediaType)}`;
}
export function safeArtifactLabel(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._:-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned.length > 0 ? cleaned : 'artifact';
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function adjustedArtifactByteRange(ref: ArtifactRef, bytes: Uint8Array, offset: number, length: number): { readonly offset: number; readonly end: number } {
  return adjustedRange(ref, bytes, offset, length);
}
function adjustedRange(ref: ArtifactRef, bytes: Uint8Array, offset: number, length: number): { readonly offset: number; readonly end: number } {
  let start = offset;
  let end = Math.min(bytes.byteLength, offset + length);
  if (isTextMediaType(ref.mediaType)) {
    while (start > 0 && isContinuation(bytes[start])) start -= 1;
    while (end < bytes.byteLength && isContinuation(bytes[end])) end += 1;
  }
  return { offset: start, end };
}
function isContinuation(value: number | undefined): boolean { return value !== undefined && (value & 0xc0) === 0x80; }
function validateRange(input: { readonly offset: number; readonly length: number }, ref: ArtifactRef): void {
  validateArtifactRef(ref);
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.length) || input.length < 1) throw new Error('Artifact range must use a nonnegative offset and positive length.');
  if (input.offset > ref.size) throw new Error('Artifact range offset exceeds the artifact size.');
}
