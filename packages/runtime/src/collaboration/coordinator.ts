import { AsyncLocalStorage } from 'node:async_hooks';
import { textRange } from '../history/reader.js';
import { randomUUID } from 'node:crypto';
import { hashJson, decodeOwnedArtifactRef, sameArtifactIdentity, type PublicArtifactRef, type EventReference } from '@agent-core/persistence';
import { parseJsonObject } from '@agent-core/json';
import { ApplicationEvents } from '../session/event-delivery.js';
import type { AgentSession, AgentSessionSubmissionResult } from '../session/agent-session.js';
import { ownSessionSubmissionConfiguration } from '../session/submission-lifecycle.js';
import { parseCollaborationPolicy, type CollaborationCoordinatorOptions, type CollaborationGroupState, type CollaborationParticipantPage, type ParticipantSummary, type CollaborationNotification, type ParticipantAssignment, type ParticipantAssignmentSender, type ParticipantContinueInput, type ParticipantControlInput, type ParticipantExecutionBinding, type ParticipantResultRead, type ParticipantResultRecord, type ParticipantStartInput, type ParticipantUserContinueInput, type ParticipantUserInput, type ParticipantView, type ParticipantWaitResult } from './contracts.js';
import { CollaborationConflictError, collaborationEventCodec, hasFinal, publicArtifactOwnershipKey, type CollaborationEvent, type CollaborationHostOwnership } from './repository.js';

/** Supervises ordinary sessions. It does not implement an agent loop, run driver, or input queue. */
export class CollaborationCoordinator {
  private readonly sessions=new Map<string,{assignmentId:string;revision:number;runId:string;session:AgentSession;unsubscribe:()=>void}>();
  private readonly events=new ApplicationEvents<CollaborationNotification>(()=>'collaboration.changed');
  private lifecycle:Promise<unknown>=Promise.resolve();
  private authority:Promise<unknown>=Promise.resolve();
  private readonly authorityContext=new AsyncLocalStorage<{active:boolean}>();
  private readonly observers=new Set<Promise<void>>();
  private changeRevision=0;
  private pendingLifecycle=0;
  private pendingAuthority=0;
  private pendingWaits=0;
  private subscriptions=0;
  private readonly waitGraph=new Map<string,ReadonlySet<string>>();
  private closing=false;
  private closed=false;
  private closeCompletion:Promise<void>|undefined;
  private activation:Promise<void>|undefined;
  private owner:CollaborationHostOwnership|undefined;
  private readonly maxWaitMs:number;
  private constructor(private readonly options:CollaborationCoordinatorOptions) {
    this.maxWaitMs=options.maxWaitMs ?? 30000;
  }
  static async open(options:CollaborationCoordinatorOptions):Promise<CollaborationCoordinator> {
    const policy=parseCollaborationPolicy({...(options.maxParticipants===undefined?{}:{maxParticipants:options.maxParticipants}),...(options.maxConcurrentRuns===undefined?{}:{maxConcurrentRuns:options.maxConcurrentRuns}),...(options.maxWaitMs===undefined?{}:{maxWaitMs:options.maxWaitMs}),...(options.maxPendingOperations===undefined?{}:{maxPendingOperations:options.maxPendingOperations})});
    const coordinator=new CollaborationCoordinator({...options,...policy});
    try {await coordinator.activateIfPresent();return coordinator;}
    catch(error) {await coordinator.close().catch(()=>undefined);throw error;}
  }
  private async activateIfPresent():Promise<void> {
    if(this.owner)return;
    if(await this.options.repository.load(this.options.groupId))await this.activate();
  }
  private activate():Promise<void> {
    if(this.owner)return Promise.resolve();
    if(this.activation)return this.activation;
    this.activation=(async()=>{
      if(this.closing)throw new CollaborationConflictError('Collaboration host is closing.');
      const policy=parseCollaborationPolicy({...(this.options.maxParticipants===undefined?{}:{maxParticipants:this.options.maxParticipants}),...(this.options.maxConcurrentRuns===undefined?{}:{maxConcurrentRuns:this.options.maxConcurrentRuns})});
      this.owner=await this.options.repository.acquireHost({groupId:this.options.groupId,hostId:this.options.hostId,supervisorSessionId:this.options.supervisorSessionId,budgetOwnerId:this.options.budgetOwnerId,maxParticipants:policy.maxParticipants,maxConcurrentRuns:policy.maxConcurrentRuns,correctionRevision:await this.options.readCorrectionRevision?.() ?? 0});
      await this.recover();
    })().finally(()=>{this.activation=undefined;});
    return this.activation;
  }
  private requireOwner():CollaborationHostOwnership {
    if(!this.owner)throw new CollaborationConflictError('Collaboration group has not been activated.');
    return this.owner;
  }
  /** Root effects remain ordinary until collaboration exists; then they share its lifetime owner. */
  async withSupervisorExecution<T>(operation:()=>Promise<T>):Promise<T> {
    if(this.closing)throw new CollaborationConflictError('Collaboration host is closing.');
    await this.activateIfPresent();
    return this.authorized(async()=>{
      if(this.owner){await this.owner.assertOwned();await this.synchronizeCorrection();}
      return operation();
    });
  }

