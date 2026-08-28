import { MissingToolServiceError, throwIfAborted, ToolInputError, type ToolExecutionContext } from './context.js';
import type { ToolObservation } from './definition.js';
import { beginToolInvocation, ToolInvocationAuthorityError, type ToolInvocation } from './prepare.js';
import { invalidToolInputObservation, missingServiceObservation, runtimeErrorObservation } from './observation.js';

export async function invokePreparedToolCall(invocation: ToolInvocation, context: ToolExecutionContext): Promise<ToolObservation> {
  throwIfAborted(context.signal);
  try {
    return await beginToolInvocation(invocation, context);
  } catch (error) {
    if (error instanceof ToolInvocationAuthorityError) throw error;
    if (context.signal?.aborted) throw error;
    if (error instanceof MissingToolServiceError) return missingServiceObservation(invocation.call.name, error.serviceName, undefined, error.details);
    if (error instanceof ToolInputError) return invalidToolInputObservation(invocation.call.name, error.message, error.details);
    return runtimeErrorObservation(invocation.call.name, error);
  }
}
