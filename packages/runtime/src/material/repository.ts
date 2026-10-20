import * as z from 'zod';
import { parseJsonObject } from '@agent-core/json';
import { InMemoryEventRepository, PersistenceConflictError, hashJson, type EventRepository, type EventCodec, type EventLedgerTail } from '@agent-core/persistence';
import { sessionStateBatchCommitSchema, sessionStateBatchStorageBytes, sessionStateItemRefSchema, validateSessionStateCommit,
  type SessionStateBatchCommit, type SessionStatePageRequest, type SessionStateBatchReceipt } from '../session/session-state.js';
import { advanceMemoryState, emptyMemoryStateIndex, assertStateRetry, stateReceipt, statePageLimits, fitStatePage, stateItemMetadata, type MemoryStateIndex } from '../session/state-records.js';
import { materialOwnerSchema, MaterialAccessError, type MaterialOwner, type MaterialRepository, type QualifiedMaterialRef,
  type MaterialRevocation, type MaterialRevocationReceipt, type MaterialPage } from './contracts.js';
import { MaterialOwnerLocks, materialOwnerKey } from './locks.js';

export type MaterialEvent =
  | { readonly type:'material.batch'; readonly format:'agent-core.material/1'; readonly batch:SessionStateBatchCommit }
  | { readonly type:'material.revoked'; readonly format:'agent-core.material/1'; readonly owner:MaterialOwner;
      readonly operationId:string; readonly expectedRevision:number; readonly revision:number; readonly refs:MaterialRevocation['refs'] };
export const materialRevocationSchema = z.strictObject({ owner:materialOwnerSchema, operationId:z.string().min(1).max(512),
  expectedRevision:z.int().nonnegative(), refs:z.array(sessionStateItemRefSchema.refine(ref=>ref.range===undefined,'Revocation targets complete revisions, not excerpt ranges.')).min(1).max(256).readonly() }).readonly();
