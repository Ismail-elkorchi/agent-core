import { randomUUID } from 'node:crypto';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import * as z from 'zod';
import { statePageLimits, fitStatePage } from '../session/state-records.js';
import type { SessionStatePageRequest } from '../session/session-state.js';
import { MaterialAccessError, materialGrantSchema, type MaterialGrant, type MaterialGrantProvider, type MaterialOwner, type MaterialGrantPage } from './contracts.js';
import { MaterialOwnerLocks, materialOwnerKey } from './locks.js';
const cursorSchema = z.strictObject({ revision: z.int().nonnegative(), after: z.string() });
/** Host-owned test/embedded grant authority. No grant is inferred from material. */
export class InMemoryMaterialGrantProvider implements MaterialGrantProvider {
  private readonly grants = new Map<string, MaterialGrant>();
  private revision = 0;
  private readonly epoch = randomUUID();
  private generation = 0;
  private readable:readonly (readonly [string,MaterialGrant])[] = [];
  private ownGrant(input:MaterialGrant):MaterialGrant {
    if(!Number.isSafeInteger(++this.generation))throw new Error('Material grant generation exhausted.');
    return Object.freeze({...input,revision:`grant-${hashJson({epoch:this.epoch,generation:this.generation,revision:input.revision})}`});
  }
  private rebuild():void {this.readable=Object.freeze([...this.grants.entries()].filter(([,grant])=>grant.read).sort(([a],[b])=>a.localeCompare(b)));}
  private readonly locks = new MaterialOwnerLocks();
  constructor(grants: readonly MaterialGrant[] = []) {
    for (const input of grants) {
      const grant = materialGrantSchema.parse(input), key = materialOwnerKey(grant.owner);
      if (this.grants.has(key)) throw new Error('Duplicate material owner grant.');
      this.grants.set(key, this.ownGrant(grant));
    }
    this.rebuild();
  }
  get(owner: MaterialOwner): Promise<MaterialGrant | undefined> { return Promise.resolve(this.grants.get(materialOwnerKey(owner))); }
  async set(input: MaterialGrant, expectedRevision?: string): Promise<void> {
    const grant = materialGrantSchema.parse(input);
    await this.locks.withOwners([grant.owner], () => {
      const current = this.grants.get(materialOwnerKey(grant.owner));
      if (current?.revision !== expectedRevision) throw new PersistenceConflictError('Material grant changed.');
      this.grants.set(materialOwnerKey(grant.owner), this.ownGrant(grant)); this.revision++; this.rebuild();
      return Promise.resolve();
    });
  }
  async withdraw(owner: MaterialOwner, expectedRevision: string): Promise<void> {
    await this.locks.withOwners([owner], () => {
      if (this.grants.get(materialOwnerKey(owner))?.revision !== expectedRevision) throw new PersistenceConflictError('Material grant changed.');
      this.grants.delete(materialOwnerKey(owner)); this.revision++; this.rebuild();
      return Promise.resolve();
    });
  }
  withGrant<T>(owner: MaterialOwner, expectedRevision: string, access: 'read'|'write', operation: () => Promise<T>): Promise<T> {
    return this.locks.withOwners([owner], async () => {
      const grant = this.grants.get(materialOwnerKey(owner));
      if (!grant?.[access] || grant.revision !== expectedRevision) throw new MaterialAccessError();
      return operation();
    });
  }
  list(request: SessionStatePageRequest = {}): Promise<MaterialGrantPage> {
    const { limit, maxBytes } = statePageLimits(request);
    const cursor = request.cursor ? cursorSchema.parse(JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'))) : undefined;
    if (cursor && cursor.revision !== this.revision) throw new PersistenceConflictError('Material scope cursor grant revision changed.');
    const entries = this.readable;
    let start=0;
    if(cursor){let high=entries.length;while(start<high){const middle=Math.floor((start+high)/2);if((entries[middle]?.[0]??'')<=cursor.after)start=middle+1;else high=middle;}if(entries[start-1]?.[0]!==cursor.after)throw new Error('Invalid material scope cursor.');}
    return Promise.resolve(fitStatePage(entries.slice(start,start + limit), selected => {
      const partial = start + selected.length < entries.length;
      return { items: Object.freeze(selected.map(([,grant]) => grant)), coverage: partial ? 'partial' as const : 'complete' as const,
        ...(partial && selected.length ? { cursor: Buffer.from(JSON.stringify({revision:this.revision,after:selected.at(-1)?.[0]})).toString('base64url') } : {}) };
    }, maxBytes));
  }
}
