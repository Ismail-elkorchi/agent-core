import { defineTool, requireToolService } from '@agent-core/tools';
import { workspaceProcessScope } from '../../core/resources.js';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { isProcessManager, type ProcessManager, type ProcessOwner } from '../../core/process-manager.js';
import { presentProcessObservation } from '../../core/presenters.js';
import { isSuccessfulProcessResult } from '../process-output.js';
import { writeStdinInputSchema, writeStdinOutputSchema } from './schema.js';

export const writeStdinTool = defineTool({
  name: 'write_stdin', implementationId: 'agent-core.write-stdin.v1',
  description: 'Write to, close, or poll a process started by exec_command using a stable output cursor.',
  schema: writeStdinInputSchema, outputSchema: writeStdinOutputSchema,
  presentObservation: presentProcessObservation,
  requirements: { services: ['localToolConfiguration', 'processManager'] },
  effectEnvelope: { accesses: [{ mode: 'execute', scope: workspaceProcessScope() }], lockScopes: [workspaceProcessScope()] },
  canonicalizeInput(input, context) {
    const limits = requireLocalToolConfiguration(context).process;
    return { ...input, yieldMs: clampRequestedLimit(input.yieldMs, limits.maxYieldMs), outputTokenBudget: clampRequestedLimit(input.outputTokenBudget, limits.maxOutputTokens) };
  },
  deriveEffects(input) {
    const idempotency = input.text !== undefined && input.text.length > 0
      ? { idempotency: 'non_idempotent' as const }
      : input.closeStdin
        ? { idempotency: 'idempotent' as const, idempotencyKey: 'close:' + input.processId }
        : { idempotency: 'pure' as const };
    return { accesses: [{ mode: 'execute' as const, scope: workspaceProcessScope(input.processId) }], lockScopes: [workspaceProcessScope(input.processId)], ...idempotency };
  },
  async invoke(input, context) {
    const manager = requireToolService<ProcessManager>(context, 'processManager', isProcessManager, 'ProcessManager');
    const owner = processOwner(context.invocation);
    if (input.text !== undefined && input.text.length > 0) await manager.write(input.processId, input.text, owner);
    if (input.closeStdin) await manager.closeStdin(input.processId, owner);
    const result = await manager.poll(input.processId, input.outputTokenBudget, input.yieldMs, input.afterCursor, owner);
    return {
      kind: 'result' as const, ok: isSuccessfulProcessResult(result),
      summary: result.status === 'running' ? 'Process ' + result.processId + ' is still running.' : 'Process ' + result.processId + ' is ' + result.status + '.',
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
