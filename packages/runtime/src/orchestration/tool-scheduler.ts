import { scopesOverlap, type ToolEffects } from '@agent-core/tools';

export interface SchedulableToolCall<T> { readonly callIndex: number; readonly effects: ToolEffects; readonly value: T }

export function scheduleToolCalls<T>(calls: readonly SchedulableToolCall<T>[], maxConcurrentToolCalls: number): readonly (readonly SchedulableToolCall<T>[])[] {
  if (!Number.isSafeInteger(maxConcurrentToolCalls) || maxConcurrentToolCalls < 1) throw new Error('maxConcurrentToolCalls must be a positive integer.');
  const byIndex = new Map(calls.map((call) => [call.callIndex, call]));
  if (byIndex.size !== calls.length) throw new Error('Tool call indices must be unique within a batch.');
  const waveByIndex = new Map<number, number>();
  const waves: SchedulableToolCall<T>[][] = [];
  for (const call of [...calls].sort((left, right) => left.callIndex - right.callIndex)) {
    const dependencies = call.effects.dependsOnCallIndices ?? [];
    for (const dependency of dependencies) {
      if (dependency >= call.callIndex || !byIndex.has(dependency)) throw new Error(`Tool call ${String(call.callIndex)} has invalid dependency ${String(dependency)}.`);
    }
    const earliestWave = dependencies.reduce((wave, dependency) => Math.max(wave, (waveByIndex.get(dependency) ?? -1) + 1), 0);
    let selected = earliestWave;
    for (;;) {
      const wave = waves[selected];
      if (!wave || (wave.length < maxConcurrentToolCalls && wave.every((existing) => !toolEffectsConflict(existing.effects, call.effects)))) break;
      selected += 1;
    }
    const selectedWave = waves[selected];
    if (selectedWave) selectedWave.push(call);
    else waves[selected] = [call];
    waveByIndex.set(call.callIndex, selected);
  }
  return Object.freeze(waves.map((wave) => Object.freeze(wave)));
}

export function lockScopesConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftScope) => right.some((rightScope) => scopesOverlap(leftScope, rightScope)));
}

export function toolEffectsConflict(left: ToolEffects, right: ToolEffects): boolean {
  if (lockScopesConflict(left.lockScopes, right.lockScopes)) return true;
  return left.accesses.some((leftAccess) => right.accesses.some((rightAccess) => scopesOverlap(leftAccess.scope, rightAccess.scope)
    && (leftAccess.mode !== 'read' || rightAccess.mode !== 'read')));
}
