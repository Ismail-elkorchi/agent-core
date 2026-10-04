import {
  CommandProcessOperationRejectedError,
  isCommandExecution,
  requireToolService,
  type CommandExecution,
  type CommandExecutionOwner,
  type CommandExecutionResult,
  type ToolExecutionContext
} from '@agent-core/tools';
import { processScope } from './resources.js';

export function commandExecutor(context: ToolExecutionContext): CommandExecution {
  return requireToolService(context, 'commandExecution', isCommandExecution, 'CommandExecution');
}

export function processOwner(context: ToolExecutionContext): CommandExecutionOwner {
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

export function processObservation(result: CommandExecutionResult) {
  const incomplete = result.combined.omittedBytes > 0 || result.cursorExpired === true;
  return {
    kind: 'result' as const,
    execution: { state: result.status === 'running' ? 'active' as const : 'settled' as const },
    summary: `Process ${result.processId} is ${result.status}.`,
    scope: {
      resources: [processScope(result.processId)],
      coverage: incomplete ? 'partial' as const : 'complete' as const,
      ...(incomplete ? {
        truncated: true,
        causes: [result.cursorExpired ? 'cursor_expired' : 'output_budget'],
        omitted: { bytes: result.combined.omittedBytes }
      } : {})
    },
    ...(result.artifact ? { content: [{ type: 'artifact' as const, artifact: result.artifact }] } : {}),
    output: result
  };
}

export function processOperationRejectedObservation(
  error: CommandProcessOperationRejectedError,
  execution: 'not_started' | 'settled' = 'not_started'
) {
  return {
    kind: 'failure' as const,
    execution: { state: execution },
    summary: error.message,
    scope: { resources: [processScope(error.processId)], coverage: 'complete' as const },
    output: { reason: 'runtime_error' as const, error: error.message,
      details: { processId: error.processId, cause: error.reason } }
  };
}

export function processQueryRecovery(
  processId: string,
  reconcilerId: string,
  context: ToolExecutionContext
) {
  return {
    kind: 'queryable' as const,
    service: commandExecutor(context).descriptor.recoveryIdentity,
    reconcilerId,
    externalExecutionId: processId,
    expiresAt: null
  };
}

export async function recoverProcessObservation(
  input: { readonly processId: string; readonly outputTokenBudget: number; readonly afterCursor: number },
  context: ToolExecutionContext,
  requireTerminal: boolean
) {
  try {
    const result = await commandExecutor(context).query(
      input.processId, input.outputTokenBudget, 0, input.afterCursor, processOwner(context)
    );
    return requireTerminal && result.status === 'running'
      ? { status: 'running' as const }
      : { status: 'settled' as const, observation: processObservation(result) };
  } catch (error) {
    if (error instanceof CommandProcessOperationRejectedError)
      return { status: 'not_found' as const, reason: error.message };
    throw error;
  }
}
