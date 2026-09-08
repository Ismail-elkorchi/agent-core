import * as z from 'zod';
import { defineTool, type CompiledToolDefinition, type ToolExecutionContext } from '@agent-core/tools';
import { parseJsonObject, parseJsonValue, type JsonObject } from '@agent-core/json';

export { sourceSchema, scopeSchema, noteRefSchema } from './schema.js';
export const queryShape = {
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024)
    .optional(),
  maxScanned: z.number().int().min(1).max(1000).optional()
};
export const rangeShape = {
  offset: z.number().int().min(0).optional(),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024)
    .optional()
};

export function scopedTool(input: {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
  readonly mode: 'read' | 'write';
  readonly root: string;
  readonly canonicalize: (
    value: JsonObject
  ) => Promise<{ readonly value: JsonObject; readonly scope: string }>;
  readonly invoke: (value: JsonObject, context: ToolExecutionContext) => Promise<unknown>;
}): CompiledToolDefinition {
  return defineTool({
    name: input.name,
    implementationId: `agent-core.${input.name}.v1`,
    description: input.description,
    schema: input.schema,
    outputSchema: z.json(),
    effectEnvelope: {
      accesses: [{ mode: input.mode, scope: input.root }],
      lockScopes: input.mode === 'write' ? [input.root] : []
    },
    async canonicalizeInput(value: unknown) {
      const canonical = await input.canonicalize(parseJsonObject(value));
      return parseJsonObject(canonical);
    },
    deriveEffects(value: unknown) {
      const canonical = parseJsonObject(value);
      if (typeof canonical.scope !== 'string') throw new Error('Missing tool scope.');
      return {
        accesses: [{ mode: input.mode, scope: canonical.scope }],
        lockScopes: input.mode === 'write' ? [canonical.scope] : [],
        recovery: { kind: 'unknown' as const }
      };
    },
    async invoke(value: unknown, context) {
      if (context.signal?.aborted)
        throw context.signal.reason instanceof Error ? context.signal.reason : new Error('Tool aborted.');
      const canonical = parseJsonObject(value);
      if (typeof canonical.scope !== 'string') throw new Error('Missing tool scope.');
      const output = parseJsonValue(await input.invoke(parseJsonObject(canonical.value), context), {
        maxDepth: 64,
        maxCollectionEntries: 50_000,
        maxStringBytes: 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024
      });
      const result =
        typeof output === 'object' && output !== null && !Array.isArray(output) ? output : undefined;
      const status =
        result && 'status' in result && typeof result.status === 'string' ? result.status : 'completed';
      const ok = !['conflict', 'missing', 'tombstone', 'artifact_unavailable', 'unavailable'].includes(
        status
      );
      return {
        kind: 'result',
        ok,
        summary: `${input.name}: ${status}.`,
        output,
        scope: {
          resources: [canonical.scope],
          coverage: result && 'coverage' in result && result.coverage === 'partial' ? 'partial' : 'complete'
        }
      };
    }
  });
}
export function scopePath(root: string, sessionId: string, branchId: string): string {
  return `${root}/${encodeURIComponent(sessionId)}/${encodeURIComponent(branchId)}`;
}
export function invocationIdentity(context: ToolExecutionContext): string {
  const call = context.invocation;
  if (!call) throw new Error('Note mutation requires a host tool invocation identity.');
  return `${call.runId}:${call.turnId}:${String(call.requestAttempt)}:${call.toolBatchId}:${String(call.callIndex)}`;
}
