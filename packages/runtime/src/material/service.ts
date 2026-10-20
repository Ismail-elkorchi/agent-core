import * as z from 'zod';
import { parseJsonObject } from '@agent-core/json';
import { decodeOwnedArtifactRef, decodeUtf8, hashJson, PersistenceConflictError, type ArtifactRepository, type ArtifactRef } from '@agent-core/persistence';
import type { SessionDescriptor, SessionRepository } from '../session/contracts.js';
import type { HistoryReader } from '../history/reader.js';
import type { HistorySourceCut } from '../history/contracts.js';
import { stageSessionStateBatch } from '../context/session-state.js';
import { sessionStateBatchSchema, sessionStateTextRange, sessionStateLimitError, SESSION_STATE_RETRIEVAL_LIMITS,
  type SessionStateBatch, type SessionStateBatchCommit, type SessionStateItemRevision, type SessionStatePageRequest } from '../session/session-state.js';
import { boundedStateResult, statePageLimits, decodeStatePageCursor } from '../session/state-records.js';
import { MaterialAccessError, materialOwnerSchema, qualifiedMaterialRefSchema, materialUseDependencySchema,
  type MaterialRepository, type MaterialOwner, type QualifiedMaterialRef, type MaterialGrantProvider, type MaterialUseDependency,
  type MaterialArtifactAuthority, type MaterialArtifactUseDependency, type MaterialPublicationGuard, type MaterialProvenance, type MaterialRevocation, type MaterialErasureCapability, type MaterialErasureReceipt, type MaterialPage, type MaterialGrant } from './contracts.js';
import { materialOwnerKey } from './locks.js';
import { materialRevocationSchema } from './repository.js';

