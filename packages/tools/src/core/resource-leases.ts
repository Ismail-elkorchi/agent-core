import { scopesOverlap, type ToolEffects, type ToolResourceAccess } from './authorization.js';
import type { ToolResourceLease } from './context.js';

interface ActiveLease { readonly id: number; readonly owner: string; readonly effects: ToolEffects; processId?: string }
interface Waiter { readonly effects: ToolEffects; readonly owner: string; readonly resolve: (lease: ToolResourceLease) => void; readonly reject: (error: Error) => void; readonly signal?: AbortSignal; abort?: () => void }

export class ResourceLeaseCoordinator {
  private readonly active = new Map<number, ActiveLease>();
  private readonly waiters: Waiter[] = [];
  private nextId = 1;

  acquire(effects: ToolEffects, owner: string, signal?: AbortSignal): Promise<ToolResourceLease> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { effects, owner, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(signal));
          this.drain();
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  /** FIFO for conflicting waiters, with compatible batching when no earlier waiter conflicts. */
  wouldWait(effects: ToolEffects): boolean {
    return [...this.active.values()].some((lease) => leasesConflict(lease, effects))
      || this.waiters.some((waiter) => effectsConflict(waiter.effects, effects));
  }

  releaseProcess(processId: string): void {
    for (const active of this.active.values()) if (active.processId === processId) this.releaseLease(active.id);
  }
  activeCount(): number { return this.active.size; }

  private drain(): void {
    const retained: Waiter[] = [];
    for (const waiter of this.waiters.splice(0)) {
      const conflictsWithActive = [...this.active.values()].some((lease) => leasesConflict(lease, waiter.effects));
      const bypassesEarlierConflict = retained.some((earlier) => effectsConflict(earlier.effects, waiter.effects));
      if (conflictsWithActive || bypassesEarlierConflict) { retained.push(waiter); continue; }
      if (waiter.abort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.abort);
      const active: ActiveLease = { id: this.nextId++, owner: waiter.owner, effects: waiter.effects };
      this.active.set(active.id, active);
      waiter.resolve(new Lease(this, active));
    }
    this.waiters.push(...retained);
  }
  releaseLease(id: number): void { if (this.active.delete(id)) this.drain(); }
  transferLease(id: number, processId: string): void {
    const active = this.active.get(id);
    if (!active) throw new Error('Cannot transfer a released resource lease.');
    if (active.processId !== undefined && active.processId !== processId) throw new Error('Resource lease is already owned by another process.');
    active.processId = processId;
  }
}

class Lease implements ToolResourceLease {
  private released = false;
  private processId: string | undefined;
  constructor(private readonly coordinator: ResourceLeaseCoordinator, private readonly active: ActiveLease) {}
  get transferred(): boolean { return this.processId !== undefined; }
  transferToProcess(processId: string): void {
    if (this.released || processId.trim().length === 0) throw new Error('Cannot transfer this resource lease.');
    this.coordinator.transferLease(this.active.id, processId);
    this.processId = processId;
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    this.coordinator.releaseLease(this.active.id);
  }
}
function leasesConflict(active: ActiveLease, waiting: ToolEffects): boolean {
  if (active.processId !== undefined && processControlOnly(waiting, active.processId)) return false;
  return effectsConflict(active.effects, waiting);
}
function processControlOnly(effects: ToolEffects, processId: string): boolean {
  const scope = 'workspace/processes/' + processId;
  return effects.accesses.length > 0 && effects.accesses.every((access) => access.mode === 'execute' && access.scope === scope)
    && effects.lockScopes.every((lock) => lock === scope);
}
export function effectsConflict(left: ToolEffects, right: ToolEffects): boolean {
  if (left.lockScopes.some((a) => right.lockScopes.some((b) => scopesOverlap(a, b)))) return true;
  if (left.lockScopes.some((lock) => right.accesses.some((access) => scopesOverlap(lock, access.scope)))) return true;
  if (right.lockScopes.some((lock) => left.accesses.some((access) => scopesOverlap(lock, access.scope)))) return true;
  return left.accesses.some((a) => right.accesses.some((b) => accessConflict(a, b)));
}
function accessConflict(left: ToolResourceAccess, right: ToolResourceAccess): boolean {
  return scopesOverlap(left.scope, right.scope) && (left.mode !== 'read' || right.mode !== 'read');
}
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'Resource lease acquisition aborted.');
}
