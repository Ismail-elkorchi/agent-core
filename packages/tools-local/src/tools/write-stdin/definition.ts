import { defineTool, requireToolService } from '@agent-core/tools';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { isProcessManager, type ProcessManager } from '../../core/process-manager.js';
import { isSuccessfulProcessResult } from '../process-output.js';
import { writeStdinInputSchema, writeStdinOutputSchema } from './schema.js';

export const writeStdinTool = defineTool({
  name: 'write_stdin',
  implementationId: 'agent-core.write-stdin.v1',
  description: 'Write to, close, or poll a process started by exec_command and return only new output.',
  schema: writeStdinInputSchema,
  outputSchema: writeStdinOutputSchema,
  effectEnvelope: { accesses: [{ mode: 'execute', scope: 'processes' }], lockScopes: ['processes'] },
  canonicalizeInput(input, context) {
    const limits = requireLocalToolConfiguration(context).process;
    return {
      ...input,
      yieldMs: clampRequestedLimit(input.yieldMs, limits.maxYieldMs),
      outputTokenBudget: clampRequestedLimit(input.outputTokenBudget, limits.maxOutputTokens)
    };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'execute', scope: `processes/${input.processId}` }], lockScopes: [`processes/${input.processId}`], idempotency: 'non_idempotent' };
  },
  async invoke(input, context) {
    const manager = requireToolService<ProcessManager>(context, 'processManager', isProcessManager, 'ProcessManager');
    if (input.text !== undefined && input.text.length > 0) await manager.write(input.processId, input.text);
    if (input.closeStdin) await manager.closeStdin(input.processId);
    const result = await manager.poll(input.processId, input.outputTokenBudget, input.yieldMs);
    return {
      kind: 'result' as const,
      ok: isSuccessfulProcessResult(result),
      summary: result.status === 'running' ? `Process ${result.processId} is still running.` : `Process ${result.processId} is ${result.status}.`,
      scope: { resources: [`processes/${result.processId}`], coverage: result.combined.omittedBytes > 0 ? 'partial' : 'complete', ...(result.combined.omittedBytes > 0 ? { cause: 'output token budget reached' } : {}) },
      content: [{ type: 'artifact' as const, artifact: result.artifact }],
      output: result
    };
  }
});
