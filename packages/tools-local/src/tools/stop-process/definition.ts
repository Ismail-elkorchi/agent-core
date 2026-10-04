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
  deriveEffects(input, context) {
    return {
      accesses: [{ mode: 'execute' as const, scope: processScope(input.processId) }],
      lockScopes: [processScope(input.processId)],
      recovery:  processQueryRecovery(input.processId, 'agent-core.stop-process@1', context)
    };
  },
  recover: (input, _effect, context) => recoverProcessObservation(input, context, true),
  async invoke(input, context) {
    const executor = commandExecutor(context);
    const owner = processOwner(context);
    let terminationConfirmed = false;
    try {
      await executor.terminate(input.processId, owner);
      terminationConfirmed = true;
      return processObservation(await executor.query(
        input.processId, input.outputTokenBudget, 0, input.afterCursor, owner
      ));
    } catch (error) {
      if (error instanceof CommandProcessOperationRejectedError)
        return processOperationRejectedObservation(error, terminationConfirmed ? 'settled' : 'not_started');
      throw error;
    }
  }
});
