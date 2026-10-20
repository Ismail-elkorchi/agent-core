import { AsyncLocalStorage } from 'node:async_hooks';
import { hashJson } from '@agent-core/persistence';
import { materialOwnerSchema, type MaterialOwner } from './contracts.js';
export function materialOwnerKey(owner: MaterialOwner): string { return `material-${hashJson(materialOwnerSchema.parse(owner))}`; }
/** Short publication locks only. Never enclose inference or external execution. */
interface Lease {readonly keys:ReadonlySet<string>;active:boolean}
export class MaterialOwnerLocks {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly held = new AsyncLocalStorage<readonly Lease[]>();
  constructor(private readonly external?: (<T>(key: string, operation: () => Promise<T>) => Promise<T>) | undefined) {}
  withOwners<T>(owners: readonly MaterialOwner[], operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(owners.map(materialOwnerKey))].sort();
    const active=(this.held.getStore()??[]).filter(lease=>lease.active),held=new Set<string>();
    for(const lease of active)for(const key of lease.keys)held.add(key);
    if (keys.every(key => held.has(key))) return operation();
    const lastHeld=[...held].sort().at(-1);
    if (lastHeld!==undefined && keys.some(key => !held.has(key) && key <= lastHeld))
      return Promise.reject(new Error('Nested material publication must retain canonical owner lock order.'));
    const needed = keys.filter(key => !held.has(key));
    const lock = (index: number): Promise<T> => {
      const key = needed[index];
      if (!key) {
        const lease:Lease={keys:new Set(needed),active:true};
        return this.held.run([...active,lease],async()=>{try{return await operation();}finally{lease.active=false;}});
      }
      const prior = this.queues.get(key) ?? Promise.resolve();
      const result = prior.then(() => this.external ? this.external(key, () => lock(index + 1)) : lock(index + 1));
      const tail = result.then(() => undefined, () => undefined);
      this.queues.set(key, tail);
      void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
      return result;
    };
    return lock(0);
  }
}
