import { MissingToolServiceError, throwIfAborted, ToolInputError, type ToolExecutionContext } from './context.js';
import type { ToolObservation } from './definition.js';
import type { PreparedToolCall } from './prepare.js';
import { invalidToolInputObservation, missingServiceObservation, runtimeErrorObservation } from './observation.js';

export async function invokePreparedToolCall(prepared: PreparedToolCall, context: ToolExecutionContext): Promise<ToolObservation> {
  throwIfAborted(context.signal);
  try {
    return await prepared.invoke(context);
  } catch (error) {
    if (context.signal?.aborted) throw error;
    if (error instanceof MissingToolServiceError) return missingServiceObservation(prepared.call.name, error.serviceName, undefined, error.details);
    if (error instanceof ToolInputError) return invalidToolInputObservation(prepared.call.name, error.message, error.details);
    return runtimeErrorObservation(prepared.call.name, error);
  }
}
