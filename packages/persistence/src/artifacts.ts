import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalJsonString, parseJsonObject } from '@agent-core/json';
import {
  ArtifactIntegrityError,
  artifactIdentity,
  decodeOwnedArtifactRef,
  sameArtifactIdentity,
  freezeArtifactRef,
  hashArtifactBytes,
  safeArtifactLabel,
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
    const artifactId = artifactIdentity(sha256, mediaType, protectedPath ? 'protected' : 'public');
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
    const metadataPath = `${target}.ref.json`;
    const metadataTemporary = `${metadataPath}.${randomUUID()}.tmp`;
    try {
      const metadata = await fs.open(metadataTemporary, 'wx', protectedPath ? 0o600 : 0o644);
      try {
        await metadata.writeFile(canonicalJsonString({ format: 'agent-core-artifact-v1', ref }));
        await metadata.sync();
      } finally { await metadata.close(); }
      try { await fs.link(metadataTemporary, metadataPath); }
      catch (error) { if (nodeCode(error) !== 'EEXIST') throw error; }
      await this.assertStoredIdentity(ref);
      if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(target), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await fs.rm(metadataTemporary, { force: true }); }
    return ref;
  }

  storeText(label: string, content: string, description?: string): Promise<PublicArtifactRef> {
    return this.store({ label, content: new TextEncoder().encode(content), mediaType: 'text/plain; charset=utf-8', ...(description ? { description } : {}) });
  }

  storeJson(label: string, value: unknown, description?: string): Promise<PublicArtifactRef> {
    return this.store({
      label,
      content: new TextEncoder().encode(`${canonicalJsonString(value)}\n`),
      mediaType: 'application/json; charset=utf-8',
      ...(description ? { description } : {})
    });
  }

  storeBuffer(label: string, content: Uint8Array, mediaType = 'application/octet-stream', description?: string): Promise<PublicArtifactRef> {
    return this.store({ label, content, mediaType, ...(description ? { description } : {}) });
  }

  async readVerified(ref: ArtifactRef): Promise<Uint8Array> {
    await this.assertStoredIdentity(ref);
    const filePath = this.confinedPath(ref.artifactId);
    const handle = await fs.open(filePath, 'r');
    try {
      const identity = fileIdentity(await handle.stat());
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.byteLength !== ref.size) throw new ArtifactIntegrityError(ref.artifactId, `Artifact size mismatch for ${ref.artifactId}.`);
      if (hashArtifactBytes(bytes) !== ref.sha256) throw new ArtifactIntegrityError(ref.artifactId, `Artifact SHA-256 mismatch for ${ref.artifactId}.`);
      if (fileIdentity(await handle.stat()) !== identity) throw new ArtifactIntegrityError(ref.artifactId, `Artifact changed while verifying ${ref.artifactId}.`);
      this.verifiedFiles.set(filePath, { identity, sha256: ref.sha256 });
      return bytes;
    } finally { await handle.close(); }
  }

  async readVerifiedRange(ref: ArtifactRef, input: { readonly offset: number; readonly length: number }): Promise<import('./artifact-repository.js').ArtifactRange> {
    await this.assertStoredIdentity(ref);
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
      let filled = 0;
      while (filled < window.length) {
        const read = await handle.read(window, filled, window.length - filled, windowStart + filled);
        if (read.bytesRead === 0) throw new ArtifactIntegrityError(ref.artifactId, `Artifact ended while reading ${ref.artifactId}.`);
        filled += read.bytesRead;
      }
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
    const ref = await this.readReference(artifactId);
    if (ref?.visibility !== 'public') return undefined;
    let stat;
    try { stat = await fs.stat(this.confinedPath(artifactId)); }
    catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
    if (!stat.isFile() || stat.size !== ref.size) throw new ArtifactIntegrityError(artifactId, 'Persisted artifact body size mismatch.');
    return ref;
  }

  private async readReference(artifactId: string): Promise<ArtifactRef | undefined> {
    if (!/^(?:protected-)?[a-f0-9]{64}-[a-f0-9]{64}\.[a-z0-9]+$/u.test(artifactId)) throw new Error('Invalid artifact representation identifier.');
    let raw: string;
    try { raw = await fs.readFile(`${this.confinedPath(artifactId)}.ref.json`, 'utf8'); }
    catch (error) { if (nodeCode(error) === 'ENOENT') return undefined; throw error; }
    const record = parseJsonObject(JSON.parse(raw));
    if (record.format !== 'agent-core-artifact-v1' || Object.keys(record).length !== 2) throw new ArtifactIntegrityError(artifactId, 'Invalid persisted artifact format.');
    const ref = freezeArtifactRef(decodeOwnedArtifactRef(parseJsonObject(record.ref)));
    if (ref.artifactId !== artifactId || artifactId !== artifactIdentity(ref.sha256, ref.mediaType, ref.visibility)) throw new ArtifactIntegrityError(artifactId, 'Persisted artifact identity mismatch.');
    return ref;
  }

  private async assertStoredIdentity(ref: ArtifactRef): Promise<void> {
    validateArtifactRef(ref);
    const stored = await this.readReference(ref.artifactId);
    if (!stored || !sameArtifactIdentity(stored, ref)) throw new ArtifactIntegrityError(ref.artifactId, 'Persisted artifact representation is unavailable or changed.');
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
