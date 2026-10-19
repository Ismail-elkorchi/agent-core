import { scopedShareSourceSchema, publicShareArtifactInputSchema } from './share-contracts.js';
import { z } from 'zod';
import { InMemoryEventRepository, hashJson, decodeOwnedArtifactRef, type PublicArtifactRef, type EventRepository, type EventLedgerTail, type EventCodec } from '@agent-core/persistence';
import { parseJsonObject } from '@agent-core/json';
import type { CollaborationGroupState, CollaborationParticipant, ParticipantAssignment, ParticipantControlTarget, ParticipantResultRecord, ParticipantView } from './contracts.js';
import type { AgentSessionConfiguration } from '../session/agent-session.js';
import { ownSessionSubmissionConfiguration } from '../session/submission-lifecycle.js';

export type CollaborationEvent =
  | { readonly type: 'collaboration.created'; readonly format: 'agent-core.collaboration/1'; readonly groupId: string; readonly supervisorSessionId: string; readonly budgetOwnerId: string; readonly maxParticipants: number; readonly maxConcurrentRuns: number; readonly correctionRevision: number }
  | { readonly type: 'collaboration.host_acquired'; readonly hostId: string; readonly generation: number }
  | { readonly type: 'collaboration.assigned'; readonly operationId: string; readonly requestFingerprint: string; readonly participant: CollaborationParticipant; readonly assignment: ParticipantAssignment }
  | { readonly type: 'collaboration.corrected'; readonly operationId: string; readonly requestFingerprint: string; readonly epoch: number; readonly correctionRevision: number; readonly reason: string }
  | { readonly type: 'collaboration.control_requested'; readonly operationId: string; readonly requestFingerprint: string; readonly mode: 'interrupt' | 'cancel'; readonly targets: readonly ParticipantControlTarget[]; readonly reason: string; readonly epoch: number }
  | { readonly type: 'collaboration.assignment_withdrawn'; readonly operationId:string; readonly participantId:string; readonly assignmentId:string; readonly assignmentRevision:number; readonly runId:string }
  | { readonly type: 'collaboration.control_applied'; readonly operationId: string }
  | { readonly type: 'collaboration.public_artifact_owned'; readonly participantId:string; readonly artifact:PublicArtifactRef }
  | { readonly type: 'collaboration.result_recorded'; readonly result: ParticipantResultRecord }
  | { readonly type: 'collaboration.result_accepted'; readonly operationId: string; readonly requestFingerprint: string; readonly resultId: string; readonly epoch: number };

