import { parseJsonValue, type ArtifactRef, type ArtifactRepository, type EvidenceRecord, type JsonValue } from '@agent-core/evidence';
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
      while (index < records.length && items.length < limit) {
        const item = parseJsonValue(records[index]);
        const itemBytes = new TextEncoder().encode(JSON.stringify(item)).byteLength;
        if (items.length > 0 && bytes + itemBytes > maxBytes) break;
        if (items.length === 0 && itemBytes > maxBytes) {
          index += 1;
          break;
        }
        items.push(item);
        bytes += itemBytes;
        index += 1;
      }
      const nextCursor = index < records.length ? `tool:${String(index)}` : configured ? 'external:' : undefined;
      return Object.freeze({ items: Object.freeze(items), bytes, truncated: nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}) });
    },
    readArtifact(ref: ArtifactRef, request?: { readonly maxBytes?: number }) {
      const resolved = request ?? {};
      if (configured) return configured.readArtifact(ref, resolved);
      if (!artifacts) return Promise.reject(new Error('Artifact reading is unavailable for this verification run.'));
      return artifacts.readVerified(ref).then((bytes) => bytes.subarray(0, positiveLimit(resolved.maxBytes, bytes.byteLength || 1)));
    }
  };
  return Object.freeze(reader);
}

function externalPage(page: AgentEvidencePage): AgentEvidencePage {
  return Object.freeze({
    items: Object.freeze([...page.items]),
    bytes: page.bytes,
    truncated: page.truncated,
    ...(page.nextCursor !== undefined ? { nextCursor: `external:${encodeURIComponent(page.nextCursor)}` } : {})
  });
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