  subscribe(listener:(event:CollaborationNotification)=>void|Promise<void>,onFailure:(error:Error)=>void|Promise<void>=()=>undefined):()=>void {
    if(this.subscriptions>=this.pendingLimit())throw new CollaborationConflictError('Collaboration subscription admission bound exceeded.');
    this.subscriptions+=1;const unsubscribe=this.events.subscribe(listener,onFailure);let released=false;
    return ()=>{if(!released){released=true;this.subscriptions-=1;unsubscribe();}};
  }
  /** Fences a short admission/publication boundary against group corrections. */
  withCurrent<T>(expectedEpoch:number,operation:()=>Promise<T>):Promise<T> {
    return this.activate().then(()=>this.authorized(async()=>{await this.assertEpoch(expectedEpoch);return operation();}));
  }
  /** The accepted session revision closes crashes between source admission and epoch publication. */
  withSupervisorSubmission<T>(operation:()=>Promise<T>):Promise<T> {
    return this.withSupervisorExecution(async()=>{
      try{return await operation();}
      finally{if(this.owner)await this.synchronizeCorrection();}
    });
  }
  async authorizationState():Promise<CollaborationGroupState> {
    await this.activateIfPresent();await this.owner?.assertOwned();return this.state();
  }
  async inspect():Promise<CollaborationGroupState> {
    await this.activateIfPresent();
    const state=await this.authorized(async()=>{
      await this.owner?.assertOwned();
      if(this.owner)await this.reconcile();
      return this.state();
    });
    return Object.freeze({...state,participants:Object.freeze(await Promise.all(state.participants.map(view=>this.view(view,state.epoch))))});
  }
  async inspectParticipants(input:{readonly offset?:number;readonly limit?:number}={}):Promise<CollaborationParticipantPage> {
    const offset=input.offset ?? 0,limit=input.limit ?? 64;
    if(!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>64)throw new RangeError('Invalid participant page.');
    await this.activateIfPresent();
    const group=await this.authorized(async()=>{
      await this.owner?.assertOwned();
      const selected=(await this.state()).participants.slice(offset,offset+limit).map(p=>p.participant.participantId);
      if(this.owner)await this.reconcile(new Set(selected));
      return this.state();
    });
    const participants=await Promise.all(group.participants.slice(offset,offset+limit).map(async view=>summarizeParticipant(await this.view(view,group.epoch))));
    return Object.freeze({groupId:group.groupId,supervisorSessionId:group.supervisorSessionId,epoch:group.epoch,maxParticipants:group.maxParticipants,maxConcurrentRuns:group.maxConcurrentRuns,maxWaitMs:this.maxWaitMs,participants:Object.freeze(participants),total:group.participants.length,nextOffset:offset+participants.length<group.participants.length?offset+participants.length:null,coverage:offset===0 && participants.length===group.participants.length?'complete':'partial'});
  }
  async inspectParticipantSummary(participantId:string):Promise<ParticipantSummary> {
    return summarizeParticipant(await this.inspectParticipant(participantId));
  }
  async inspectParticipant(participantId:string):Promise<ParticipantView> {
    await this.activateIfPresent();
    const snapshot=await this.authorized(async()=>{
      await this.owner?.assertOwned();
      if(this.owner)await this.reconcile(new Set([participantId]));
      const group=await this.state();return {view:requireParticipant(group,participantId),epoch:group.epoch};
    });
    return this.view(snapshot.view,snapshot.epoch);
  }
  start(input:ParticipantStartInput):Promise<ParticipantView> {
    const captured=structuredClone(input);
    return this.serial(async()=>{
      await this.activate();
      const fingerprint=hashJson(captured);
      const existing=await this.operation(captured.operationId,fingerprint);
      if(existing) {
        if(existing.type!=='collaboration.assigned')throw new CollaborationConflictError('Operation belongs to a different collaboration action.');
        return this.resolveAssignmentReceipt(existing,true);
      }
      await this.reconcile();
      const assigned=await this.withCurrent(captured.expectedEpoch,async()=>{
        const state=await this.state();
        const participant={groupId:state.groupId,participantId:captured.participantId ?? randomUUID(),sessionId:captured.sessionId ?? randomUUID(),createdBySessionId:captured.parentParticipantId===undefined?state.supervisorSessionId:requireParticipant(state,captured.parentParticipantId).participant.sessionId,...(captured.parentParticipantId===undefined?{}:{parentParticipantId:captured.parentParticipantId})};
        if(state.participants.some(p=>p.participant.participantId===participant.participantId))throw new CollaborationConflictError('Participant identity is already assigned.');
        const assignment=await this.assignment(captured,participant.participantId,1,state.budgetOwnerId,captured.parentParticipantId===undefined?{sessionId:state.supervisorSessionId}:{sessionId:participant.createdBySessionId,participantId:captured.parentParticipantId,runId:requireParticipant(state,captured.parentParticipantId).assignment.runId});
        await this.options.validateCapabilities?.(assignment.capabilities);
        const event=collaborationEventCodec.decode({type:'collaboration.assigned',operationId:captured.operationId,requestFingerprint:fingerprint,participant,assignment});
        await this.append(event,`operation:${captured.operationId}`);
        return requireParticipant(await this.state(),participant.participantId);
      });
      await this.dispatch(assigned);
      return this.inspectParticipant(assigned.participant.participantId);
    });
  }
  continue(input:ParticipantContinueInput):Promise<ParticipantView> {
    const captured=structuredClone(input);
    return this.serial(()=>this.continueCaptured(captured));
  }
  continueUserInput(input:ParticipantUserContinueInput):Promise<ParticipantSummary> {
    const captured=structuredClone(input);
    return this.serial(async()=>{
      const prior=requireParticipant(await this.state(),captured.participantId);
      return summarizeParticipant(await this.continueCaptured({origin:'user',operationId:captured.operationId,participantId:captured.participantId,expectedSessionId:captured.sessionId,expectedRunId:captured.expectedRunId,expectedEpoch:captured.expectedEpoch,task:captured.task,capabilities:prior.assignment.capabilities,capabilityRevision:prior.assignment.capabilityRevision,budgetScopeId:prior.assignment.budgetScopeId,sourceRefs:prior.assignment.sourceRefs}));
    });
  }
  async sendUserInput(input:ParticipantUserInput):Promise<AgentSessionSubmissionResult> {
    const captured=structuredClone(input);
    const view=requireParticipant(await this.state(),captured.participantId);
    assertTarget(view,captured.sessionId,captured.expectedRunId);
    if(view.cancelled || view.phase==='cancelled' || hasFinal(view))throw new CollaborationConflictError('Participant is not running; use an explicit continuation.');
    await this.withCurrent(captured.expectedEpoch,()=>this.assertAssignment(view));
    const session=await this.session(view);
    return this.withCurrent(captured.expectedEpoch,async()=>{
      const current=requireParticipant(await this.state(),captured.participantId);
      assertTarget(current,captured.sessionId,captured.expectedRunId);
      if(current.cancelled || current.phase==='cancelled' || hasFinal(current))throw new CollaborationConflictError('Participant is not running; use an explicit continuation.');
      return session.submit({task:captured.task},{delivery:'steer',expectedRunId:captured.expectedRunId});
    });
  }
  private async continueCaptured(input:ParticipantContinueInput):Promise<ParticipantView> {
    const fingerprint=hashJson(input),existing=await this.operation(input.operationId,fingerprint);
    if(existing) {
      if(existing.type!=='collaboration.assigned' || existing.participant.participantId!==input.participantId)throw new CollaborationConflictError('Operation belongs to a different collaboration action.');
      return this.resolveAssignmentReceipt(existing,true);
    }
    await this.reconcile();
    const assigned=await this.withCurrent(input.expectedEpoch,async()=>{
      const state=await this.state(),prior=requireParticipant(state,input.participantId);
      assertTarget(prior,input.expectedSessionId,input.expectedRunId);
      if(prior.cancelled || (!hasFinal(prior) && prior.phase!=='cancelled'))throw new CollaborationConflictError('Participant must finish its current assignment before continuing.');
      // Continuing work retains its cumulative scope rather than obtaining a fresh allowance.
      if(prior.assignment.budgetScopeId!==input.budgetScopeId)throw new CollaborationConflictError('Continuing a participant cannot reset its budget scope.');
      const assignment=await this.assignment(input,input.participantId,prior.assignment.revision+1,state.budgetOwnerId,{sessionId:state.supervisorSessionId});
      await this.options.validateCapabilities?.(assignment.capabilities);
      await this.append({type:'collaboration.assigned',operationId:input.operationId,requestFingerprint:fingerprint,participant:prior.participant,assignment},`operation:${input.operationId}`);
      return requireParticipant(await this.state(),input.participantId);
    });
    await this.dispatch(assigned);return this.inspectParticipant(input.participantId);
  }
  /** Idempotency returns the operation's original admission, never a newer assignment. */
  async assignmentReceipt(operationId:string):Promise<ParticipantView|undefined> {
    await this.activateIfPresent();await this.owner?.assertOwned();
    const event=await this.options.repository.operation(this.options.groupId,operationId);
    return event?.type==='collaboration.assigned'?this.resolveAssignmentReceipt(event,false):undefined;
  }
  private async resolveAssignmentReceipt(event:Extract<CollaborationEvent,{type:'collaboration.assigned'}>,dispatch:boolean):Promise<ParticipantView> {
    const state=await this.state(),current=requireParticipant(state,event.participant.participantId),assignment=event.assignment;
    if(current.assignment.assignmentId===assignment.assignmentId && current.assignment.revision===assignment.revision && current.assignment.runId===assignment.runId){
      if(dispatch && !hasFinal(current) && current.phase!=='cancelled' && !current.cancelled && assignment.epoch===state.epoch)await this.dispatch(current);
      return this.inspectParticipant(current.participant.participantId);
    }
    const results=current.results.filter(result=>result.assignmentId===assignment.assignmentId && result.assignmentRevision===assignment.revision && result.runId===assignment.runId);
    const run=await this.options.runs.find(assignment.runId);
    if(run?.state.phase.kind==='terminal'){
      const terminal=await this.options.runs.readTerminal(run),final=await this.options.repository.readResult(this.options.groupId,`final:${terminal.finalizationId}`);
      if(final && !results.some(result=>result.resultId===final.resultId))results.push(final);
    }
    return Object.freeze({...current,participant:event.participant,assignment,phase:run?.state.phase.kind==='terminal'?'ended':'cancelled',results:Object.freeze(results)});
  }
  interrupt(input:ParticipantControlInput):Promise<ParticipantSummary> {return this.control(structuredClone(input),'interrupt',false).then(summarizeParticipant);}
  cancel(input:ParticipantControlInput & {readonly cascade:boolean}):Promise<ParticipantSummary> {
    if(typeof input.cascade!=='boolean')return Promise.reject(new TypeError('Cancellation requires an explicit cascade choice.'));
    return this.control(structuredClone(input),'cancel',input.cascade).then(summarizeParticipant);
  }
  private control(input:ParticipantControlInput,mode:'interrupt'|'cancel',cascade:boolean):Promise<ParticipantView> {
    return this.serial(async()=>{
      const fingerprint=hashJson({input,mode,cascade});
      const existing=await this.operation(input.operationId,fingerprint);
      if(!existing)await this.withCurrent(input.expectedEpoch,async()=>{
        const state=await this.state(),target=requireParticipant(state,input.participantId);
        assertTarget(target,input.expectedSessionId,input.expectedRunId);
        const ids=new Set([input.participantId]);
        if(cascade)for(let changed=true;changed;) {
          changed=false;
          for(const view of state.participants)if(view.participant.parentParticipantId && ids.has(view.participant.parentParticipantId) && !ids.has(view.participant.participantId)){ids.add(view.participant.participantId);changed=true;}
        }
        if(input.authorizedParticipantIds!==undefined){
          const granted=input.authorizedParticipantIds;
          if(granted.length>257 || granted.some(id=>typeof id!=='string' || !id.length || id.length>1024))throw new TypeError('Invalid participant control target grant.');
          if([...ids].some(id=>!granted.includes(id)))throw new CollaborationConflictError('Participant control target is outside the actor grant.');
        }
        const targets=[...ids].map(participantId=>{
          const {assignment}=requireParticipant(state,participantId);
          return {participantId,assignmentId:assignment.assignmentId,assignmentRevision:assignment.revision,runId:assignment.runId};
        });
        await this.append({type:'collaboration.control_requested',operationId:input.operationId,requestFingerprint:fingerprint,mode,targets,reason:input.reason,epoch:input.expectedEpoch},`operation:${input.operationId}`);
      });
      else if(existing.type!=='collaboration.control_requested')throw new CollaborationConflictError('Operation belongs to a different collaboration action.');
      await this.applyControl(input.operationId);
      return this.inspectParticipant(input.participantId);
    },true);
  }
  correct(input:{readonly operationId:string;readonly expectedEpoch:number;readonly reason:string}):Promise<CollaborationGroupState> {
    const captured=structuredClone(input);
    return this.activate().then(()=>this.authorized(async()=>{
      const fingerprint=hashJson(captured),existing=await this.operation(captured.operationId,fingerprint);
      if(existing) {
        if(existing.type!=='collaboration.corrected')throw new CollaborationConflictError('Operation belongs to a different collaboration action.');
        return this.state();
      }
      await this.assertEpoch(captured.expectedEpoch);
      await this.append({type:'collaboration.corrected',operationId:captured.operationId,requestFingerprint:fingerprint,epoch:captured.expectedEpoch+1,correctionRevision:(await this.state()).correctionRevision,reason:captured.reason},`operation:${captured.operationId}`);
      return this.state();
    },true));
  }
  async publishPartial(input:{readonly participantId:string;readonly resultId:string;readonly source:EventReference;readonly expectedEpoch:number}):Promise<ParticipantResultRecord> {
    const captured=structuredClone(input);
    return this.withCurrent(captured.expectedEpoch,async()=>{
      const view=requireParticipant(await this.state(),captured.participantId);
      await this.options.runs.readPartialResultReference(captured.source,view.assignment.runId);
      const result:ParticipantResultRecord={...resultIdentity(view),resultId:captured.resultId,kind:'partial',source:captured.source};
      const existing=view.results.find(r=>r.resultId===captured.resultId);
      if(existing){if(hashJson(existing)!==hashJson(result))throw new CollaborationConflictError('Result identity was reused with changed content.');return existing;}
      await this.append({type:'collaboration.result_recorded',result},`result:${result.resultId}`);return result;
    });
  }
  /** Host-recorded ownership of a public output, including late settlement of earlier work. */
  async recordPublicArtifact(participantId:string,artifact:PublicArtifactRef):Promise<void> {
    const captured=decodeOwnedArtifactRef(parseJsonObject(artifact));
    if(captured.visibility!=='public')throw new TypeError('Participant public artifact ownership cannot expose protected artifacts.');
    await this.authorized(async()=>{
      await this.requireOwner().assertOwned();requireParticipant(await this.state(),participantId);
      const existing=await this.options.repository.readPublicArtifact(this.options.groupId,participantId,captured.artifactId);
      if(existing){if(!sameArtifactIdentity(existing,captured))throw new CollaborationConflictError('Public artifact ownership identity changed.');return;}
      await this.append({type:'collaboration.public_artifact_owned',participantId,artifact:captured},publicArtifactOwnershipKey(participantId,captured.artifactId));
    });
  }
  async canReadPublicArtifact(participantId:string,artifact:PublicArtifactRef|string):Promise<boolean> {
    await this.requireOwner().assertOwned();
    requireParticipant(await this.state(),participantId);
    const recorded=await this.options.repository.readPublicArtifact(this.options.groupId,participantId,typeof artifact==='string'?artifact:artifact.artifactId);
    if(!recorded)return false;
    if(typeof artifact==='string')return true;
    const captured=decodeOwnedArtifactRef(parseJsonObject(artifact));
    return captured.visibility==='public' && sameArtifactIdentity(recorded,captured);
  }
  /** Exact immutable historical authority, safe within the current publication boundary. */
  async findAssignment(participantId:string,assignmentId:string,revision:number,runId:string) {
    await this.requireOwner().assertOwned();
    return this.options.repository.findAssignment(this.options.groupId,participantId,assignmentId,revision,runId);
  }
  async findResult(resultId:string):Promise<ParticipantResultRecord|undefined> {
    await this.activateIfPresent();await this.owner?.assertOwned();
    return this.options.repository.readResult(this.options.groupId,resultId);
  }
  async readResult(input:{readonly resultId:string;readonly offset?:number;readonly maxBytes?:number}):Promise<ParticipantResultRead> {
    const offset=input.offset ?? 0,maxBytes=input.maxBytes ?? 8192;
    if(!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(maxBytes) || maxBytes<1024 || maxBytes>32768)throw new RangeError('Invalid participant result byte range.');
    const result=await this.findResult(input.resultId);
    if(!result)throw new Error('Unknown participant result.');
    requireParticipant(await this.state(),result.participantId);
    let content:string,completeness:ParticipantResultRead['completeness'],executionStatus:ParticipantResultRead['executionStatus'],source:EventReference;
    if(result.kind==='final') {
      const run=await this.options.runs.inspect(result.runId),terminal=await this.options.runs.readTerminal(run);
      source=await this.options.runs.readTerminalReference(run);
      if(terminal.finalizationId!==result.finalizationId || hashJson(source)!==hashJson(result.runEnded))throw new Error('Participant result contradicts its authoritative finalization.');
      content=terminal.modelOutput.status==='absent'?'':terminal.modelOutput.message;
      completeness=terminal.modelOutput.status;executionStatus=terminal.executionStatus;
    } else {
      const original=await this.options.runs.readPartialResult(result.source,result.runId);
      source=original.source;content=original.content;completeness=original.modelOutputStatus;executionStatus='in_progress';
    }
    const present=(range:ReturnType<typeof textRange>):ParticipantResultRead=>{
      const complete=range.nextOffset===range.totalBytes;
      return Object.freeze({result,source,classification:'model_authored',text:range.text,offset:range.offset,nextOffset:complete?null:range.nextOffset,totalBytes:range.totalBytes,coverage:range.offset===0 && complete?'complete':'partial',executionStatus,completeness});
    };
    const empty=present(textRange(content,offset,0));
    if(Buffer.byteLength(JSON.stringify(empty))>maxBytes)throw new RangeError('Participant result metadata exceeds the complete envelope byte bound.');
    if(empty.nextOffset===null)return empty;
    let lower=1,upper=maxBytes,best:ParticipantResultRead|undefined;
    while(lower<=upper){
      const budget=Math.floor((lower+upper)/2),candidate=present(textRange(content,offset,budget));
      if(Buffer.byteLength(JSON.stringify(candidate))<=maxBytes){best=candidate;lower=budget+1;}else upper=budget-1;
    }
    if(!best || best.text.length===0)throw new RangeError('Participant result metadata leaves no room for a progressing UTF-8 page.');
    return best;
  }
  async acceptResult(input:{readonly operationId:string;readonly resultId:string;readonly expectedEpoch:number}):Promise<void> {
    const captured=structuredClone(input);
    await this.withCurrent(captured.expectedEpoch,async()=>{
      const fingerprint=hashJson(captured),existing=await this.operation(captured.operationId,fingerprint);
      if(existing){if(existing.type!=='collaboration.result_accepted')throw new CollaborationConflictError('Operation belongs to a different collaboration action.');return;}
      const result=await this.options.repository.readResult(this.options.groupId,captured.resultId);
      const participant=result && requireParticipant(await this.state(),result.participantId);
      if(!result || !participant || result.epoch!==captured.expectedEpoch || participant.assignment.assignmentId!==result.assignmentId || participant.assignment.revision!==result.assignmentRevision)throw new CollaborationConflictError('Participant result acceptance is stale or missing.');
      await this.append({type:'collaboration.result_accepted',operationId:captured.operationId,requestFingerprint:fingerprint,resultId:captured.resultId,epoch:captured.expectedEpoch},`operation:${captured.operationId}`);
    });
  }
  async wait(input:{readonly participantIds:readonly string[];readonly timeoutMs?:number;readonly signal?:AbortSignal;readonly requesterParticipantId?:string}):Promise<ParticipantWaitResult> {
    const ids=[...input.participantIds],timeoutMs=input.timeoutMs ?? this.maxWaitMs;
    if(ids.length<1 || ids.length>256 || new Set(ids).size!==ids.length || !Number.isSafeInteger(timeoutMs) || timeoutMs<0 || timeoutMs>this.maxWaitMs)throw new RangeError('Invalid bounded participant wait.');
    if(this.pendingWaits>=this.pendingLimit())throw new CollaborationConflictError('Collaboration wait admission bound exceeded.');
    const requester=input.requesterParticipantId;
    if(requester!==undefined){
      if(ids.includes(requester) || this.waitGraph.has(requester) || ids.some(id=>this.waitPath(id,requester)))throw new CollaborationConflictError('Participant wait would create a self-wait or cycle.');
      this.waitGraph.set(requester,new Set(ids));
    }
    this.pendingWaits+=1;
    try {
    const deadline=Date.now()+timeoutMs;
    for(;;) {
      const changeRevision=this.changeRevision;
      const group=await this.inspect(),participants=ids.map(id=>requireParticipant(group,id));
      if(requester!==undefined)requireParticipant(group,requester);
      if(participants.every(p=>p.phase==='ended' || p.phase==='suspended' || p.phase==='cancelled'))return {reason:'settled',participants:participants.map(summarizeParticipant)};
      if(input.signal?.aborted)return {reason:'aborted',participants:participants.map(summarizeParticipant)};
      const remaining=deadline-Date.now();
      if(remaining<=0)return {reason:'timeout',participants:participants.map(summarizeParticipant)};
      await this.changed(remaining,input.signal,changeRevision);
    }
    }finally{this.pendingWaits-=1;if(requester!==undefined)this.waitGraph.delete(requester);}
  }
  close():Promise<void> {
    if(this.closeCompletion)return this.closeCompletion;
    this.closing=true;
    this.closeCompletion=(async()=>{
      await this.lifecycle.catch(()=>undefined);
      const failures:unknown[]=[];
      for(const value of this.sessions.values())try{await value.session.close();}catch(error){failures.push(error);}
      if(this.owner && this.options.closeParticipant)for(const view of (await this.state()).participants)try{await this.options.closeParticipant(view.participant.participantId);}catch(error){failures.push(error);}
      await Promise.all([...this.observers]);
      if(failures.length)throw new AggregateError(failures,'Participant sessions could not close; collaboration ownership is retained.');
      if(this.owner)await this.reconcile();
      await this.authority.catch(()=>undefined);
      for(const value of this.sessions.values())value.unsubscribe();
      await this.owner?.release();this.closed=true;this.events.close();
    })().catch((error:unknown)=>{this.closeCompletion=undefined;throw error;});
    return this.closeCompletion;
  }
  private async recover():Promise<void> {
    await this.authorized(()=>this.synchronizeCorrection());
    await this.reconcile();
    let state=await this.state();
    for(const control of state.controls)if(!control.applied)await this.applyControl(control.operationId);
    state=await this.state();
    for(const view of state.participants)if(!hasFinal(view) && view.phase!=='cancelled' && !view.cancelled && view.assignment.epoch===state.epoch)await this.dispatch(view);
  }
  private async assignment(input:ParticipantStartInput|ParticipantContinueInput,participantId:string,revision:number,budgetOwnerId:string,sender:ParticipantAssignmentSender):Promise<ParticipantAssignment> {
    const origin=input.origin ?? 'delegated';
    if(origin==='user' && input.delegatedBy!==undefined)throw new TypeError('User assignment cannot carry delegated authorship.');
    const configuration=this.options.captureConfiguration ? ownSessionSubmissionConfiguration(await this.options.captureConfiguration()) : undefined;
    return {origin,...(origin==='delegated'?{delegatedBy:input.delegatedBy ?? sender}:{}),assignmentId:input.assignmentId ?? randomUUID(),participantId,revision,runId:randomUUID(),task:input.task,epoch:input.expectedEpoch,capabilityRevision:input.capabilityRevision,capabilities:input.capabilities,...(configuration===undefined?{}:{configuration}),budgetOwnerId,budgetScopeId:input.budgetScopeId,sourceRefs:input.sourceRefs ?? [],initialSources:input.initialSources ?? [],...(input.sourceSender===undefined?{}:{sourceSender:input.sourceSender})};
  }
  private async dispatch(view:ParticipantView):Promise<void> {
    if(this.closing)throw new CollaborationConflictError('Collaboration host is closing.');
    await this.authorized(()=>this.assertAssignment(view));
    const session=await this.session(view);
    const inspection=await session.inspect();
    const run=await this.options.runs.find(view.assignment.runId);
    if(run?.state.phase.kind==='terminal'){await this.reconcile();return;}
    if(inspection.session.phase==='suspended')return;
    if(inspection.session.activeRunId && inspection.session.activeRunId!==view.assignment.runId)throw new CollaborationConflictError('Participant session has an unrelated active run.');
    if(inspection.pendingSubmissions.some(s=>s.runId===view.assignment.runId)) {
      const next=await session.startNextSubmission();
      if(next && next.kind!=='rejected')this.observe(next.completion);
      return;
    }
    if(run)throw new CollaborationConflictError('Participant run exists without its durable session submission.');
    const submitted=await session.submit({task:view.assignment.task,runId:view.assignment.runId,...(view.assignment.origin==='delegated' && view.assignment.delegatedBy?{origin:{kind:'delegated_assignment' as const,groupId:view.participant.groupId,participantId:view.participant.participantId,assignmentId:view.assignment.assignmentId,assignmentRevision:view.assignment.revision,sender:view.assignment.delegatedBy}}:{})});
    if(submitted.kind==='rejected')throw new CollaborationConflictError(`Participant dispatch was rejected: ${submitted.reason}.`);
    this.observe(submitted.completion);
  }
  private async session(view:ParticipantView):Promise<AgentSession> {
    const current=this.sessions.get(view.participant.participantId);
    if(current?.assignmentId===view.assignment.assignmentId && current.revision===view.assignment.revision && current.runId===view.assignment.runId)return current.session;
    if(current){await current.session.close();current.unsubscribe();this.sessions.delete(view.participant.participantId);}
    const assertCurrent=()=>this.authorized(()=>this.assertAssignment(view));
    const withCurrent=<T>(operation:()=>Promise<T>)=>this.authorized(async()=>{await this.assertAssignment(view);return operation();});
    const binding:ParticipantExecutionBinding=Object.freeze({groupId:view.participant.groupId,participantId:view.participant.participantId,sessionId:view.participant.sessionId,assignmentId:view.assignment.assignmentId,assignmentRevision:view.assignment.revision,runId:view.assignment.runId,hostGeneration:this.requireOwner().generation,correctionEpoch:view.assignment.epoch,capabilityRevision:view.assignment.capabilityRevision,budgetOwnerId:view.assignment.budgetOwnerId,budgetScopeId:view.assignment.budgetScopeId,capabilities:view.assignment.capabilities,assertCurrent,withCurrent});
    const session=await this.options.createSession({coordinator:this,participant:view.participant,assignment:view.assignment,binding,assertCurrent,withCurrent});
    if(session.state().sessionId!==view.participant.sessionId){await session.close();throw new CollaborationConflictError('Participant factory returned a different session identity.');}
    const unsubscribe=session.subscribe(event=>{
      if(event.type==='run.completed' || event.type==='run.failed')this.observe(this.reconcile().then(()=>undefined));
      if(event.type==='run.completed' || event.type==='run.failed' || event.type==='input.queued' || event.type==='delivery.gap')this.notify();
    },error=>{this.events.fail(error);});
    this.sessions.set(view.participant.participantId,{assignmentId:view.assignment.assignmentId,revision:view.assignment.revision,runId:view.assignment.runId,session,unsubscribe});
    await session.restore();
    if(view.assignment.configuration && hashJson(session.state().configuration)!==hashJson(view.assignment.configuration)){
      await session.close();unsubscribe();this.sessions.delete(view.participant.participantId);
      throw new CollaborationConflictError('Participant session model configuration differs from its admitted assignment.');
    }
    return session;
  }
  private async applyControl(operationId:string):Promise<void> {
    const state=await this.state(),control=state.controls.find(c=>c.operationId===operationId);
    if(!control || control.applied)return;
    for(const target of control.targets) {
      const participantId=target.participantId;
      const view=requireParticipant(state,participantId);
      if(view.assignment.assignmentId!==target.assignmentId || view.assignment.revision!==target.assignmentRevision || view.assignment.runId!==target.runId){
        // A continuation proves the original assignment has settled or was withdrawn.
        // Receipt recovery cannot retarget an earlier interrupt to its replacement.
        if(control.mode==='cancel')throw new CollaborationConflictError('A permanently cancelled participant cannot acquire another assignment.');
        continue;
      }
      if(!hasFinal(view)){
        const run=await this.options.runs.find(view.assignment.runId);
        // A cancelled assignment which never reached session admission has no execution to invent.
        if(run || this.sessions.has(participantId)){
          const session=await this.session(view);
          await session.abort(control.reason,view.assignment.runId);
          if(control.mode==='cancel' || !run)await session.close();
        }
      }
      if(control.mode==='cancel'){
        await this.options.closeParticipant?.(participantId);
        const local=this.sessions.get(participantId);
        if(local){await local.session.close();local.unsubscribe();this.sessions.delete(participantId);}
      }
      if(!hasFinal(view) && !await this.options.runs.find(view.assignment.runId))await this.authorized(async()=>{
        const current=requireParticipant(await this.state(),participantId);
        if(current.phase!=='cancelled')await this.append({type:'collaboration.assignment_withdrawn',operationId,participantId,assignmentId:view.assignment.assignmentId,assignmentRevision:view.assignment.revision,runId:view.assignment.runId},`withdrawn:${view.assignment.runId}`);
      });
    }
    await this.authorized(async()=>{
      const latest=await this.state();
      if(latest.controls.some(c=>c.operationId===operationId && !c.applied))await this.append({type:'collaboration.control_applied',operationId},`control-applied:${operationId}`);
    });
  }
  private async reconcile(participantIds?:ReadonlySet<string>):Promise<void> {
    await this.authorized(async()=>{
      await this.synchronizeCorrection();
      const state=await this.state();
      for(const view of state.participants) {
        if((participantIds && !participantIds.has(view.participant.participantId)) || hasFinal(view))continue;
        const run=await this.options.runs.find(view.assignment.runId);
        if(run?.state.phase.kind!=='terminal')continue;
        const terminal=await this.options.runs.readTerminal(run);
        const runEnded=await this.options.runs.readTerminalReference(run);
        const result:ParticipantResultRecord={...resultIdentity(view),resultId:`final:${terminal.finalizationId}`,kind:'final',finalizationId:terminal.finalizationId,runEnded};
        await this.append({type:'collaboration.result_recorded',result},`result:${result.resultId}`);
      }
    });
  }
  private async view(view:ParticipantView,epoch:number):Promise<ParticipantView> {
    if(hasFinal(view) || view.phase==='cancelled')return view;
    const local=this.sessions.get(view.participant.participantId);
    const bound=local?.assignmentId===view.assignment.assignmentId && local.revision===view.assignment.revision && local.runId===view.assignment.runId ? local.session : undefined;
    if(view.assignment.epoch!==epoch && !bound)return Object.freeze({...view,phase:'suspended'});
    const run=await this.options.runs.find(view.assignment.runId);
    const phase=run?.state.phase.kind;
    if(phase==='terminal')return Object.freeze({...view,phase:'ended'});
    // A stopped session can retain an active run with unknown external exposure and
    // finalize_abort pending. Submission scheduling, not abort intent, proves suspension.
    const submission=run && await this.options.readSubmission?.({sessionId:view.participant.sessionId,runId:view.assignment.runId});
    if(submission && submission.runId!==view.assignment.runId)throw new CollaborationConflictError('Participant submission lookup returned an unrelated run.');
    const sessionState=this.options.readSubmission ? undefined : bound?.state();
    const suspended=submission?.state==='suspended' || (sessionState?.activeRunId===view.assignment.runId && sessionState.phase==='suspended');
    return Object.freeze({...view,phase:phase==='suspended' || suspended?'suspended':run?'running':view.cancelled?'cancelled':'admitted'});
  }
  private async assertAssignment(view:ParticipantView):Promise<void> {
    if(this.closing)throw new CollaborationConflictError('Collaboration host is closing.');
    const state=await this.assertEpoch(view.assignment.epoch),current=requireParticipant(state,view.participant.participantId);
    await this.options.validateCapabilities?.(current.assignment.capabilities);
    if(current.cancelled || current.phase==='cancelled' || current.assignment.assignmentId!==view.assignment.assignmentId || current.assignment.revision!==view.assignment.revision || current.assignment.runId!==view.assignment.runId || current.assignment.capabilityRevision!==view.assignment.capabilityRevision || hasFinal(current))throw new CollaborationConflictError('Participant assignment authority is no longer current.');
  }
  private async assertEpoch(expectedEpoch:number):Promise<CollaborationGroupState> {
    if(this.closed)throw new CollaborationConflictError('Collaboration host is closed.');
    await this.requireOwner().assertOwned();await this.synchronizeCorrection();const state=await this.state();
    if(state.epoch!==expectedEpoch)throw new CollaborationConflictError('Collaboration correction epoch is stale.');return state;
  }
  private async synchronizeCorrection():Promise<void> {
    if(!this.options.readCorrectionRevision)return;
    const revision=await this.options.readCorrectionRevision(),state=await this.state();
    if(!Number.isSafeInteger(revision) || revision<state.correctionRevision)throw new CollaborationConflictError('Supervisor correction revision moved behind its recorded boundary.');
    if(revision===state.correctionRevision)return;
    const operationId=`source-correction:${String(revision)}`;
    await this.append({type:'collaboration.corrected',operationId,requestFingerprint:hashJson({correctionRevision:revision}),epoch:state.epoch+1,correctionRevision:revision,reason:'Accepted supervisor correction.'},`operation:${operationId}`);
  }
  private async operation(operationId:string,fingerprint:string):Promise<CollaborationEvent|undefined> {
    const event=await this.options.repository.operation(this.options.groupId,operationId);
    if(event && (!('requestFingerprint' in event) || event.requestFingerprint!==fingerprint))throw new CollaborationConflictError('Collaboration operation identity was reused with changed inputs.');return event;
  }
  private async state():Promise<CollaborationGroupState> {
    const state=await this.options.repository.load(this.options.groupId);
    if(state)return state;
    if(this.owner)throw new Error('Collaboration group disappeared.');
    return Object.freeze({groupId:this.options.groupId,supervisorSessionId:this.options.supervisorSessionId,budgetOwnerId:this.options.budgetOwnerId,maxParticipants:this.options.maxParticipants ?? 4,maxConcurrentRuns:this.options.maxConcurrentRuns ?? 2,epoch:0,correctionRevision:await this.options.readCorrectionRevision?.() ?? 0,hostGeneration:0,hostId:this.options.hostId,tail:Object.freeze({sequence:-1,driverGeneration:0}),participants:Object.freeze([]),controls:Object.freeze([]),acceptances:Object.freeze([])});
  }
  private async append(event:CollaborationEvent,key:string):Promise<void> {
    const state=await this.state();await this.options.repository.append(this.requireOwner(),event,state.tail,key);this.notify();
  }
  private notify():void {this.changeRevision+=1;this.events.publish({type:'collaboration.changed',groupId:this.options.groupId});}
  private pendingLimit():number {return this.options.maxPendingOperations ?? 64;}
  private serial<T>(operation:()=>Promise<T>,control=false):Promise<T> {
    if(this.closing)return Promise.reject(new CollaborationConflictError('Collaboration host is closing.'));
    if(this.pendingLifecycle>=this.pendingLimit()+(control?8:0))return Promise.reject(new CollaborationConflictError('Collaboration operation admission bound exceeded.'));
    this.pendingLifecycle+=1;
    const task=this.lifecycle.catch(()=>undefined).then(operation).finally(()=>{this.pendingLifecycle-=1;});
    this.lifecycle=task;return task;
  }
  private authorized<T>(operation:()=>Promise<T>,control=false):Promise<T> {
    if(this.authorityContext.getStore()?.active)return operation();
    if(this.pendingAuthority>=this.pendingLimit()+(control?8:0))return Promise.reject(new CollaborationConflictError('Collaboration authority admission bound exceeded.'));
    this.pendingAuthority+=1;
    const task=this.authority.catch(()=>undefined).then(()=>{
      const context={active:true};
      return this.authorityContext.run(context,async()=>{try{return await operation();}finally{context.active=false;}});
    }).finally(()=>{this.pendingAuthority-=1;});
    this.authority=task;return task;
  }
  private observe(promise:Promise<unknown>):void {
    const observer=promise.then(()=>this.reconcile(),()=>this.reconcile()).then(()=>undefined,(error:unknown)=>{this.events.fail(error instanceof Error?error:new Error(String(error)));});
    this.observers.add(observer);void observer.finally(()=>this.observers.delete(observer));
  }
  private waitPath(from:string,target:string,seen=new Set<string>()):boolean {
    if(from===target)return true;
    if(seen.has(from))return false;seen.add(from);
    return [...(this.waitGraph.get(from) ?? [])].some(next=>this.waitPath(next,target,seen));
  }
  private changed(timeoutMs:number,signal:AbortSignal|undefined,revision:number):Promise<void> {
    return new Promise(resolve=>{
      let unsubscribe:()=>void=()=>undefined;
      const done=()=>{clearTimeout(timer);unsubscribe();signal?.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,timeoutMs);
      unsubscribe=this.subscribe(done,done);signal?.addEventListener('abort',done,{once:true});
      if(signal?.aborted || revision!==this.changeRevision)done();
    });
  }
}
function requireParticipant(state:CollaborationGroupState,participantId:string):ParticipantView {
  const view=state.participants.find(p=>p.participant.participantId===participantId);
  if(!view)throw new Error(`Unknown collaboration participant: ${participantId}`);return view;
}
function assertTarget(view:ParticipantView,sessionId?:string,runId?:string):void {
  if((sessionId!==undefined && sessionId!==view.participant.sessionId) || (runId!==undefined && runId!==view.assignment.runId))throw new CollaborationConflictError('Participant session or run target is stale.');
}
function resultIdentity(view:ParticipantView) {
  return {participantId:view.participant.participantId,assignmentId:view.assignment.assignmentId,assignmentRevision:view.assignment.revision,runId:view.assignment.runId,epoch:view.assignment.epoch};
}

export function summarizeParticipant(view:ParticipantView):ParticipantSummary {
  const original=view.assignment,bounded=textRange(original.task,0,8192);
  const assignment:ParticipantSummary['assignment']=Object.freeze({origin:original.origin,...(original.delegatedBy===undefined?{}:{delegatedBy:original.delegatedBy}),assignmentId:original.assignmentId,participantId:original.participantId,revision:original.revision,runId:original.runId,task:bounded.text,epoch:original.epoch,capabilityRevision:original.capabilityRevision,budgetOwnerId:original.budgetOwnerId,budgetScopeId:original.budgetScopeId});
  return Object.freeze({participant:view.participant,assignment,sourceCount:original.sourceRefs.length+original.initialSources.length,taskTruncated:bounded.text!==original.task,phase:view.phase,cancelled:view.cancelled,resultCount:view.resultCount,results:Object.freeze(view.results.slice(-8))});
}