const id = z.string().min(1).max(1024);
const count = z.number().int().nonnegative();
const reference = z.object({runId:id,eventId:id,sequence:count,hash:id}).strict();
const capabilities = z.object({
  toolNames:z.array(id).max(256),
  collaboration:z.object({actions:z.array(z.enum(['start','inspect','continue','message','interrupt','cancel','accept'])).max(7),participantIds:z.array(id).max(256)}).strict().optional()
}).strict();
const participant = z.object({groupId:id,participantId:id,sessionId:id,createdBySessionId:id,parentParticipantId:id.optional()}).strict();
const configuration=z.custom<AgentSessionConfiguration>(value=>typeof value==='object' && value!==null && !Array.isArray(value)).transform(ownSessionSubmissionConfiguration);
const assignment = z.object({origin:z.enum(['delegated','user']),delegatedBy:z.object({sessionId:id,participantId:id.optional(),runId:id.optional()}).strict().optional(),assignmentId:id,participantId:id,revision:count,runId:id,task:z.string().min(1).max(1024*1024),epoch:count,capabilityRevision:id,capabilities,configuration:configuration.optional(),budgetOwnerId:id,budgetScopeId:id,sourceRefs:z.array(z.object({deliveryId:id,fingerprint:id}).strict()).max(256),initialSources:z.array(scopedShareSourceSchema).max(32),sourceSender:z.object({participantId:id,sessionId:id,runId:id}).strict().optional()}).strict();
const resultIdentity = {resultId:id,participantId:id,assignmentId:id,assignmentRevision:count,runId:id,epoch:count};
const controlTarget = z.object({participantId:id,assignmentId:id,assignmentRevision:count,runId:id}).strict();
const result = z.discriminatedUnion('kind',[
  z.object({...resultIdentity,kind:z.literal('partial'),source:reference}).strict(),
  z.object({...resultIdentity,kind:z.literal('final'),finalizationId:id,runEnded:reference}).strict()
]);
const eventSchema = z.discriminatedUnion('type',[
  z.object({type:z.literal('collaboration.created'),format:z.literal('agent-core.collaboration/1'),groupId:id,supervisorSessionId:id,budgetOwnerId:id,maxParticipants:z.number().int().min(1).max(256),maxConcurrentRuns:z.number().int().min(1).max(256),correctionRevision:count}).strict(),
  z.object({type:z.literal('collaboration.host_acquired'),hostId:id,generation:count}).strict(),
  z.object({type:z.literal('collaboration.assigned'),operationId:id,requestFingerprint:id,participant,assignment}).strict(),
  z.object({type:z.literal('collaboration.corrected'),operationId:id,requestFingerprint:id,epoch:count,correctionRevision:count,reason:id}).strict(),
  z.object({type:z.literal('collaboration.control_requested'),operationId:id,requestFingerprint:id,mode:z.enum(['interrupt','cancel']),targets:z.array(controlTarget).min(1).max(256),reason:id,epoch:count}).strict(),
  z.object({type:z.literal('collaboration.assignment_withdrawn'),operationId:id,participantId:id,assignmentId:id,assignmentRevision:count,runId:id}).strict(),
  z.object({type:z.literal('collaboration.control_applied'),operationId:id}).strict(),
  z.object({type:z.literal('collaboration.public_artifact_owned'),participantId:id,artifact:publicShareArtifactInputSchema.transform(value=>{const artifact=decodeOwnedArtifactRef(parseJsonObject(value));if(artifact.visibility!=='public')throw new Error('Public artifact ownership requires a public reference.');return artifact;})}).strict(),
  z.object({type:z.literal('collaboration.result_recorded'),result}).strict(),
  z.object({type:z.literal('collaboration.result_accepted'),operationId:id,requestFingerprint:id,resultId:id,epoch:count}).strict()
]);
export const collaborationEventCodec: EventCodec<CollaborationEvent> = {
  metadataIndexes:[{type:'collaboration.assigned',field:'assignmentIdentity'},{type:'collaboration.result_accepted',field:'acceptedResult'}],
  metadata:event=>event.type==='collaboration.assigned'?{assignmentIdentity:assignmentIdentity(event.assignment.participantId,event.assignment.assignmentId,event.assignment.revision)}:event.type==='collaboration.result_accepted'?{acceptedResult:hashJson(event.resultId)}:{},
  encode:value => parseJsonObject(captureEvent(value)),
  decode:value => freeze(captureEvent(value)) as CollaborationEvent
};
function captureEvent(value:unknown) {
  const captured=eventSchema.parse(value);
  if(Buffer.byteLength(JSON.stringify(captured))>1024*1024)throw new RangeError('Collaboration record exceeds its 1 MiB capture bound.');
  return captured;
}
function freeze<T>(value:T):T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export interface CollaborationHostOwnership {
  readonly groupId: string;
  readonly hostId: string;
  readonly generation: number;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}
