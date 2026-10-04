import * as z from 'zod';
import {
  defineTool,
  type CompiledToolDefinition,
  type ToolExecutionContext
} from '@agent-core/tools';
import { parseJsonObject, parseJsonValue, type JsonObject } from '@agent-core/json';

export { sourceSchema } from './schema.js';
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

export function scopedTool(input: {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
  readonly buildModelContent?: import('@agent-core/tools').ToolDefinition['buildModelContent'];
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
    ...(input.buildModelContent ? { buildModelContent: input.buildModelContent } : {}),
    outputSchema: z.json(),
    effectEnvelope: {
      accesses: [{ mode: input.mode, scope: input.root }],
      lockScopes: input.mode === 'write' ? [input.root] : []
    },
    async canonicalizeInput(value: unknown) {
      const canonical = await input.canonicalize(parseJsonObject(value));
      return canonical;
    },
    deriveEffects(canonical) {
      return {
        accesses: [{ mode: input.mode, scope: canonical.scope }],
        lockScopes: input.mode === 'write' ? [canonical.scope] : [],
        recovery: { kind: 'unknown' as const }
      };
    },
    async invoke(canonical, context) {
      if (context.signal?.aborted)
        throw context.signal.reason instanceof Error
          ? context.signal.reason
          : new Error('Tool aborted.');
      const output = parseJsonValue(await input.invoke(canonical.value, context), {
        maxDepth: 64,
        maxCollectionEntries: 50_000,
        maxStringBytes: 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024
      });
      const result =
        typeof output === 'object' && output !== null && !Array.isArray(output)
          ? output
          : undefined;
      const status =
        result && 'status' in result && typeof result.status === 'string'
          ? result.status
          : 'completed';
      return {
        kind: 'result',
        execution: { state: 'settled' },
        summary: `${input.name}: ${status}.`,
        output,
        scope: {
          resources: [canonical.scope],
          coverage:
            result && 'coverage' in result && result.coverage === 'partial' ? 'partial' : 'complete'
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
  if (!call) throw new Error('Session mutation requires a host tool invocation identity.');
  return `${call.runId}:${call.turnId}:${String(call.requestAttempt)}:${call.toolBatchId}:${String(call.callIndex)}`;
}
