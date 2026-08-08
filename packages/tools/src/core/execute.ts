import { MissingToolServiceError, throwIfAborted, ToolInputError, type ToolExecutionContext } from './context.js';
import type { ToolObservation } from './definition.js';
import type { PreparedToolCall } from './prepare.js';
import { invalidOutputObservation, invalidToolInputObservation, missingServiceObservation, runtimeErrorObservation } from './observation.js';

export async function invokePreparedToolCall(prepared: PreparedToolCall, context: ToolExecutionContext): Promise<ToolObservation> {
  throwIfAborted(context.signal);
  try {
    const observation = await prepared.tool.invoke(prepared.canonicalInput, context);
    if (observation.kind === 'failure') return observation;
    const parsed = prepared.tool.outputSchema.safeParse(observation.output);
    if (!parsed.success) return invalidOutputObservation(prepared.tool.name, parsed.error);
    return { ...observation, output: parsed.data };
  } catch (error) {
    if (context.signal?.aborted) throw error;
    if (error instanceof MissingToolServiceError) return missingServiceObservation(prepared.tool.name, error.serviceName, undefined, error.details);
    if (error instanceof ToolInputError) return invalidToolInputObservation(prepared.tool.name, error.message, error.details);
    return runtimeErrorObservation(prepared.tool.name, error);
  }
}