export interface CollaborationHostRequest {
  readonly groupId: string;
  readonly hostId: string;
  readonly supervisorSessionId: string;
  readonly budgetOwnerId: string;
  readonly maxParticipants: number;
  readonly maxConcurrentRuns: number;
  readonly correctionRevision?: number;
}
export interface CollaborationRepository {
  acquireHost(input: CollaborationHostRequest): Promise<CollaborationHostOwnership>;
  load(groupId: string): Promise<CollaborationGroupState | undefined>;
  append(owner: CollaborationHostOwnership,event:CollaborationEvent,tail:EventLedgerTail,key:string): Promise<void>;
  operation(groupId:string,operationId:string): Promise<CollaborationEvent | undefined>;
  readResult(groupId:string,resultId:string):Promise<ParticipantResultRecord | undefined>;
  readPublicArtifact(groupId:string,participantId:string,artifactId:string):Promise<PublicArtifactRef|undefined>;
  findAssignment(groupId:string,participantId:string,assignmentId:string,revision:number,runId:string):Promise<{readonly participant:CollaborationParticipant;readonly assignment:ParticipantAssignment}|undefined>;
}
export interface CollaborationLifetimeLock {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}
export class CollaborationConflictError extends Error {
  constructor(message:string) { super(message); this.name='CollaborationConflictError'; }
}
const memoryOwners = new WeakMap<object, Map<string,CollaborationLifetimeLock>>();
export class EventCollaborationRepository implements CollaborationRepository {
  private readonly owners: Map<string,CollaborationLifetimeLock>;
  private readonly cached = new Map<string,CollaborationGroupState>();
  private readonly pendingReads = new Map<string,Promise<unknown>>();
  private pendingReadCount=0;
  constructor(
    readonly events: Pick<EventRepository<CollaborationEvent>,'tail'|'readRange'|'readMetadataRange'|'appendConditional'|'referenceByKey'|'readReference'>,
    private readonly acquireLock?: (groupId:string)=>Promise<CollaborationLifetimeLock | undefined>
  ) {
    this.owners=memoryOwners.get(events) ?? new Map<string,CollaborationLifetimeLock>();
    memoryOwners.set(events,this.owners);
  }
  async acquireHost(input:CollaborationHostRequest):Promise<CollaborationHostOwnership> {
    id.parse(input.groupId); id.parse(input.hostId);
    const lock = this.acquireLock ? await this.acquireLock(input.groupId) : this.memoryLock(input.groupId);
    if (!lock) throw new CollaborationConflictError(`Collaboration group ${input.groupId} already has a live host.`);
    try {
      let state=await this.load(input.groupId);
      if (!state) {
        const event:CollaborationEvent={type:'collaboration.created',format:'agent-core.collaboration/1',groupId:input.groupId,supervisorSessionId:input.supervisorSessionId,budgetOwnerId:input.budgetOwnerId,maxParticipants:input.maxParticipants,maxConcurrentRuns:input.maxConcurrentRuns,correctionRevision:input.correctionRevision ?? 0};
        await this.write(input.groupId,event,{sequence:-1,driverGeneration:0},0,'group:created');
        state=await this.load(input.groupId);
      }
      if (state?.supervisorSessionId !== input.supervisorSessionId || state.budgetOwnerId!==input.budgetOwnerId || state.maxParticipants!==input.maxParticipants || state.maxConcurrentRuns!==input.maxConcurrentRuns)
        throw new CollaborationConflictError('Collaboration group configuration differs from its recorded binding.');
      const generation=state.hostGeneration+1;
      await this.write(input.groupId,{type:'collaboration.host_acquired',hostId:input.hostId,generation},state.tail,generation,`host:${String(generation)}`);
      let released=false;
      const owner:CollaborationHostOwnership=Object.freeze({
        groupId:input.groupId,hostId:input.hostId,generation,
        assertOwned:async()=>{
          if(released) throw new CollaborationConflictError('Collaboration host was released.');
          await lock.assertOwned();
          const tail=await this.events.tail(groupKey(input.groupId));
          if(tail.driverGeneration!==generation) throw new CollaborationConflictError('Collaboration host generation is stale.');
        },
        release:async()=>{ if(!released) {await lock.release();released=true;} }
      });
      return owner;
    } catch(error) {await lock.release();throw error;}
  }
  private memoryLock(groupId:string):CollaborationLifetimeLock | undefined {
    if(this.owners.has(groupId)) return undefined;
    let released=false;
    const lock:CollaborationLifetimeLock={
      assertOwned:()=>{if(released || this.owners.get(groupId)!==lock) return Promise.reject(new CollaborationConflictError('Collaboration ownership was lost.'));return Promise.resolve();},
      release:()=>{if(this.owners.get(groupId)===lock)this.owners.delete(groupId);released=true;return Promise.resolve();}
    };
    this.owners.set(groupId,lock);return lock;
  }
  load(groupId:string):Promise<CollaborationGroupState | undefined> {
    if(this.pendingReadCount>=1024)return Promise.reject(new CollaborationConflictError('Collaboration repository read admission bound exceeded.'));
    this.pendingReadCount+=1;
    const previous=this.pendingReads.get(groupId) ?? Promise.resolve();
    const task=previous.catch(()=>undefined).then(()=>this.read(groupId)).finally(()=>{this.pendingReadCount-=1;});
    this.pendingReads.set(groupId,task);
    void task.finally(()=>{if(this.pendingReads.get(groupId)===task)this.pendingReads.delete(groupId);}).catch(()=>undefined);
    return task;
  }
  private async read(groupId:string):Promise<CollaborationGroupState | undefined> {
    const key=groupKey(groupId),tail=await this.events.tail(key);
    let state=this.cached.get(groupId);
    if(state && (tail.sequence<state.tail.sequence || (tail.sequence===state.tail.sequence && (tail.hash!==state.tail.hash || tail.driverGeneration!==state.tail.driverGeneration))))throw new Error('Collaboration history changed behind its verified boundary.');
    if(tail.sequence===-1)return undefined;
    if(state?.tail.sequence===tail.sequence)return state;
    let cursor=state?.tail.sequence ?? -1;
    while(cursor<tail.sequence) {
      const page=await this.events.readRange(key,{afterSequence:cursor,through:tail,limit:256});
      if(page.oversized || page.nextSequence<=cursor) throw new Error('Collaboration ledger could not advance through its verified boundary.');
      for(const record of page.records)state=apply(state,record.event,tail,record.event.type==='collaboration.result_accepted'?await this.readResult(groupId,record.event.resultId):undefined);
      cursor=page.nextSequence;
    }
    if(state){
      this.cached.delete(groupId);this.cached.set(groupId,state);
      for(const id of this.cached.keys()){if(this.cached.size<=8)break;this.cached.delete(id);}
    }
    return state;
  }
  async findAssignment(groupId:string,participantId:string,assignmentId:string,revision:number,runId:string):Promise<{readonly participant:CollaborationParticipant;readonly assignment:ParticipantAssignment}|undefined> {
    id.parse(participantId);id.parse(assignmentId);count.parse(revision);id.parse(runId);
    const page=await this.events.readMetadataRange(groupKey(groupId),{types:['collaboration.assigned'],metadata:{assignmentIdentity:assignmentIdentity(participantId,assignmentId,revision)},limit:2,maxBytes:16384});
    if(page.oversized)throw new Error('Captured collaboration assignment exceeds the bounded exact lookup.');
    if(page.records.length>1 || !page.complete)throw new Error('Collaboration assignment identity is not unique.');
    const reference=page.records[0]?.reference;
    const event=reference ? (await this.events.readReference(reference)).event : undefined;
    if(event?.type!=='collaboration.assigned' || event.participant.participantId!==participantId || event.assignment.assignmentId!==assignmentId || event.assignment.revision!==revision || event.assignment.runId!==runId)return undefined;
    return Object.freeze({participant:event.participant,assignment:event.assignment});
  }
  async readPublicArtifact(groupId:string,participantId:string,artifactId:string):Promise<PublicArtifactRef|undefined> {
    id.parse(participantId);id.parse(artifactId);
    const reference=await this.events.referenceByKey(groupKey(groupId),publicArtifactOwnershipKey(participantId,artifactId));
    if(!reference)return undefined;
    const event=(await this.events.readReference(reference)).event;
    if(event.type!=='collaboration.public_artifact_owned' || event.participantId!==participantId || event.artifact.artifactId!==artifactId)throw new Error('Artifact ownership key resolved to a different source identity.');
    return event.artifact;
  }
  async readResult(groupId:string,resultId:string):Promise<ParticipantResultRecord|undefined> {
    const reference=await this.events.referenceByKey(groupKey(groupId),`result:${resultId}`);
    if(!reference)return undefined;
    const record=await this.events.readReference(reference);
    if(record.event.type!=='collaboration.result_recorded')throw new Error('Collaboration result key resolved to a different event kind.');
    return record.event.result;
  }
  async operation(groupId:string,operationId:string):Promise<CollaborationEvent|undefined> {
    const ref=await this.events.referenceByKey(groupKey(groupId),`operation:${operationId}`);
    return ref ? (await this.events.readReference(ref)).event : undefined;
  }
  async append(owner:CollaborationHostOwnership,event:CollaborationEvent,tail:EventLedgerTail,key:string):Promise<void> {
    await owner.assertOwned();
    if(tail.driverGeneration!==owner.generation)throw new CollaborationConflictError('Stale collaboration host generation.');
    // Validate the domain transition before publishing it, not only on the next replay.
    const captured=collaborationEventCodec.decode(event);
    const state=await this.load(owner.groupId);
    if(state?.tail.sequence !== tail.sequence || state.tail.hash!==tail.hash)throw new CollaborationConflictError('Stale collaboration ledger boundary.');
    if(captured.type==='collaboration.assigned'){
      const existing=await this.events.readMetadataRange(groupKey(owner.groupId),{types:['collaboration.assigned'],metadata:{assignmentIdentity:assignmentIdentity(captured.assignment.participantId,captured.assignment.assignmentId,captured.assignment.revision)},limit:1,maxBytes:16384});
      if(existing.oversized || existing.records.length)throw new CollaborationConflictError('Collaboration assignment identity was already used.');
    }
    if(captured.type==='collaboration.result_accepted'){
      const prior=await this.events.readMetadataRange(groupKey(owner.groupId),{types:['collaboration.result_accepted'],metadata:{acceptedResult:hashJson(captured.resultId)},limit:1,maxBytes:16384});
      if(prior.oversized || prior.records.length)throw new CollaborationConflictError('Participant result was already accepted.');
    }
    apply(state,captured,tail,captured.type==='collaboration.result_accepted'?await this.readResult(owner.groupId,captured.resultId):undefined);
    await this.write(owner.groupId,captured,tail,owner.generation,key);
  }
  private async write(groupId:string,event:CollaborationEvent,tail:EventLedgerTail,generation:number,key:string):Promise<void> {
    const result=await this.events.appendConditional(groupKey(groupId),event,{expectedTail:tail,driverGeneration:generation,idempotencyKey:key,actor:'runtime'});
    if(result.kind==='committed' || result.kind==='already_committed' || result.kind==='committed_index_unknown')return;
    if(result.kind==='rejected')throw new CollaborationConflictError(`Collaboration append rejected: ${result.reason}.`);
    throw new Error(`Collaboration durability failed: ${result.kind}.`);
  }
}
export class InMemoryCollaborationRepository extends EventCollaborationRepository {
  constructor(){super(new InMemoryEventRepository(collaborationEventCodec));}
}
export function collaborationGroupKey(groupId:string):string {return groupKey(groupId);}
function groupKey(groupId:string):string {id.parse(groupId);return `collaboration-${hashJson(groupId)}`;}
function apply(previous:CollaborationGroupState|undefined,event:CollaborationEvent,tail:EventLedgerTail,acceptedResult?:ParticipantResultRecord):CollaborationGroupState {
  if(event.type==='collaboration.created') {
    if(previous || event.maxConcurrentRuns>event.maxParticipants)throw new Error('Contradictory collaboration group creation.');
    return freeze({groupId:event.groupId,supervisorSessionId:event.supervisorSessionId,budgetOwnerId:event.budgetOwnerId,maxParticipants:event.maxParticipants,maxConcurrentRuns:event.maxConcurrentRuns,epoch:0,correctionRevision:event.correctionRevision,hostGeneration:0,hostId:'unclaimed',participants:[],controls:[],acceptances:[],tail});
  }
  if(!previous)throw new Error('Collaboration history has no group creation.');
  const base={...previous,tail};
  if(event.type==='collaboration.host_acquired') {
    if(event.generation!==previous.hostGeneration+1)throw new Error('Contradictory collaboration host generation.');
    return freeze({...base,hostId:event.hostId,hostGeneration:event.generation});
  }
  if(event.type==='collaboration.assigned') {
    const prior=previous.participants.find(p=>p.participant.participantId===event.participant.participantId);
    if((event.assignment.origin==='delegated')!==(event.assignment.delegatedBy!==undefined))throw new Error('Delegated assignments require their original sender.');
    if(event.assignment.delegatedBy){const sender=event.assignment.delegatedBy;if(sender.participantId===undefined ? sender.sessionId!==previous.supervisorSessionId : !previous.participants.some(p=>p.participant.participantId===sender.participantId && p.participant.sessionId===sender.sessionId && (sender.runId===undefined || p.assignment.runId===sender.runId)))throw new Error('Delegated assignment sender does not match group membership.');}
    if((event.assignment.initialSources.length>0)!==(event.assignment.sourceSender!==undefined))throw new Error('Initial selected sources require their exact sender identity.');
    if(event.assignment.sourceSender){
      const sender=event.assignment.sourceSender,parent=event.participant.parentParticipantId;
      if(parent===undefined ? sender.participantId!==`supervisor:${previous.supervisorSessionId}` || sender.sessionId!==previous.supervisorSessionId : !previous.participants.some(p=>p.participant.participantId===parent && p.participant.participantId===sender.participantId && p.participant.sessionId===sender.sessionId && p.assignment.runId===sender.runId))throw new Error('Initial selected source sender is outside its recorded assignment.');
    }
    if(event.participant.groupId!==previous.groupId || event.participant.createdBySessionId!==(event.participant.parentParticipantId===undefined?previous.supervisorSessionId:previous.participants.find(p=>p.participant.participantId===event.participant.parentParticipantId)?.participant.sessionId) || event.assignment.participantId!==event.participant.participantId || event.assignment.budgetOwnerId!==previous.budgetOwnerId || event.assignment.epoch!==previous.epoch || event.assignment.revision!==(prior ? prior.assignment.revision+1 : 1) || event.participant.sessionId===previous.supervisorSessionId || previous.participants.some(p=>p.participant.participantId!==event.participant.participantId && p.participant.sessionId===event.participant.sessionId) || (event.participant.parentParticipantId!==undefined && !previous.participants.some(p=>p.participant.participantId===event.participant.parentParticipantId)))
      throw new Error('Contradictory participant assignment identity.');
    if(prior && (hashJson(prior.participant)!==hashJson(event.participant) || prior.cancelled || (!hasFinal(prior) && prior.phase!=='cancelled')))throw new Error('Participant is not ready for a new assignment.');
    if(!prior && previous.participants.length>=previous.maxParticipants)throw new Error('Participant count bound exceeded.');
    if(previous.participants.filter(p=>!hasFinal(p) && p.phase!=='cancelled').length>=previous.maxConcurrentRuns)throw new Error('Participant concurrency bound exceeded.');
    const next:ParticipantView={participant:event.participant,assignment:event.assignment,cancelled:false,phase:'admitted',resultCount:prior?.resultCount ?? 0,results:prior?.results ?? []};
    return freeze({...base,participants:[...previous.participants.filter(p=>p!==prior),next]});
  }
  if(event.type==='collaboration.corrected') {
    if(event.epoch!==previous.epoch+1 || event.correctionRevision<previous.correctionRevision)throw new Error('Contradictory correction epoch.');
    return freeze({...base,epoch:event.epoch,correctionRevision:event.correctionRevision});
  }
  if(event.type==='collaboration.control_requested') {
    if(event.epoch!==previous.epoch || new Set(event.targets.map(target=>target.participantId)).size!==event.targets.length || event.targets.some(target=>!previous.participants.some(p=>matchesControlTarget(p,target))))throw new Error('Invalid participant control target.');
    if(previous.controls.some(control=>control.mode===event.mode && control.targets.some(prior=>event.targets.some(target=>prior.participantId===target.participantId))))throw new CollaborationConflictError('Participant already has a pending control of this kind; retry its original operation.');
    return freeze({...base,controls:[...previous.controls,{operationId:event.operationId,mode:event.mode,targets:event.targets,reason:event.reason,epoch:event.epoch,applied:false}],participants:previous.participants.map(p=>event.mode==='cancel' && event.targets.some(target=>matchesControlTarget(p,target))?{...p,cancelled:true}:p)});
  }
  if(event.type==='collaboration.assignment_withdrawn') {
    const view=previous.participants.find(p=>p.participant.participantId===event.participantId);
    if(view?.assignment.assignmentId !== event.assignmentId || view.assignment.revision!==event.assignmentRevision || view.assignment.runId!==event.runId || hasFinal(view) || !previous.controls.some(c=>c.operationId===event.operationId && c.targets.some(target=>matchesControlTarget(view,target))))throw new Error('Invalid unstarted assignment withdrawal.');
    return freeze({...base,participants:previous.participants.map(p=>p===view?{...p,phase:'cancelled'}:p)});
  }
  if(event.type==='collaboration.control_applied') {
    if(!previous.controls.some(c=>c.operationId===event.operationId && !c.applied))throw new Error('No pending participant control.');
    return freeze({...base,controls:previous.controls.filter(c=>c.operationId!==event.operationId)});
  }
  if(event.type==='collaboration.public_artifact_owned') {
    if(!previous.participants.some(view=>view.participant.participantId===event.participantId))throw new Error('Artifact owner is not a collaboration participant.');
    // Ownership is immutable indexed history, not an unbounded live projection.
    return freeze(base);
  }
  if(event.type==='collaboration.result_recorded') {
    const item=event.result,view=previous.participants.find(p=>p.participant.participantId===item.participantId);
    if(item.assignmentId !== view?.assignment.assignmentId || item.assignmentRevision!==view.assignment.revision || item.runId!==view.assignment.runId || item.epoch!==view.assignment.epoch || previous.participants.some(p=>p.results.some(r=>r.resultId===item.resultId)) || (item.kind==='final' && (item.runEnded.runId!==item.runId || hasFinal(view))) || (item.kind==='partial' && (item.source.runId!==item.runId || item.epoch!==previous.epoch || view.cancelled || hasFinal(view))))throw new Error('Contradictory participant result reference.');
    return freeze({...base,participants:previous.participants.map(p=>p===view?{...p,phase:item.kind==='final'?'ended':p.phase,resultCount:p.resultCount+1,results:[...p.results,item].slice(-32)}:p)});
  }
  const found=acceptedResult ?? previous.participants.flatMap(p=>p.results).find(r=>r.resultId===event.resultId);
  if(found?.resultId !== event.resultId || !previous.participants.some(p=>p.participant.participantId===found.participantId && p.assignment.assignmentId===found.assignmentId && p.assignment.revision===found.assignmentRevision) || found.epoch!==previous.epoch || event.epoch!==previous.epoch || previous.acceptances.some(a=>a.resultId===event.resultId))throw new Error('Result acceptance is stale or repeated.');
  return freeze({...base,acceptances:[...previous.acceptances,{operationId:event.operationId,resultId:event.resultId,epoch:event.epoch}].slice(-256)});
}
export function hasFinal(view:ParticipantView):boolean {return view.results.some(r=>r.kind==='final' && r.assignmentId===view.assignment.assignmentId && r.assignmentRevision===view.assignment.revision && r.runId===view.assignment.runId);}

function matchesControlTarget(view:ParticipantView,target:ParticipantControlTarget):boolean {
  return view.participant.participantId===target.participantId && view.assignment.assignmentId===target.assignmentId && view.assignment.revision===target.assignmentRevision && view.assignment.runId===target.runId;
}

function assignmentIdentity(participantId:string,assignmentId:string,revision:number):string {return hashJson({participantId,assignmentId,revision});}

export function publicArtifactOwnershipKey(participantId:string,artifactId:string):string {return `public-artifact:${hashJson({participantId,artifactId})}`;}
