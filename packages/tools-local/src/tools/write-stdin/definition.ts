import { CommandProcessOperationRejectedError, defineTool } from '@agent-core/tools';
import {
  commandExecutor,
  processObservation,
  processOwner,
  processQueryRecovery,
  processOperationRejectedObservation,
  recoverProcessObservation
} from '../../core/process-control.js';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { buildProcessContent } from '../../core/model-content.js';
import { processScope } from '../../core/resources.js';
import { writeStdinInputSchema, writeStdinOutputSchema } from './schema.js';

export const writeStdinTool = defineTool({
  name: 'write_stdin',
  implementationId: 'agent-core.write-stdin.v1',
  description:
    'Write to, close, or poll a process started by exec_command using a stable output cursor.',
  schema: writeStdinInputSchema,
  outputSchema: writeStdinOutputSchema,
  buildModelContent: buildProcessContent,
  requirements: { services: ['localToolConfiguration', 'commandExecution'] },
  effectEnvelope: {
    accesses: [{ mode: 'execute', scope: processScope() }],
    lockScopes: [processScope()]
  },
  canonicalizeInput(input, context) {
    const limits = requireLocalToolConfiguration(context).process;
    return {
      ...input,
      yieldMs: clampRequestedLimit(input.yieldMs, limits.maxYieldMs),
      outputTokenBudget: clampRequestedLimit(input.outputTokenBudget, limits.maxOutputTokens)
    };
  },
  deriveEffects(input, context) {
    return {
      accesses: [{ mode: 'execute' as const, scope: processScope(input.processId) }],
      lockScopes: [processScope(input.processId)],
      recovery: input.text || input.closeStdin ? { kind: 'unknown' as const } : processQueryRecovery(input.processId, 'agent-core.write-stdin@1', context)
    };
  },
  recover: (input, _effect, context) => recoverProcessObservation(input, context, false),
  async invoke(input, context) {
    const executor = commandExecutor(context);
    const owner = processOwner(context);
    let inputChanged = false;
    try {
      if (input.text !== undefined && input.text.length > 0) {
        await executor.writeInput(input.processId, input.text, owner);
        inputChanged = true;
      }
      if (input.closeStdin) {
        await executor.closeInput(input.processId, owner);
        inputChanged = true;
      }
      const result = await executor.query(
        input.processId, input.outputTokenBudget, input.yieldMs, input.afterCursor, owner
      );
      return processObservation(result);
    } catch (error) {
      if (error instanceof CommandProcessOperationRejectedError)
        return processOperationRejectedObservation(error, executor, owner, input.outputTokenBudget,
          inputChanged ? 'settled' : 'not_started');
      throw error;
    }
  }
});
