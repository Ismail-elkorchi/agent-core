import {
  defineTool,
  isCommandExecution,
  requireToolService,
  type CommandExecution,
  type CommandExecutionOwner
} from '@agent-core/tools';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { buildProcessContent } from '../../core/model-content.js';
import { processScope } from '../../core/resources.js';
import { stopProcessInputSchema, stopProcessOutputSchema } from './schema.js';

export const stopProcessTool = defineTool({
  name: 'stop_process',
  implementationId: 'agent-core.stop-process.v1',
  description: 'Idempotently stop a process started by exec_command.',
  schema: stopProcessInputSchema,
  outputSchema: stopProcessOutputSchema,
  buildModelContent: buildProcessContent,
  requirements: { services: ['localToolConfiguration', 'commandExecution'] },
  effectEnvelope: {
    accesses: [{ mode: 'execute', scope: processScope() }],
    lockScopes: [processScope()]
  },
  canonicalizeInput(input, context) {
    return {
      ...input,
      outputTokenBudget: clampRequestedLimit(
        input.outputTokenBudget,
        requireLocalToolConfiguration(context).process.maxOutputTokens
      )
    };
  },
  deriveEffects(input) {
    return {
      accesses: [{ mode: 'execute' as const, scope: processScope(input.processId) }],
      lockScopes: [processScope(input.processId)],
      recovery: { kind: 'unknown' as const }
    };
  },
  async invoke(input, context) {
    const executor = requireToolService<CommandExecution>(
      context,
      'commandExecution',
      isCommandExecution,
      'CommandExecution'
    );
    const owner = processOwner(context);
    await executor.terminate(input.processId, owner);
    const result = await executor.query(
      input.processId,
      input.outputTokenBudget,
      0,
      input.afterCursor,
      owner
    );
    return {
      kind: 'result' as const,
      execution: {
        state: result.status === 'running' ? ('active' as const) : ('settled' as const)
      },
      summary: 'Process ' + result.processId + ' is ' + result.status + '.',
      scope: {
        resources: [processScope(result.processId)],
        coverage: result.combined.omittedBytes > 0 || result.cursorExpired ? 'partial' : 'complete',
        ...(result.combined.omittedBytes > 0 || result.cursorExpired
          ? {
              truncated: true,
              causes: [result.cursorExpired ? 'cursor_expired' : 'output_budget'],
              omitted: { bytes: result.combined.omittedBytes }
            }
          : {})
      },
      ...(result.artifact
        ? { content: [{ type: 'artifact' as const, artifact: result.artifact }] }
        : {}),
      output: result
    };
  }
});
function processOwner(
  context: import('@agent-core/tools').ToolExecutionContext
): CommandExecutionOwner {
  const invocation = context.invocation;
  if (!invocation) throw new Error('Process tools require a runtime invocation owner.');
  return Object.freeze({
    ownerId: context.resourceOwnerId ?? invocation.runId,
    runId: invocation.runId,
    turnId: invocation.turnId,
    toolBatchId: invocation.toolBatchId,
    callIndex: invocation.callIndex
  });
}
