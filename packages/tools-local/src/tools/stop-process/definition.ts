import { defineTool, requireToolService, workspaceProcessScope } from '@agent-core/tools';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { isProcessManager, type ProcessManager, type ProcessOwner } from '../../core/process-manager.js';
import { presentProcessObservation } from '../../core/presenters.js';
import { stopProcessInputSchema, stopProcessOutputSchema } from './schema.js';

export const stopProcessTool = defineTool({
  name: 'stop_process', implementationId: 'agent-core.stop-process.v1',
  description: 'Idempotently stop a process started by exec_command.',
  schema: stopProcessInputSchema, outputSchema: stopProcessOutputSchema,
  presentObservation: presentProcessObservation,
  requirements: { services: ['localToolConfiguration', 'processManager'] },
  effectEnvelope: { accesses: [{ mode: 'execute', scope: workspaceProcessScope() }], lockScopes: [workspaceProcessScope()] },
  canonicalizeInput(input, context) { return { ...input, outputTokenBudget: clampRequestedLimit(input.outputTokenBudget, requireLocalToolConfiguration(context).process.maxOutputTokens) }; },
  deriveEffects(input) {
    return { accesses: [{ mode: 'execute' as const, scope: workspaceProcessScope(input.processId) }], lockScopes: [workspaceProcessScope(input.processId)], idempotency: 'idempotent' as const, idempotencyKey: 'stop:' + input.processId };
  },
  async invoke(input, context) {
    const manager = requireToolService<ProcessManager>(context, 'processManager', isProcessManager, 'ProcessManager');
    const owner = processOwner(context.invocation);
    await manager.stop(input.processId, owner);
    await context.emitProgress?.({ type: 'status', stage: 'process_stopped', message: 'Process stopped.' });
    const result = await manager.poll(input.processId, input.outputTokenBudget, 0, input.afterCursor, owner);
    return {
      kind: 'result' as const, ok: true, summary: 'Process ' + result.processId + ' is ' + result.status + '.',
      scope: {
        resources: [workspaceProcessScope(result.processId)], coverage: result.combined.omittedBytes > 0 || result.cursorExpired ? 'partial' : 'complete',
        ...(result.combined.omittedBytes > 0 || result.cursorExpired ? { truncated: true, causes: [result.cursorExpired ? 'cursor_expired' : 'output_budget'], omitted: { bytes: result.combined.omittedBytes } } : {})
      },
      ...(result.artifact ? { content: [{ type: 'artifact' as const, artifact: result.artifact }] } : {}), output: result
    };
  }
});
function processOwner(invocation: import('@agent-core/tools').ToolInvocationContext | undefined): ProcessOwner {
  if (!invocation) throw new Error('Process tools require a runtime invocation owner.');
  return Object.freeze({ runId: invocation.runId, turnId: invocation.turnId, toolBatchId: invocation.toolBatchId, callIndex: invocation.callIndex });
}
