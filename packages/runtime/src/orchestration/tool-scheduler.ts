import type { ToolEffects } from '@agent-core/tools';

export interface SchedulableToolCall<T> { readonly callIndex: number; readonly effects: ToolEffects; readonly value: T }

/** Builds deterministic waves. Calls inside a wave may run concurrently; waves and persisted results stay in source order. */
export function scheduleToolCalls<T>(calls: readonly SchedulableToolCall<T>[], maxConcurrentToolCalls: number): readonly (readonly SchedulableToolCall<T>[])[] {
  if (!Number.isInteger(maxConcurrentToolCalls) || maxConcurrentToolCalls < 1) {
    throw new Error('maxConcurrentToolCalls must be a positive integer.');
  }
  const waves: SchedulableToolCall<T>[][] = [];
  const waveByCallIndex = new Map<number, number>();
  for (const call of [...calls].sort((left, right) => left.callIndex - right.callIndex)) {
    const dependencies = call.effects.dependsOnCallIndices ?? [];
    if (dependencies.some((dependency) => dependency >= call.callIndex)) throw new Error(`Tool call ${String(call.callIndex)} has a forward or self dependency.`);
    const earliestWave = dependencies.reduce((minimum, dependency) => {
      const dependencyWave = waveByCallIndex.get(dependency);
      if (dependencyWave === undefined) throw new Error(`Tool call ${String(call.callIndex)} depends on unavailable call ${String(dependency)}.`);
      return Math.max(minimum, dependencyWave + 1);
    }, 0);
    let selected = -1;
    for (let waveIndex = earliestWave; waveIndex < waves.length; waveIndex += 1) {
      const wave = waves[waveIndex];
      if (wave && wave.length < maxConcurrentToolCalls && wave.every((existing) => !effectsConflict(existing.effects, call.effects))) { selected = waveIndex; break; }
    }
    if (selected < 0) { selected = waves.length; waves.push([]); }
    const selectedWave = waves[selected];
    if (!selectedWave) throw new Error(`Tool scheduler failed to allocate wave ${String(selected)}.`);
    selectedWave.push(call);
    waveByCallIndex.set(call.callIndex, selected);
  }
  return Object.freeze(waves.map((wave) => Object.freeze(wave)));
}

export function effectsConflict(left: ToolEffects, right: ToolEffects): boolean {
  if (left.idempotency === 'non_idempotent' || right.idempotency === 'non_idempotent') return true;
  if (left.kind === 'read' && right.kind === 'read') return false;
  if (left.kind === 'mixed' || right.kind === 'mixed') return true;
  const scopesOverlap = left.resourceScopes.some((leftScope) => right.resourceScopes.some((rightScope) => scopeOverlaps(leftScope, rightScope)));
  return scopesOverlap;
}

function scopeOverlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
