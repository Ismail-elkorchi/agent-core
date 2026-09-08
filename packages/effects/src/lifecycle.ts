/** Persistence and fencing belong to the authority that admitted this effect. */
export interface EffectLifecycle<TResult, TObservation> {
  start(): Promise<void>;
  settle(observation: TObservation): Promise<TResult>;
  uncertain(cause: unknown): Promise<TResult>;
}

/** A settlement failure never makes a dispatched effect safe to repeat. */
export async function executeEffectLifecycle<TResult, TObservation>(
  lifecycle: EffectLifecycle<TResult, TObservation>,
  dispatch: () => Promise<TObservation>
): Promise<TResult> {
  await lifecycle.start();
  let observation: TObservation;
  try {
    observation = await dispatch();
  } catch (cause) {
    return lifecycle.uncertain(cause);
  }
  return lifecycle.settle(observation);
}
