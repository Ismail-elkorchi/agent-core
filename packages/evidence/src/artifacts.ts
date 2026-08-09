import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeJsonSafe } from '@agent-core/json';
import {
  ArtifactIntegrityError,
  artifactExtension,
  freezeArtifactRef,
  hashArtifactBytes,
  safeArtifactLabel,
  mediaTypeFromArtifactId,
  validateArtifactRef,
  type ArtifactRef,
  type ArtifactRepository,
  type ArtifactStoreInput,
  type ProtectedArtifactRef,
  type PublicArtifactRef
} from './artifact-repository.js';

export interface LocalArtifactRepositoryOptions { readonly rootDir: string; readonly onVerificationScan?: (artifactId: string) => void }

export class LocalArtifactRepository implements ArtifactRepository {
  private readonly rootDir: string;
  private readonly onVerificationScan: ((artifactId: string) => void) | undefined;
  private readonly references = new Map<string, ArtifactRef>();
  private readonly verifiedFiles = new Map<string, { readonly identity: string; readonly sha256: string }>();

  constructor(options: LocalArtifactRepositoryOptions | string) {
    this.rootDir = path.resolve(typeof options === 'string' ? options : options.rootDir);
    this.onVerificationScan = typeof options === 'string' ? undefined : options.onVerificationScan;
  }

  async store(input: ArtifactStoreInput): Promise<PublicArtifactRef> {
    return this.storeAt(input, false);
  }

  async storeProtected(input: ArtifactStoreInput): Promise<ProtectedArtifactRef> {
    return this.storeAt(input, true);
  }

