import { validateArtifactRef, type ArtifactRef, type ArtifactRepository, type EvidenceRecord } from '@agent-core/evidence';
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import type { ContextManager } from '../context/manager.js';
import type { AgentEvidencePage, AgentEvidenceReader, AgentVerificationExecutionContext } from '../run/contracts.js';

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Expose owned tool evidence to verification without granting new command authority. */
export function contextEvidenceExecution(input: {
  readonly contextManager: ContextManager;
  readonly artifacts?: ArtifactRepository;
  readonly configured?: AgentVerificationExecutionContext;
}): AgentVerificationExecutionContext {
  const records = input.contextManager.evidenceSnapshot();
  const evidence = contextEvidenceReader(records, input.artifacts, input.configured?.evidence);
  return Object.freeze({ evidence, ...(input.configured?.runCommand ? { runCommand: input.configured.runCommand } : {}) });
}

function contextEvidenceReader(
  records: readonly EvidenceRecord[],
  artifacts: ArtifactRepository | undefined,
  configured: AgentEvidenceReader | undefined
): AgentEvidenceReader {
  const reader: AgentEvidenceReader = {
    async read(request?: { readonly cursor?: string; readonly limit?: number; readonly maxBytes?: number }): Promise<AgentEvidencePage> {
      const resolved = request ?? {};
      if (resolved.cursor?.startsWith('external:')) {
        if (!configured) throw new Error('Evidence cursor refers to an unavailable external evidence reader.');
        const cursor = decodeExternalCursor(resolved.cursor);
        const page = await configured.read(withCursor(resolved, cursor));
        return externalPage(page);
      }
      if (resolved.cursor !== undefined && !resolved.cursor.startsWith('tool:')) throw new Error('Invalid evidence cursor.');
      const start = resolved.cursor === undefined ? 0 : parseToolCursor(resolved.cursor);
      if (start >= records.length) {
        if (!configured) return Object.freeze({ items: Object.freeze([]), bytes: 0, truncated: false });
        const page = await configured.read(withCursor(resolved, undefined));
        return externalPage(page);
      }
      const limit = positiveLimit(resolved.limit, DEFAULT_LIMIT);
      const maxBytes = positiveLimit(resolved.maxBytes, DEFAULT_MAX_BYTES);
      const items: JsonValue[] = [];
      let bytes = 0;
      let index = start;
      let includedOversizedStub = false;
      while (index < records.length && items.length < limit) {
        const record = records[index];
        if (!record) break;
        const item = parseJsonValue(record);
        const itemBytes = jsonBytes(item);
        if (items.length > 0 && bytes + itemBytes > maxBytes) break;
        if (items.length === 0 && itemBytes > maxBytes) {
          const stub = oversizedEvidenceStub(record, itemBytes, maxBytes);
          items.push(stub);
          bytes += jsonBytes(stub);
          index += 1;
          includedOversizedStub = true;
          break;
        }
        items.push(item);
        bytes += itemBytes;
        index += 1;
      }
      const nextCursor = index < records.length ? `tool:${String(index)}` : configured ? 'external:' : undefined;
      return Object.freeze({ items: Object.freeze(items), bytes, truncated: includedOversizedStub || nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}) });
    },
    async readArtifact(ref: ArtifactRef, request?: { readonly maxBytes?: number }) {
      const resolved = request ?? {};
      validateArtifactRef(ref);
      if (ref.visibility !== 'public') throw new Error('Protected artifacts are not available to verification evidence readers.');
      const maxBytes = positiveLimit(resolved.maxBytes, DEFAULT_MAX_BYTES);
      if (artifacts && await artifacts.resolve(ref.artifactId)) {
        if (ref.size === 0) return new Uint8Array();
        const range = await artifacts.readVerifiedRange(ref, { offset: 0, length: Math.min(ref.size, maxBytes) });
        return new Uint8Array(range.bytes);
      }
      if (configured) {
        const bytes = await configured.readArtifact(ref, { maxBytes });
        if (!(bytes instanceof Uint8Array)) throw new Error('External artifact reader returned invalid bytes.');
        return new Uint8Array(bytes.subarray(0, maxBytes));
      }
      throw new Error('Artifact reading is unavailable for this verification run.');
    }
  };
  return Object.freeze(reader);
}

function externalPage(page: AgentEvidencePage): AgentEvidencePage {
  const owned = parseJsonObject(page);
  const unknown = Object.keys(owned).filter((key) => !['items', 'bytes', 'truncated', 'nextCursor'].includes(key));
  if (unknown.length > 0 || !Array.isArray(owned.items)
    || !Number.isSafeInteger(owned.bytes) || typeof owned.bytes !== 'number' || owned.bytes < 0
    || typeof owned.truncated !== 'boolean'
    || (owned.nextCursor !== undefined && typeof owned.nextCursor !== 'string')
    || (owned.truncated && typeof owned.nextCursor !== 'string')) {
    throw new Error('External evidence reader returned an invalid page.');
  }
  const items = Object.freeze(owned.items.map((item) => parseJsonValue(item)));
  return Object.freeze({
    items,
    bytes: owned.bytes,
    truncated: owned.truncated,
    ...(typeof owned.nextCursor === 'string' ? { nextCursor: `external:${encodeURIComponent(owned.nextCursor)}` } : {})
  });
}

function oversizedEvidenceStub(record: EvidenceRecord, originalBytes: number, maxBytes: number): JsonObject {
  let id = record.id;
  let toolName = record.toolName;
  const build = (): JsonObject => parseJsonObject({ id, action: record.action, outcome: record.outcome, toolName, originalBytes, truncated: true });
  let stub = build();
  if (jsonBytes(stub) <= maxBytes) return stub;
  const fixed = jsonBytes(parseJsonObject({ id: '', action: record.action, outcome: record.outcome, toolName: '', originalBytes, truncated: true }));
  if (fixed > maxBytes) throw new Error(`Evidence maxBytes ${String(maxBytes)} is too small for an oversized-item identity stub.`);
  const available = maxBytes - fixed;
  id = takeUtf8(id, Math.floor(available / 2));
  toolName = takeUtf8(toolName, available - Buffer.byteLength(id, 'utf8'));
  stub = build();
  return stub;
}

function jsonBytes(value: JsonValue): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function takeUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}
function decodeExternalCursor(cursor: string): string | undefined {
  const encoded = cursor.slice('external:'.length);
  return encoded.length === 0 ? undefined : decodeURIComponent(encoded);
}
function parseToolCursor(cursor: string): number {
  const value = Number(cursor.slice('tool:'.length));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid tool evidence cursor.');
  return value;
}
function withCursor(
  request: { readonly cursor?: string; readonly limit?: number; readonly maxBytes?: number },
  cursor: string | undefined
): { readonly cursor?: string; readonly limit?: number; readonly maxBytes?: number } {
  return {
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    ...(cursor === undefined ? {} : { cursor })
  };
}
function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