const eventSchema = z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('material.batch'),format:z.literal('agent-core.material/1'),batch:sessionStateBatchCommitSchema}).readonly(),
  materialRevocationSchema.unwrap().extend({type:z.literal('material.revoked'),format:z.literal('agent-core.material/1'),revision:z.int().positive()}).readonly()
]);
export const materialEventCodec:EventCodec<MaterialEvent> = {
  encode:event=>parseJsonObject(eventSchema.parse(event)), decode:value=>eventSchema.parse(value)
};
interface Projection { readonly tail:EventLedgerTail; readonly index:MemoryStateIndex; readonly retainedBytes:number; readonly revision:number; readonly revoked:ReadonlySet<string> }
const empty:Projection = {tail:{sequence:-1,driverGeneration:0},index:emptyMemoryStateIndex,retainedBytes:0,revision:0,revoked:new Set()};
const sharedLocks = new WeakMap<object,MaterialOwnerLocks>();
const cursorSchema = z.strictObject({ owner:materialOwnerSchema, sequence:z.int().nonnegative(), hash:z.string(), revision:z.int().nonnegative(), after:z.string() });
/** Shared scopes use their own material journal. The revision/CAS/projection algorithm is the session algorithm. */
export interface MaterialPublicationFence {withOwner<T>(key:string,operation:()=>Promise<T>):Promise<T>}
export class EventMaterialRepository implements MaterialRepository {
  private readonly projections = new Map<string,Projection>();
  private readonly locks:MaterialOwnerLocks;
  constructor(private readonly events:EventRepository<MaterialEvent>, fence?:MaterialPublicationFence) {
    this.locks = fence ? new MaterialOwnerLocks((key,operation)=>fence.withOwner(key,operation)) : sharedLocks.get(events) ?? new MaterialOwnerLocks();
    if (!fence) sharedLocks.set(events,this.locks);
  }
  withOwners<T>(owners:readonly MaterialOwner[],operation:()=>Promise<T>):Promise<T> { return this.locks.withOwners(owners,operation); }
  private async projection(owner:MaterialOwner):Promise<Projection> {
    owner=materialOwnerSchema.parse(owner);
    if(owner.kind!=='scope')throw new Error('Session-owned material authority resides in the session journal.');
    const key=materialOwnerKey(owner), tail=await this.events.tail(key);
    let current=this.projections.get(key) ?? empty;
    if(current.tail.sequence>tail.sequence)throw new PersistenceConflictError('Material journal moved behind its published projection.');
    while(current.tail.sequence<tail.sequence) {
      const page=await this.events.readRange(key,{afterSequence:current.tail.sequence,through:tail,limit:128,maxBytes:16*1024*1024});
      if(!page.records.length)throw new Error('Material journal cannot advance within its bounded replay page.');
      for(const record of page.records) {
        const event=record.event;
        if(hashJson(event.type==='material.batch'?event.batch.owner:event.owner)!==hashJson(owner))throw new Error('Material journal owner mismatch.');
        if(event.type==='material.batch') {
          for(const revision of event.batch.revisions)if(revision.previousRevisionId!==null&&current.revoked.has(revocationKey({itemId:revision.itemId,revisionId:revision.previousRevisionId})))throw new Error('Material journal mutates a revoked revision.');
          await validateSessionStateCommit(event.batch,itemId=>Promise.resolve(current.index.heads.get(itemId)),current.retainedBytes);
          const index=advanceMemoryState(current.index,{type:'material_batch',id:record.eventId,batch:event.batch});
          current={...current,index,retainedBytes:current.retainedBytes+sessionStateBatchStorageBytes(event.batch)};
        } else {
          if(event.expectedRevision!==current.revision||event.revision!==current.revision+1)throw new Error('Material revocation revision is not consecutive.');
          if(new Set(event.refs.map(revocationKey)).size!==event.refs.length)throw new Error('Duplicate material journal revocation target.');
          const revoked=new Set(current.revoked);
          for(const ref of event.refs){if(current.index.revisions.get(ref.revisionId)?.itemId!==ref.itemId)throw new Error('Material journal revokes an unavailable revision.');revoked.add(revocationKey(ref));}
          current={...current,revision:event.revision,revoked};
        }
        current={...current,tail:{sequence:record.sequence,hash:record.hash,driverGeneration:record.driverGeneration}};
      }
    }
    this.projections.delete(key);
    this.projections.set(key,current);
    if(this.projections.size>128){const oldest=this.projections.keys().next().value;if(oldest)this.projections.delete(oldest);}
    return current;
  }
  async findBatch(owner:MaterialOwner,idempotencyKey:string):Promise<SessionStateBatchReceipt|undefined> {
    const entry=(await this.projection(owner)).index.batches.get(idempotencyKey);
    return entry?stateReceipt(entry):undefined;
  }
  async save(input:SessionStateBatchCommit):Promise<SessionStateBatchReceipt> {
    const batch=sessionStateBatchCommitSchema.parse(input);
    if(batch.owner.kind!=='scope')throw new Error('Session-owned batches must use the session journal and its atomic context boundary.');
    return this.withOwners([batch.owner],async()=>{
      for(;;) {
        const state=await this.projection(batch.owner), previous=state.index.batches.get(batch.idempotencyKey);
        if(previous)return assertStateRetry(previous,batch);
        await validateSessionStateCommit(batch,itemId=>Promise.resolve(state.index.heads.get(itemId)),state.retainedBytes);
        for(const revision of batch.revisions)if(revision.previousRevisionId!==null&&state.revoked.has(revocationKey({itemId:revision.itemId,revisionId:revision.previousRevisionId})))throw new MaterialAccessError();
        const result=await this.events.appendConditional(materialOwnerKey(batch.owner),{type:'material.batch',format:'agent-core.material/1',batch},
          {idempotencyKey:`batch:${batch.idempotencyKey}`,expectedTail:state.tail,driverGeneration:state.tail.driverGeneration});
        if(result.kind==='rejected'&&result.reason==='stale_tail')continue;
        if(result.kind==='committed'||result.kind==='already_committed'||result.kind==='committed_index_unknown') {
          return Object.freeze({idempotencyKey:batch.idempotencyKey,entryId:result.receipt.eventId,fingerprint:batch.fingerprint,
            revisions:Object.freeze(batch.revisions.map(({itemId,revisionId})=>Object.freeze({itemId,revisionId})))});
        }
        throw new PersistenceConflictError(`Material publication ${result.kind}; reconcile the exact idempotency key before retrying.`);
      }
    });
  }
  async current(owner:MaterialOwner,itemId:string) {const state=await this.projection(owner),item=state.index.heads.get(itemId);return item&&!state.revoked.has(revocationKey(item))?item:undefined;}
  async read(ref:QualifiedMaterialRef) {
    const state=await this.projection(ref.owner);this.assertAt(state,ref);
    const revision=state.index.revisions.get(ref.revisionId);
    if(revision?.itemId!==ref.itemId)throw new MaterialAccessError();
    if(ref.range&&ref.range.offset+ref.range.bytes>revision.contentBytes)throw new RangeError('Material range exceeds its exact revision.');
    return revision;
  }
  async retainedBytes(owner:MaterialOwner):Promise<number> {return(await this.projection(owner)).retainedBytes;}
  async revocationRevision(owner:MaterialOwner):Promise<number> {return(await this.projection(owner)).revision;}
  private assertAt(state:Projection,ref:QualifiedMaterialRef):void {if(state.revoked.has(revocationKey(ref)))throw new MaterialAccessError();}
  async assertUsable(ref:QualifiedMaterialRef):Promise<void> {this.assertAt(await this.projection(ref.owner),ref);}
  async isRevoked(ref:QualifiedMaterialRef):Promise<boolean> {return (await this.projection(ref.owner)).revoked.has(revocationKey(ref));}
  async list(owner:MaterialOwner,request:SessionStatePageRequest={}):Promise<MaterialPage> {
    owner=materialOwnerSchema.parse(owner);
    const {limit,maxBytes}=statePageLimits(request),state=await this.projection(owner);
    const cursor=request.cursor?cursorSchema.parse(JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'))):undefined;
    if(cursor&&(hashJson(cursor.owner)!==hashJson(owner)||cursor.revision!==state.revision||cursor.sequence!==state.tail.sequence||cursor.hash!==state.tail.hash))
      throw new PersistenceConflictError('Material cursor snapshot or revocation boundary changed.');
    const values=state.index.orderedItems;
    let start=0;
    if(cursor) {const hash=hashJson(cursor.after);let high=values.length;while(start<high){const middle=Math.floor((start+high)/2),item=values[middle];if(item&&(hashJson(item.itemId)<hash||(hashJson(item.itemId)===hash&&item.itemId<=cursor.after)))start=middle+1;else high=middle;}if(values[start-1]?.itemId!==cursor.after)throw new Error('Invalid material inventory cursor.');}
    const selected=[];let at=start;
    while(at<values.length&&selected.length<limit&&at-start<256){const item=values[at++];if(item&&!state.revoked.has(revocationKey(item)))selected.push({...stateItemMetadata(item),owner});}
    return fitStatePage(selected,items=>{
      const partial=items.length<selected.length||at<values.length;
      const after=items.length<selected.length?items.at(-1)?.itemId:values[at-1]?.itemId;
      return {items:Object.freeze([...items]),revocationRevision:state.revision,coverage:partial?'partial' as const:'complete' as const,
        ...(partial&&after?{cursor:Buffer.from(JSON.stringify({owner,sequence:state.tail.sequence,hash:state.tail.hash,revision:state.revision,after})).toString('base64url')}:{})};
    },maxBytes);
  }
  async revoke(input:MaterialRevocation):Promise<MaterialRevocationReceipt> {
    const value=materialRevocationSchema.parse(input);
    if(new Set(value.refs.map(revocationKey)).size!==value.refs.length)throw new Error('Duplicate material revocation target.');
    return this.withOwners([value.owner],async()=>{
      const key=materialOwnerKey(value.owner),retry=await this.events.referenceByKey(key,`revoke:${value.operationId}`);
      if(retry){const event=(await this.events.readReference(retry)).event;if(event.type!=='material.revoked'||hashJson({...value,revision:event.revision,type:event.type,format:event.format})!==hashJson(event))throw new PersistenceConflictError('Material revocation operation changed.');return {owner:value.owner,operationId:value.operationId,revision:event.revision,refs:value.refs};}
      for(;;){const state=await this.projection(value.owner);
        if(state.revision!==value.expectedRevision)throw new PersistenceConflictError('Material revocation revision changed.');
        if(value.owner.kind==='scope')for(const ref of value.refs)if(state.index.revisions.get(ref.revisionId)?.itemId!==ref.itemId)throw new MaterialAccessError();
        const event:MaterialEvent={...value,type:'material.revoked',format:'agent-core.material/1',revision:state.revision+1};
        const result=await this.events.appendConditional(key,event,{idempotencyKey:`revoke:${value.operationId}`,expectedTail:state.tail,driverGeneration:state.tail.driverGeneration});
        if(result.kind==='rejected'&&result.reason==='stale_tail')continue;
        if(result.kind==='committed'||result.kind==='already_committed'||result.kind==='committed_index_unknown')return {owner:value.owner,operationId:value.operationId,revision:event.revision,refs:value.refs};
        throw new PersistenceConflictError(`Material revocation ${result.kind}; reconcile the operation identity.`);
      }
    });
  }
}
function revocationKey(ref:{readonly itemId:string;readonly revisionId:string}):string {return hashJson({itemId:ref.itemId,revisionId:ref.revisionId});}
export class InMemoryMaterialRepository extends EventMaterialRepository {
  constructor(){super(new InMemoryEventRepository(materialEventCodec));}
}
