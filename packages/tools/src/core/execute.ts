import { MissingToolServiceError, throwIfAborted, ToolInputError, type ToolExecutionContext } from './context.js';
import type { ToolObservation } from './definition.js';
import type { PreparedToolCall } from './prepare.js';
import { invalidOutputObservation, invalidToolInputObservation, missingServiceObservation, parseToolObservation, runtimeErrorObservation } from './observation.js';

export async function invokePreparedToolCall(prepared: PreparedToolCall, context: ToolExecutionContext): Promise<ToolObservation> {
  throwIfAborted(context.signal);
  try {
    const observation = await prepared.tool.invoke(prepared.canonicalInput, context);
    try { return parseToolObservation(prepared.tool, observation); }
    catch (error) { return parseToolObservation(undefined, invalidOutputObservation(prepared.tool.name, error instanceof Error ? error : new Error(String(error)))); }
  } catch (error) {
    if (context.signal?.aborted) throw error;
    if (error instanceof MissingToolServiceError) return parseToolObservation(undefined, missingServiceObservation(prepared.tool.name, error.serviceName, undefined, error.details));
    if (error instanceof ToolInputError) return parseToolObservation(undefined, invalidToolInputObservation(prepared.tool.name, error.message, error.details));
    return parseToolObservation(undefined, runtimeErrorObservation(prepared.tool.name, error));
  }
}
