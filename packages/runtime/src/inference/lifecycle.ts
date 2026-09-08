import type { ModelResponse } from '@agent-core/model';

/** Durable authority supplied by a run driver or an invocation repository. */
export interface InferenceLifecycle<TResult, TResponse = ModelResponse> {
  start(): Promise<void>;
  settle(response: TResponse): Promise<TResult>;
  uncertain(cause: unknown): Promise<TResult>;
}

/** Start once, persist the response before consuming it, and never retry an unknown dispatch. */
export async function executeInferenceLifecycle<TResult, TResponse = ModelResponse>(
  lifecycle: InferenceLifecycle<TResult, TResponse>,
  dispatch: () => Promise<TResponse>
): Promise<TResult> {
  await lifecycle.start();
  let response: TResponse;
  try {
    response = await dispatch();
  } catch (cause) {
    return lifecycle.uncertain(cause);
  }
  // A failed local settlement is not evidence that the provider did not execute.
  // Leave the original start and response artifact available to reconciliation.
  return lifecycle.settle(response);
}