  private async storeAt(input: ArtifactStoreInput, protectedPath: false): Promise<PublicArtifactRef>;
  private async storeAt(input: ArtifactStoreInput, protectedPath: true): Promise<ProtectedArtifactRef>;
  private async storeAt(input: ArtifactStoreInput, protectedPath: boolean): Promise<PublicArtifactRef | ProtectedArtifactRef> {
    const bytes = new Uint8Array(input.content);
    const mediaType = input.mediaType ?? 'application/octet-stream';
    const sha256 = hashArtifactBytes(bytes);
    const artifactId = `${protectedPath ? 'protected-' : ''}${sha256}${artifactExtension(mediaType)}`;
    const target = this.confinedPath(artifactId);
    await fs.mkdir(path.dirname(target), { recursive: true, ...(protectedPath ? { mode: 0o700 } : {}) });
    if (protectedPath) await fs.chmod(path.dirname(target), 0o700);
    const temporary = path.join(path.dirname(target), `tmp-${artifactId}-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', protectedPath ? 0o600 : 0o644);
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
    const ref = freezeArtifactRef({
      artifactId,
      sha256,
      size: bytes.byteLength,
      mediaType,
      visibility: protectedPath ? 'protected' as const : 'public' as const,
      label: safeArtifactLabel(input.label),
      ...(input.description ? { description: input.description } : {})
    });
    if (protectedPath) await fs.chmod(target, 0o600);
    this.references.set(artifactId, ref);
    return ref;
  }

  storeText(label: string, content: string, description?: string): Promise<PublicArtifactRef> {
    return this.store({ label, content: new TextEncoder().encode(content), mediaType: 'text/plain; charset=utf-8', ...(description ? { description } : {}) });
  }

  storeJson(label: string, value: unknown, description?: string): Promise<PublicArtifactRef> {
    const normalized = normalizeJsonSafe(value);
    return this.store({
      label,
      content: new TextEncoder().encode(`${JSON.stringify(normalized.value, null, 2)}\n`),
      mediaType: 'application/json; charset=utf-8',
      ...(description ? { description } : {})
    });
  }

  storeBuffer(label: string, content: Uint8Array, mediaType = 'application/octet-stream', description?: string): Promise<PublicArtifactRef> {
    return this.store({ label, content, mediaType, ...(description ? { description } : {}) });
  }

  async readVerified(ref: ArtifactRef): Promise<Uint8Array> {
    validateArtifactRef(ref);
    const filePath = this.confinedPath(ref.artifactId);
    const bytes = new Uint8Array(await fs.readFile(filePath));
    if (bytes.byteLength !== ref.size) throw new ArtifactIntegrityError(ref.artifactId, `Artifact size mismatch for ${ref.artifactId}.`);
    if (hashArtifactBytes(bytes) !== ref.sha256) throw new ArtifactIntegrityError(ref.artifactId, `Artifact SHA-256 mismatch for ${ref.artifactId}.`);
    const stat = await fs.stat(filePath);
    this.verifiedFiles.set(filePath, { identity: fileIdentity(stat), sha256: ref.sha256 });
    return bytes;
  }

  async readVerifiedRange(ref: ArtifactRef, input: { readonly offset: number; readonly length: number }): Promise<import('./artifact-repository.js').ArtifactRange> {
    validateArtifactRef(ref);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.length) || input.length < 1 || input.offset > ref.size) throw new Error('Invalid artifact range.');
    const filePath = this.confinedPath(ref.artifactId);
    const handle = await fs.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size !== ref.size) throw new ArtifactIntegrityError(ref.artifactId, `Artifact size mismatch for ${ref.artifactId}.`);
      const identity = fileIdentity(stat);
      const cached = this.verifiedFiles.get(filePath);
      if (cached?.identity !== identity || cached.sha256 !== ref.sha256) {
        this.verifiedFiles.delete(filePath);
        this.onVerificationScan?.(ref.artifactId);
        const hash = (await import('node:crypto')).createHash('sha256');
        const chunk = Buffer.allocUnsafe(256 * 1024);
        let position = 0;
        while (position < stat.size) {
          const read = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
          if (read.bytesRead === 0) break;
          hash.update(chunk.subarray(0, read.bytesRead));
          position += read.bytesRead;
        }
        if (hash.digest('hex') !== ref.sha256) throw new ArtifactIntegrityError(ref.artifactId, `Artifact SHA-256 mismatch for ${ref.artifactId}.`);
        const verifiedStat = await handle.stat();
        if (fileIdentity(verifiedStat) !== identity) throw new ArtifactIntegrityError(ref.artifactId, `Artifact changed while verifying ${ref.artifactId}.`);
        this.verifiedFiles.set(filePath, { identity, sha256: ref.sha256 });
      }
      const windowStart = Math.max(0, input.offset - 3);
      const windowEnd = Math.min(stat.size, input.offset + input.length + 3);
      const window = Buffer.alloc(windowEnd - windowStart);
      if (window.length > 0) await handle.read(window, 0, window.length, windowStart);
      if (fileIdentity(await handle.stat()) !== identity) {
        this.verifiedFiles.delete(filePath);
        throw new ArtifactIntegrityError(ref.artifactId, `Artifact changed while reading ${ref.artifactId}.`);
      }
      const relative = (await import('./artifact-repository.js')).adjustedArtifactByteRange(
        { ...ref, size: window.length },
        window,
        input.offset - windowStart,
        input.length
      );
      const offset = windowStart + relative.offset;
      const end = windowStart + relative.end;
      return Object.freeze({ offset, end, bytes: new Uint8Array(window.subarray(relative.offset, relative.end)), fullSize: stat.size });
    } finally {
      await handle.close();
    }
  }

  async resolve(artifactId: string): Promise<PublicArtifactRef | undefined> {
    if (artifactId.startsWith('protected-')) return undefined;
    const known = this.references.get(artifactId);
    if (known?.visibility === 'public') return known;
    if (!/^(?:protected-)?[a-f0-9]{64}\.[a-z0-9]+$/u.test(artifactId)) return undefined;
    let stat;
    try { stat = await fs.stat(this.confinedPath(artifactId)); } catch { return undefined; }
    if (!stat.isFile()) return undefined;
    const ref = freezeArtifactRef({
      artifactId,
      sha256: artifactId.replace(/^protected-/u, '').slice(0, 64),
      size: stat.size,
      mediaType: mediaTypeFromArtifactId(artifactId),
      visibility: 'public',
      label: artifactId
    });
    this.references.set(artifactId, ref);
    return ref;
  }

  private confinedPath(artifactId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(artifactId)) throw new Error(`Invalid artifact identifier: ${artifactId}`);
    const target = path.resolve(artifactId.startsWith('protected-') ? path.join(this.rootDir, 'protected') : this.rootDir, artifactId);
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
function fileIdentity(stat: { readonly dev: number | bigint; readonly ino: number | bigint; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number }): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].map(String).join(':');
}
