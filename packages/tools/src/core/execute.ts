import {
  MissingToolServiceError,
  throwIfAborted,
  ToolInputError,
  type ToolExecutionContext
} from './context.js';
import type { ToolObservation } from './definition.js';
import { beginToolInvocation, ToolInvocationAuthorityError, type ToolInvocation } from './plan.js';
import {
  invalidToolInputObservation,
  missingServiceObservation,
  runtimeErrorObservation,
  updateToolObservation
} from './observation.js';

export async function invokeToolCallPlan(
  invocation: ToolInvocation,
  context: ToolExecutionContext
): Promise<ToolObservation> {
  throwIfAborted(context.signal);
  // A failed read cannot leave an unconfirmed mutation. Settlement describes the
  // invocation boundary; the failure still describes unavailable or invalid evidence.
  const failureExecution = {
    state: invocation.effects.accesses.every((access) => access.mode === 'read')
      ? 'settled' as const
      : 'unknown' as const
  };
  try {
    const observation = await beginToolInvocation(invocation, context);
    return observation.kind === 'failure' && !observation.execution
      ? updateToolObservation(observation, { execution: failureExecution })
      : observation;
  } catch (error) {
    if (error instanceof ToolInvocationAuthorityError) throw error;
    if (context.signal?.aborted) throw error;
    if (error instanceof MissingToolServiceError)
      return updateToolObservation(
        missingServiceObservation(invocation.call.name, error.serviceName, error.details),
        { execution: failureExecution }
      );
    if (error instanceof ToolInputError)
      return updateToolObservation(
        invalidToolInputObservation(invocation.call.name, error.message, error.details),
        { execution: failureExecution }
      );
    return updateToolObservation(runtimeErrorObservation(invocation.call.name, error), {
      execution: failureExecution
    });
  }
}
