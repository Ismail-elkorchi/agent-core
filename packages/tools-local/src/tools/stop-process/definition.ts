import { defineTool, requireToolService } from '@agent-core/tools';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { isProcessManager, type ProcessManager } from '../../core/process-manager.js';
import { stopProcessInputSchema, stopProcessOutputSchema } from './schema.js';

export const stopProcessTool = defineTool({
  name: 'stop_process',
  implementationId: 'agent-core.stop-process.v1',
  description: 'Stop a process started by exec_command without invoking a shell command.',
  schema: stopProcessInputSchema,
  outputSchema: stopProcessOutputSchema,
  effectEnvelope: { accesses: [{ mode: 'execute', scope: 'processes' }], lockScopes: ['processes'] },
  canonicalizeInput(input, context) {
    return { ...input, outputTokenBudget: clampRequestedLimit(input.outputTokenBudget, requireLocalToolConfiguration(context).process.maxOutputTokens) };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'execute', scope: `processes/${input.processId}` }], lockScopes: [`processes/${input.processId}`], idempotency: 'idempotent', idempotencyKey: `stop:${input.processId}` };
  },
  async invoke(input, context) {
    const manager = requireToolService<ProcessManager>(context, 'processManager', isProcessManager, 'ProcessManager');
    await manager.stop(input.processId);
    const result = await manager.poll(input.processId, input.outputTokenBudget);
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Process ${result.processId} is ${result.status}.`,
      scope: { resources: [`processes/${result.processId}`], coverage: result.combined.omittedBytes > 0 ? 'partial' : 'complete', ...(result.combined.omittedBytes > 0 ? { cause: 'output token budget reached' } : {}) },
      content: [{ type: 'artifact' as const, artifact: result.artifact }],
      output: result
    };
  }
});