export interface ScopedMaterialServiceOptions {
  readonly repository?:MaterialRepository|undefined;
  readonly artifacts:ArtifactRepository;
  readonly history:HistoryReader;
  readonly sessionArtifacts?:ArtifactRepository|undefined;
  readonly sessionRepository:SessionRepository;
  readonly session:SessionDescriptor;
  readonly grants?:MaterialGrantProvider|undefined;
  /** Bind model-authored batches to a real producing inference. */
  readonly assertWrite:(batch:SessionStateBatch|SessionStateBatchCommit)=>Promise<void>;
  readonly withOwnership?:(<T>(operation:()=>Promise<T>)=>Promise<T>)|undefined;
  readonly authorizeTransfer?:((batch:SessionStateBatch,provenance:readonly MaterialProvenance[])=>Promise<void>)|undefined;
  readonly artifactAuthority?:MaterialArtifactAuthority|undefined;
  readonly erasure?:MaterialErasureCapability|undefined;
  readonly maxMutationBytes?:number|undefined;
  readonly maxStorageBytes?:number|undefined;
  readonly maxReadBytes?:number|undefined;
}
const pageCursor=z.strictObject({owner:materialOwnerSchema,grantRevision:z.string().min(1),revocationRevision:z.int().nonnegative(),cursor:z.string()});
/** The host supplies scope grants; persisted narrative never supplies execution authority. */
export class ScopedMaterialService {
  constructor(private readonly options:ScopedMaterialServiceOptions) {}
  private get sharedRepository():MaterialRepository {if(!this.options.repository)throw new MaterialAccessError('Shared material storage is not configured.');return this.options.repository;}
  private get grantProvider():MaterialGrantProvider {if(!this.options.grants)throw new MaterialAccessError('Shared material grants are not configured.');return this.options.grants;}
  private revocationRevision(owner:MaterialOwner):Promise<number> {return owner.kind==='session'?this.options.sessionRepository.materialRevocationRevision(this.options.session,owner):this.sharedRepository.revocationRevision(owner);}
  private async assertUsable(ref:QualifiedMaterialRef):Promise<void> {
    if(ref.owner.kind==='session'){if(await this.options.sessionRepository.isMaterialRevoked(this.options.session,ref))throw new MaterialAccessError();}
    else await this.sharedRepository.assertUsable(ref);
  }
  private withOwners<T>(owners:readonly MaterialOwner[],operation:()=>Promise<T>):Promise<T> {const shared=owners.filter(owner=>owner.kind==='scope');return shared.length?this.sharedRepository.withOwners(shared,operation):operation();}
  private async grant(owner:MaterialOwner,access:'read'|'write'='read'):Promise<MaterialGrant> {
    owner=materialOwnerSchema.parse(owner);
    if(owner.kind==='session') {
      const cut=await this.options.history.capture();
      if(owner.sessionId!==this.options.session.id||owner.branchId!==cut.branchId)throw new MaterialAccessError();
      return {owner,revision:`session:${owner.sessionId}:${owner.branchId}`,read:true,write:true};
    }
    const grant=await this.grantProvider.get(owner);
    if(!grant?.[access]||hashJson(grant.owner)!==hashJson(owner))throw new MaterialAccessError();
    return grant;
  }
  async currentSessionOwner():Promise<Extract<MaterialOwner,{kind:'session'}>> {const cut=await this.options.history.capture();return Object.freeze({kind:'session' as const,sessionId:cut.sessionId,branchId:cut.branchId});}
  async authorizeOwner(owner:MaterialOwner,access:'read'|'write'='read'):Promise<void> {await this.grant(owner,access);}
  async captureBoundary(owner:MaterialOwner):Promise<{readonly grantRevision:string;readonly revocationRevision:number}> {
    const grant=await this.grant(owner);
    return {grantRevision:grant.revision,revocationRevision:await this.revocationRevision(owner)};
  }
  async listScopes(request:SessionStatePageRequest={}) {const maxBytes=statePageLimits(request).maxBytes;return boundedStateResult(this.options.grants?await this.options.grants.list(request):{items:[],coverage:'complete' as const},maxBytes);}
  private async metadata(ref:QualifiedMaterialRef):Promise<SessionStateItemRevision> {
    await this.grant(ref.owner);
    await this.assertUsable(ref);
    if(ref.owner.kind==='scope')return this.sharedRepository.read(ref);
    return this.options.sessionRepository.readSessionStateItem(this.options.session,{itemId:ref.itemId,revisionId:ref.revisionId,...(ref.range?{range:ref.range}:{})});
  }
  async authorize(ref:QualifiedMaterialRef):Promise<void> { await this.captureDependencies([ref]); }
  async assertCurrent(ref:QualifiedMaterialRef):Promise<void> {
    ref=qualifiedMaterialRefSchema.parse(ref);await this.authorize(ref);
    const current=ref.owner.kind==='scope'?await this.sharedRepository.current(ref.owner,ref.itemId):await this.options.sessionRepository.currentSessionStateItem(this.options.session,ref.itemId);
    if(current?.deleted||current?.revisionId!==ref.revisionId)throw new PersistenceConflictError('Material head changed after inspection.');
  }
  private async captureArtifacts(refs:readonly ArtifactRef[],access:'read'|'transfer'):Promise<readonly MaterialArtifactUseDependency[]> {
    if(refs.length>256)throw new RangeError('Artifact provenance exceeds 256 references.');
    if(!refs.length)return Object.freeze([]);
    const authority=this.options.artifactAuthority;
    if(!authority||typeof authority.withAuthority!=='function')throw new MaterialAccessError('Artifact provenance requires an explicit host authority fence.');
    const unique=new Map<string,ArtifactRef>();
    for(const input of refs){const ref=decodeOwnedArtifactRef(parseJsonObject(input));unique.set(hashJson(ref),ref);}
    return Object.freeze(await Promise.all([...unique.values()].map(async ref=>Object.freeze({ref,access,revision:z.string().min(1).max(512).parse(await authority.capture(ref,access))}))));
  }
  private withArtifacts<T>(input:readonly MaterialArtifactUseDependency[],operation:()=>Promise<T>):Promise<T> {
    if(input.length>256)throw new RangeError('Artifact provenance closure exceeds 256 references.');
    if(!input.length)return operation();
    const authority=this.options.artifactAuthority;
    if(!authority)throw new MaterialAccessError('Artifact provenance requires an explicit host authority fence.');
    const unique=new Map<string,MaterialArtifactUseDependency>();
    for(const value of input){const key=hashJson({ref:value.ref,access:value.access}),prior=unique.get(key);if(prior&&prior.revision!==value.revision)throw new MaterialAccessError('Artifact source authority changed.');unique.set(key,value);}
    return authority.withAuthority(Object.freeze([...unique.values()]),operation);
  }
  private async inheritedLocalRef(ref:QualifiedMaterialRef,currentOwner:MaterialOwner):Promise<QualifiedMaterialRef> {
    if(ref.owner.kind!=='session'||currentOwner.kind!=='session'||ref.owner.sessionId!==currentOwner.sessionId||ref.owner.branchId===currentOwner.branchId)return ref;
    // The active branch revision index, rather than the session-global journal, proves inheritance.
    await this.options.sessionRepository.readSessionStateItem(this.options.session,{itemId:ref.itemId,revisionId:ref.revisionId,...(ref.range?{range:ref.range}:{})});
    return Object.freeze({...ref,owner:currentOwner});
  }
  /** Only for exact dependencies read from an already admitted persisted provider prefix. */
  async captureInheritedPrefixDependencies(input:readonly MaterialUseDependency[]):Promise<readonly MaterialUseDependency[]> {
    if(input.length>256)throw new RangeError('Material dependency closure exceeds 256 revisions.');
    const owner=await this.currentSessionOwner(),revision=await this.revocationRevision(owner),dependencies=new Map<string,MaterialUseDependency>();
    for(const value of input){
      const prior=materialUseDependencySchema.parse(value);let dependency=prior;
      if(prior.ref.owner.kind==='session'){
        const old=prior.ref.owner;
        if(old.sessionId!==this.options.session.id||prior.grantRevision!==`session:${old.sessionId}:${old.branchId}`||prior.revocationRevision!==revision)throw new MaterialAccessError('Inherited material prefix authority changed.');
        const ref=await this.inheritedLocalRef(prior.ref,owner);
        dependency=Object.freeze({...prior,ref,grantRevision:`session:${this.options.session.id}:${owner.branchId}`});
      }
      const key=dependencyKey(dependency.ref),existing=dependencies.get(key);
      if(existing&&(existing.grantRevision!==dependency.grantRevision||existing.revocationRevision!==dependency.revocationRevision||hashJson(existing.artifacts??[])!==hashJson(dependency.artifacts??[])))throw new MaterialAccessError('Inherited material dependency stamps disagree.');
      dependencies.set(key,dependency);
    }
    const result=Object.freeze([...dependencies.values()]);await this.assertDependencies(result);return result;
  }
  async captureDependencies(refs:readonly QualifiedMaterialRef[]):Promise<readonly MaterialUseDependency[]> {
    if(refs.length>256)throw new RangeError('Material dependency roots exceed the 256-reference bound.');
    if(!refs.length)return Object.freeze([]);
    const currentOwner=await this.currentSessionOwner();
    const found=new Map<string,MaterialUseDependency>(),artifactSources=new Set<string>();let metadataBytes=0;
    const visit=async(input:QualifiedMaterialRef,depth:number):Promise<void>=>{
      if(depth>32)throw new RangeError('Material dependency depth exceeds 32.');
      const declared=qualifiedMaterialRefSchema.parse(input),ref=depth>0?await this.inheritedLocalRef(declared,currentOwner):declared,key=dependencyKey(ref);
      if(found.has(key))return;
      if(found.size>=256)throw new RangeError('Material dependency closure exceeds 256 revisions.');
      const grant=await this.grant(ref.owner),revision=await this.revocationRevision(ref.owner);
      await this.assertUsable(ref);
      const item=await this.metadata(ref);
      if(item.deleted)throw new MaterialAccessError('An inventory tombstone has no selectable material body.');
      metadataBytes+=Buffer.byteLength(JSON.stringify(item));
      if(metadataBytes>4*1024*1024)throw new RangeError('Material dependency metadata exceeds 4 MiB.');
      for(const artifact of item.artifactSources??[]){artifactSources.add(hashJson(artifact));if(artifactSources.size>256)throw new RangeError('Artifact provenance closure exceeds 256 references.');}
      const artifacts=await this.captureArtifacts(item.artifactSources??[],'read');
      found.set(key,{ref,grantRevision:grant.revision,revocationRevision:revision,...(artifacts.length?{artifacts}:{})});
      for(const dependency of item.dependencies??[])await visit(dependency,depth+1);
      const latest=await this.grant(ref.owner);
      if(latest.revision!==grant.revision||await this.revocationRevision(ref.owner)!==revision)throw new MaterialAccessError();
    };
    for(const ref of refs)await visit(ref,0);
    return Object.freeze([...found.values()].map(value=>Object.freeze(value)));
  }
  async assertDependencies(dependencies:readonly MaterialUseDependency[]):Promise<void> {
    const captured=dependencies.map(value=>materialUseDependencySchema.parse(value));
    if(captured.length>256||new Set(captured.map(value=>dependencyKey(value.ref))).size!==captured.length)throw new Error('Invalid material dependency set.');
    const expected=new Map(captured.map(value=>[dependencyKey(value.ref),value]));
    const current=await this.captureDependencies(captured.map(value=>value.ref));
    if(current.length!==captured.length)throw new MaterialAccessError('The material dependency closure is incomplete.');
    for(const value of current){const prior=expected.get(dependencyKey(value.ref));if(prior?.grantRevision !== value.grantRevision||prior.revocationRevision!==value.revocationRevision||hashJson(prior.artifacts??[])!==hashJson(value.artifacts??[]))throw new MaterialAccessError();}
  }
  /** Resolve immutable provenance before taking a producing-session publication lock. */
  async capturePublicationAuthority(dependencies:readonly MaterialUseDependency[],transferredArtifacts:readonly ArtifactRef[]=[]):Promise<MaterialPublicationGuard> {
    if(dependencies.length>256)throw new RangeError('Material dependency closure exceeds 256 revisions.');
    const captured=dependencies.map(value=>materialUseDependencySchema.parse(value));
    if(new Set(captured.map(value=>dependencyKey(value.ref))).size!==captured.length)throw new Error('Duplicate material dependency.');
    await this.assertDependencies(captured);
    const artifacts=[...captured.flatMap(value=>value.artifacts??[]),...await this.captureArtifacts(transferredArtifacts,'transfer')];
    if(artifacts.length>256)throw new RangeError('Artifact provenance closure exceeds 256 references.');
    const boundaries=Object.freeze(captured.filter(value=>value.ref.owner.kind==='session').map(value=>Object.freeze({owner:value.ref.owner,revocationRevision:value.revocationRevision})));
    return Object.freeze({boundaries,withAuthority:<T>(operation:()=>Promise<T>)=>this.withGrants(captured.map(value=>({owner:value.ref.owner,revision:value.grantRevision,access:'read' as const})),
      ()=>this.withOwners(captured.map(value=>value.ref.owner),async()=>{
        for(const value of captured){
          if(value.ref.owner.kind==='scope'){const grant=await this.grantProvider.get(value.ref.owner);if(!grant?.read||grant.revision!==value.grantRevision)throw new MaterialAccessError();}
          if(value.ref.owner.kind==='scope'){if(await this.sharedRepository.revocationRevision(value.ref.owner)!==value.revocationRevision)throw new MaterialAccessError();await this.sharedRepository.assertUsable(value.ref);}
        }
        return this.withArtifacts(artifacts,operation);
      }))});
  }
  /** Guards cover the start of dispatch, never an entire provider generation. */
  async withDependencies<T>(dependencies:readonly MaterialUseDependency[],operation:()=>Promise<T>):Promise<T> {
    const publication=await this.capturePublicationAuthority(dependencies);
    return publication.boundaries.length
      ?this.options.sessionRepository.withMaterialRevocations(this.options.session,publication.boundaries,()=>publication.withAuthority(operation))
      :publication.withAuthority(operation);
  }
  private withGrants<T>(input:readonly {readonly owner:MaterialOwner;readonly revision:string;readonly access:'read'|'write'}[],operation:()=>Promise<T>):Promise<T> {
    const values=new Map<string,{owner:MaterialOwner;revision:string;access:'read'|'write'}>();
    for(const value of input){if(value.owner.kind==='session')continue;const key=materialOwnerKey(value.owner),prior=values.get(key);if(prior?.revision!==undefined&&prior.revision!==value.revision)throw new MaterialAccessError();values.set(key,prior?.access==='write'?prior:value);}
    const ordered=[...values.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value);
    const next=(index:number):Promise<T>=>{const value=ordered[index];return value?this.grantProvider.withGrant(value.owner,value.revision,value.access,()=>next(index+1)):operation();};
    return next(0);
  }
  async read(input:QualifiedMaterialRef,options:{readonly maxBytes?:number}={}) {
    const ref=qualifiedMaterialRefSchema.parse(input),dependencies=await this.captureDependencies([ref]);
    const maxBytes=options.maxBytes??this.options.maxReadBytes??SESSION_STATE_RETRIEVAL_LIMITS.defaultBytes;
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>SESSION_STATE_RETRIEVAL_LIMITS.maxBytes)throw new RangeError('Material read limit exceeds supported bounds.');
    const item=await this.metadata(ref);
    return this.withDependencies(dependencies,async()=>{
      const offset=ref.range?.offset??0,size=ref.range?.bytes??item.contentBytes;
      if(size>maxBytes)throw sessionStateLimitError('material_read',maxBytes,size,'Selected material exceeds the bounded read limit.');
      const artifacts=ref.owner.kind==='session'?(this.options.sessionArtifacts??this.options.artifacts):this.options.artifacts;
      const range=await artifacts.readVerifiedRange(item.contentRef,{offset,length:size});
      if(range.offset!==offset||range.end!==offset+size)throw new RangeError('Material range must preserve exact UTF-8 boundaries.');
      const text=decodeUtf8(range.bytes);sessionStateTextRange(text,0,size);
      return boundedStateResult({...ref,text,provenance:{authorship:'model' as const,inference:{ownerId:item.inference.ownerId,invocationId:item.inference.invocationId},capturedHistoryCut:item.capturedHistoryCut},...(item.sources?{sources:item.sources}:{}),...(item.subject===undefined?{}:{subject:item.subject}),
        ...(item.dependencies?{dependencies:item.dependencies}:{}),...(item.artifactSources?{artifactSources:item.artifactSources}:{})},maxBytes);
    });
  }
  /** Internal literal-search body allowance; never a model-facing unbounded read response. */
  async readForSearch(input:QualifiedMaterialRef,maxScannedBytes:number):Promise<string> {
    const ref=qualifiedMaterialRefSchema.parse(input);
    if(!Number.isSafeInteger(maxScannedBytes)||maxScannedBytes<1||maxScannedBytes>SESSION_STATE_RETRIEVAL_LIMITS.maxScannedBytes)throw new RangeError('Material search scan allowance exceeds supported bounds.');
    const dependencies=await this.captureDependencies([ref]),item=await this.metadata(ref);
    if(item.contentBytes>maxScannedBytes)throw sessionStateLimitError('material_search_scan',maxScannedBytes,item.contentBytes,'Material revision exceeds remaining search scan allowance.');
    return this.withDependencies(dependencies,async()=>{
      const artifacts=ref.owner.kind==='session'?(this.options.sessionArtifacts??this.options.artifacts):this.options.artifacts;
      return decodeUtf8(await artifacts.readVerified(item.contentRef));
    });
  }
  async list(owner:MaterialOwner,request:SessionStatePageRequest={},authorizedCut?:HistorySourceCut):Promise<MaterialPage> {
    const boundary=await this.captureBoundary(owner),{maxBytes}=statePageLimits(request);
    const cursor=request.cursor?pageCursor.parse(JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'))):undefined;
    if(cursor&&(hashJson(cursor.owner)!==hashJson(owner)||cursor.grantRevision!==boundary.grantRevision||cursor.revocationRevision!==boundary.revocationRevision))throw new MaterialAccessError('Material cursor authority or revocation boundary changed.');
    let localLeaf:string|null|undefined;
    if(owner.kind==='session'){
      const cut=authorizedCut??await this.options.history.capture();
      if(cut.sessionId!==owner.sessionId||cut.branchId!==owner.branchId)throw new MaterialAccessError('Material inventory cut belongs to another owner.');
      await this.options.history.validateCut(cut);
      const through=request.leafId===undefined?cut.throughEntryId:request.leafId;
      const authorized=await this.options.sessionRepository.sourceSnapshot(this.options.session,cut.throughEntryId);
      if(through!==null&&through!==cut.throughEntryId&&!await authorized.index.byId.has(through))throw new MaterialAccessError('Material inventory boundary is outside the authorized cut.');
      const decoded=cursor?decodeStatePageCursor(owner.sessionId,{cursor:cursor.cursor}):undefined;
      localLeaf=decoded?decoded.leafId:through;
      if(localLeaf!==null&&localLeaf!==through){const bounded=through===cut.throughEntryId?authorized:await this.options.sessionRepository.sourceSnapshot(this.options.session,through);if(!await bounded.index.byId.has(localLeaf))throw new MaterialAccessError('Material inventory cursor is outside the authorized branch or cut.');}
    }
    let limit=statePageLimits(request).limit;
    for(;;){
      const inner={...request,limit,...(localLeaf===undefined?{}:{leafId:localLeaf}),...(cursor?{cursor:cursor.cursor}:{cursor:undefined})};
      const page:MaterialPage=owner.kind==='scope'?await this.sharedRepository.list(owner,inner):await (async()=>{const local=await this.options.sessionRepository.listSessionState(this.options.session,inner);return {...local,revocationRevision:boundary.revocationRevision,items:local.items.map(item=>({...item,owner}))};})();
      const delivered={...page,...(page.cursor?{cursor:Buffer.from(JSON.stringify({owner,...boundary,cursor:page.cursor})).toString('base64url')}:{})};
      if(Buffer.byteLength(JSON.stringify(delivered))>maxBytes&&page.items.length>1){limit=Math.max(1,Math.floor(page.items.length/2));continue;}
      boundedStateResult(delivered,maxBytes);
      const dependencies=await this.captureDependencies(page.items.map(({owner,itemId,revisionId,range})=>({owner,itemId,revisionId,...(range?{range}:{})})));
      const publication=await this.capturePublicationAuthority(dependencies);
      const localBoundaries=owner.kind==='session'?[{owner,revocationRevision:boundary.revocationRevision}]:publication.boundaries;
      const deliver=()=>publication.withAuthority(async()=>{
        if(owner.kind==='scope'&&await this.sharedRepository.revocationRevision(owner)!==boundary.revocationRevision)throw new MaterialAccessError();
        if(owner.kind==='scope'){const grant=await this.grantProvider.get(owner);if(!grant?.read||grant.revision!==boundary.grantRevision)throw new MaterialAccessError();}
        return delivered;
      });
      const shared=()=>owner.kind==='scope'&&!dependencies.length?this.withGrants([{owner,revision:boundary.grantRevision,access:'read'}],()=>this.withOwners([owner],deliver)):deliver();
      return localBoundaries.length?this.options.sessionRepository.withMaterialRevocations(this.options.session,localBoundaries,shared):shared();
    }
  }

  /** Validate exact declared sources before any artifact preparation, including edit inheritance. */
  async authorizeProvenance(input:SessionStateBatch):Promise<{readonly dependencies:readonly MaterialUseDependency[];readonly artifacts:readonly MaterialArtifactUseDependency[]}> {
    const batch=sessionStateBatchSchema.parse(input),sourceRefs:QualifiedMaterialRef[]=[],provenance:MaterialProvenance[]=[],artifactRefs:ArtifactRef[]=[];
    await this.grant(batch.owner,'write');
    let transfers=false;
    for(const operation of batch.operations){
      const value=operation.kind==='edit'
        ?batch.owner.kind==='scope'?await this.sharedRepository.current(batch.owner,operation.itemId):await this.options.sessionRepository.currentSessionStateItem(this.options.session,operation.itemId)
        :operation.kind==='create'||operation.kind==='replace'?operation:undefined;
      if(!value)continue;
      provenance.push(value);sourceRefs.push(...value.dependencies??[]);
      const declared=(value.dependencies?.length??0)+(value.sources?.length??0)+(value.artifactSources?.length??0)>0;
      if((batch.owner.kind==='scope'&&declared)||(value.artifactSources?.length??0)>0||(value.dependencies??[]).some(ref=>hashJson(ref.owner)!==hashJson(batch.owner)))transfers=true;
      artifactRefs.push(...value.artifactSources??[]);
    }
    if(transfers){if(!this.options.authorizeTransfer)throw new MaterialAccessError('Cross-owner provenance requires explicit host transfer authorization.');await this.options.authorizeTransfer(batch,provenance);}
    return {dependencies:await this.captureDependencies(sourceRefs),artifacts:await this.captureArtifacts(artifactRefs,'transfer')};
  }
  async findSavedBatch(input:SessionStateBatch) {
    const batch=sessionStateBatchSchema.parse(input),grant=await this.grant(batch.owner,'write');
    const lookup=async()=>{
      const receipt=batch.owner.kind==='scope'?await this.sharedRepository.findBatch(batch.owner,batch.idempotencyKey):await this.options.sessionRepository.findSessionStateBatch(this.options.session,batch.idempotencyKey);
      if(!receipt)return undefined;
      if(receipt.fingerprint!==hashJson(batch))throw new PersistenceConflictError('Material idempotency key changed.');
      return batch.owner.kind==='scope'?{...receipt,revisions:receipt.revisions.map(ref=>({...ref,owner:batch.owner}))}:receipt;
    };
    return batch.owner.kind==='scope'?this.withGrants([{owner:batch.owner,revision:grant.revision,access:'write'}],lookup):lookup();
  }
  async save(input:SessionStateBatch) {
    const batch=sessionStateBatchSchema.parse(input);
    if(typeof this.options.sessionRepository.withMaterialPublication!=='function'||typeof this.grantProvider.withGrant!=='function')throw new Error('Cross-owner material writes require producing-session and grant publication fences.');
    const grant=await this.grant(batch.owner,'write');
    await this.options.assertWrite(batch);
    if(batch.owner.kind==='session')throw new Error('Session-local saves and atomic activation use ContextService.saveSessionState.');
    const existing=await this.sharedRepository.findBatch(batch.owner,batch.idempotencyKey);
    if(existing){if(existing.fingerprint!==hashJson(batch))throw new PersistenceConflictError('Material idempotency key changed.');return {...existing,revisions:existing.revisions.map(ref=>({...ref,owner:batch.owner}))};}
    const provenance=await this.authorizeProvenance(batch),dependencies=provenance.dependencies;
    const staged=await stageSessionStateBatch({batch,artifacts:this.options.artifacts,history:this.options.history,
      current:itemId=>this.sharedRepository.current(batch.owner,itemId),maxMutationBytes:this.options.maxMutationBytes??1024*1024,
      maxStorageBytes:this.options.maxStorageBytes??64*1024*1024,committedRetainedBytes:await this.sharedRepository.retainedBytes(batch.owner)});
    await this.options.assertWrite(staged);
    if(typeof this.options.sessionRepository.withMaterialPublication!=='function')throw new Error('Cross-owner material writes require a producing-session publication fence.');
    const publish=()=>this.options.sessionRepository.withMaterialPublication(this.options.session,batch.capturedHistoryCut,()=>
      this.withGrants([{owner:batch.owner,revision:grant.revision,access:'write'},...dependencies.map(value=>({owner:value.ref.owner,revision:value.grantRevision,access:'read' as const}))],()=>
        this.withOwners([batch.owner,...dependencies.map(value=>value.ref.owner)],async()=>{
          // No session/history access while the producing correction guard is held.
          for(const dependency of dependencies){
            if(dependency.ref.owner.kind==='session'&&(dependency.ref.owner.sessionId!==batch.capturedHistoryCut.sessionId||dependency.ref.owner.branchId!==batch.capturedHistoryCut.branchId))throw new MaterialAccessError('Another session dependency requires its own host source lifetime fence.');
            if(dependency.ref.owner.kind==='scope'){if(await this.sharedRepository.revocationRevision(dependency.ref.owner)!==dependency.revocationRevision)throw new MaterialAccessError();await this.sharedRepository.assertUsable(dependency.ref);}
          }
          return this.withArtifacts([...dependencies.flatMap(value=>value.artifacts??[]),...provenance.artifacts],async()=>{
            const receipt=await this.sharedRepository.save(staged);
            return {...receipt,revisions:receipt.revisions.map(ref=>({...ref,owner:batch.owner}))};
          });
        })),dependencies.filter(value=>value.ref.owner.kind==='session').map(value=>({owner:value.ref.owner,revocationRevision:value.revocationRevision})));
    try{return await (this.options.withOwnership?this.options.withOwnership(publish):publish());}
    catch(error){
      let committed;
      try{committed=await this.findSavedBatch(batch);}catch(reconcile){throw new Error('Material publication outcome requires reconciliation.',{cause:reconcile});}
      if(committed)return committed;
      throw error;
    }
  }
  async revoke(input:MaterialRevocation) {
    const value=materialRevocationSchema.parse(input),grant=await this.grant(value.owner,'write');
    if(value.owner.kind==='session')return this.options.sessionRepository.revokeMaterial(this.options.session,value);
    return this.withGrants([{owner:value.owner,revision:grant.revision,access:'write'}],()=>this.sharedRepository.revoke(value));
  }
  async erase(input:readonly QualifiedMaterialRef[]):Promise<MaterialErasureReceipt> {
    const targets=z.array(qualifiedMaterialRefSchema).min(1).max(256).parse(input);
    if(targets.some(ref=>ref.range!==undefined))throw new Error('Physical erasure targets complete revisions, not excerpt ranges.');
    if(new Set(targets.map(dependencyKey)).size!==targets.length)throw new Error('Duplicate physical erasure target.');
    const erasure=this.options.erasure;
    if(!erasure)throw new Error('Physical material erasure is unsupported by this host; inventory removal and revocation retain historical storage.');
    const grants=await Promise.all(targets.map(async ref=>({...await this.grant(ref.owner,'write'),access:'write' as const})));
    for(const ref of targets)if(ref.owner.kind==='session'&&!await this.options.sessionRepository.isMaterialRevoked(this.options.session,ref))throw new Error('Revoke exact material revisions before requesting physical erasure.');
    const boundaries=await Promise.all(grants.filter(grant=>grant.owner.kind==='session').map(async grant=>({owner:grant.owner,revocationRevision:await this.revocationRevision(grant.owner)})));
    const erase=()=>this.withGrants(grants,()=>this.withOwners(targets.map(ref=>ref.owner),async()=>{
      for(const ref of targets)if(ref.owner.kind==='scope'&&!await this.sharedRepository.isRevoked(ref))throw new Error('Revoke exact material revisions before requesting physical erasure; cached and previously compiled requests must lose future-use authority first.');
      return validateErasureReceipt(await erasure.erase(targets),targets);
    }));
    return boundaries.length?this.options.sessionRepository.withMaterialRevocations(this.options.session,boundaries,erase):erase();
  }
}
function dependencyKey(ref:QualifiedMaterialRef):string {return hashJson({owner:ref.owner,itemId:ref.itemId,revisionId:ref.revisionId});}
const coverage=z.enum(['removed','retained','unsupported']);
const erasureReceiptSchema=z.strictObject({targets:z.array(qualifiedMaterialRefSchema).min(1).max(256),coverage:z.array(z.strictObject({target:qualifiedMaterialRefSchema,bodies:coverage,previews:coverage,indexes:coverage,caches:coverage,retainedSharedBytes:z.int().nonnegative(),detail:z.string().max(4096).optional()})).min(1).max(256),originalHistory:z.literal('separately_governed'),requestSnapshots:z.literal('separately_governed'),priorRemoteDelivery:z.literal('not_erased'),semanticDerivation:z.literal('unknown')});
export function validateErasureReceipt(input:unknown,targets:readonly QualifiedMaterialRef[]):MaterialErasureReceipt {
  const receipt=erasureReceiptSchema.parse(input),keys=targets.map(hashJson).sort();
  if(hashJson(receipt.targets.map(hashJson).sort())!==hashJson(keys)||hashJson(receipt.coverage.map(value=>hashJson(value.target)).sort())!==hashJson(keys))throw new Error('Erasure receipt does not cover the exact authorized targets.');
  return Object.freeze(receipt);
}
