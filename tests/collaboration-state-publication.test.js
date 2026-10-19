import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conservativeProtocolCapabilities } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { captureToolCatalogSelection } from '@agent-core/tools';
import {
  AgentRuntime, AgentSession, AgentRunCoordinator, ContextService, HistoryReader,
  CollaborationCoordinator, InMemoryCollaborationRepository, InMemorySessionRepository,
  InferenceService, InMemoryInferenceRepository, agentEventCodec, peerContributionFingerprint
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { collaborationProvider, deferred } from './fixtures/collaboration-provider.mjs';

const binding={schemaId:'tests/collaboration-state-publication',schemaVersion:1,subject:{}};
const text='Preserve this exact model-authored interpretation.';

async function fixture(t,kind,role,tool,pause=false) {
  const directory=kind==='jsonl'?await mkdtemp(path.join(tmpdir(),'collaboration-state-')):undefined;
  const sessions=directory?new JsonlSessionRepository(directory):new InMemorySessionRepository();
  const root=await sessions.create({id:'supervisor',binding});
  const artifacts=new InMemoryArtifactRepository(),events=new InMemoryEventRepository(agentEventCodec);
  const runs=new AgentRunCoordinator(events,artifacts);
  const provider=collaborationProvider([{
    content:'',terminationReason:'tool_calls',toolCalls:[{id:'save-understanding',type:'function',name:tool,
      input:{kind:'json',value:{operations:[{kind:'create',text}],...(tool==='context_save_and_activate'?{reason:'Retain the interpretation.'}:{})}}}]
  },{}]);
  provider.profile.capabilities.protocol=conservativeProtocolCapabilities('fixture://state-publication',{
    roles:['system','developer','user','assistant'],contextReset:'fresh_request'
  });
  const inference=new InferenceService({provider:provider.provider,repository:new InMemoryInferenceRepository(),artifacts,budget:{maxInvocations:16}});
  const contexts=new Map(),agents=new Map(),completions=new Map();
  const entered=deferred(),release=deferred();
  if(!pause)release.resolve();
  const method=tool==='context_save_and_activate'?'commitContextTransition':'saveSessionState';
  const original=sessions[method].bind(sessions);
  t.mock.method(sessions,method,async(session,input,options={})=>original(session,input,{
    ...options,...(options.withOwnership?{withOwnership:async publish=>{
      entered.resolve();await release.promise;return options.withOwnership(publish);
    }}:{})
  }));
  let host;
  const create=(descriptor,participant)=>{
    const history=new HistoryReader({repository:sessions,session:descriptor,events,artifacts});
    const context=new ContextService({repository:sessions,session:descriptor,history,artifacts,
      policy:{maxSourceBytes:65536,historyRead:{history,isAvailable:()=>true}}});
    contexts.set(descriptor.id,context);
    const agent=new AgentSession({descriptor,repository:sessions,runs,expectedBinding:binding,
      configuration:{provider:provider.profile.provider,model:provider.profile.id},
      ...(!participant && role==='child'?{scheduling:'manual'}:{}),
      ...(!participant?{withSubmissionAdmission:operation=>host.withSupervisorSubmission(operation)}:{}),
      createRuntime(_configuration,onProgress){
        return new AgentRuntime({provider:provider.provider,model:provider.profile.id,maxOutputTokens:64,
          inferenceService:inference,inferenceOwnerId:'owner',context,tools:context.toolDefinitions(),onProgress,
          ...(participant?{participant}:{supervisor:{groupId:'group',withCurrent:operation=>host.withSupervisorExecution(operation)}}),
          repositories:{events,artifacts,session:{repository:sessions,descriptor}},
          toolBoundary:{authorizationPolicyId:'tests/state-publication',executionTargetId:'tests/state-publication'},
          toolPolicy:{allowedRisks:['read','write']}});
      }});
    completions.set(descriptor.id,new Promise((resolve,reject)=>agent.subscribe(event=>{
      if(event.type==='run.completed')resolve(event.result);
      else if(event.type==='run.failed')reject(event.error);
    })));
    completions.get(descriptor.id).catch(()=>undefined);
    agents.set(descriptor.id,agent);return agent;
  };
  host=await CollaborationCoordinator.open({groupId:'group',hostId:'host',supervisorSessionId:root.id,
    budgetOwnerId:'owner',repository:new InMemoryCollaborationRepository(),runs,
    readCorrectionRevision:()=>sessions.acceptedCorrectionRevision(root),
    async createSession({participant,assignment,binding:authority}){
      await inference.registerBudgetScope({ownerId:'owner',participantId:participant.participantId,
        scopeId:assignment.budgetScopeId,budget:{maxInvocations:8}});
      return create(await sessions.create({id:participant.sessionId,binding}),authority);
    }});
  await host.withCurrent(0,async()=>undefined);
  const rootAgent=create(root);
  t.after(async()=>{
    release.resolve();await rootAgent.close();await host.close();
    if(directory)await rm(directory,{recursive:true,force:true});
  });
  return {sessions,root,host,contexts,provider,entered,release,
    async run(){
      if(role==='root'){
        const submitted=await rootAgent.submit({task:'Retain the useful interpretation.'});
        return {sessionId:root.id,runId:submitted.runId,completion:submitted.completion};
      }
      const child=await host.start({operationId:'start-child',task:'Retain the useful interpretation.',expectedEpoch:0,
        capabilityRevision:'v1',capabilities:{toolNames:contexts.get(root.id).toolDefinitions().map(value=>value.name)},budgetScopeId:'child-scope'});
      return {sessionId:child.participant.sessionId,runId:child.assignment.runId,completion:completions.get(child.participant.sessionId)};
    },
    async correct(runId){
      const submitted=await rootAgent.submit({task:'Correction: do not retain the previous interpretation.'},
        role==='root'?{delivery:'steer',expectedRunId:runId}:{relationship:{kind:'correct'}});
      submitted.completion?.catch(()=>undefined);
      assert.notEqual(submitted.kind,'rejected');
    }};
}

for(const kind of ['memory','jsonl'])for(const role of ['root','child'])for(const tool of ['context_state_save','context_save_and_activate']){
  test(`${kind}: activated ${role} publishes ${tool} through the canonical ownership boundary`,async t=>{
    const f=await fixture(t,kind,role,tool),execution=await f.run();
    const result=await execution.completion;
    assert.equal(result.terminal?.executionStatus,'completed',JSON.stringify(result));
    const context=f.contexts.get(execution.sessionId),stored=await context.listSessionState();
    assert.equal(stored.items.length,1);
    assert.equal((await context.readSessionState({itemId:stored.items[0].itemId,revisionId:stored.items[0].revisionId})).text,text);
    assert.equal((await context.sessionState()).items.length,tool==='context_save_and_activate'?1:0);
    assert.equal(f.provider.requests.length,2);
  });
  test(`${kind}: correction fences pending ${role} ${tool} publication without retaining the session queue`,async t=>{
    const f=await fixture(t,kind,role,tool,true),execution=await f.run();
    await f.entered.promise;
    // This admission must finish while publication is waiting for its outer guard.
    // Holding the session queue before acquiring authority makes this a lock cycle.
    await f.correct(execution.runId);
    assert.equal((await f.host.authorizationState()).epoch,1);
    f.release.resolve();await execution.completion.catch(()=>undefined);
    assert.equal((await f.contexts.get(execution.sessionId).listSessionState()).items.length,0);
  });
}

for(const kind of ['memory','jsonl'])test(`${kind}: catalog and peer publication guards precede queue acquisition and preserve committed receipts`,async t=>{
  const directory=kind==='jsonl'?await mkdtemp(path.join(tmpdir(),'publication-writers-')):undefined;
  const sessions=directory?new JsonlSessionRepository(directory):new InMemorySessionRepository();
  t.after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
  const session=await sessions.create({id:'recipient',binding});
  const guard={withOwnership:async publish=>{await sessions.acceptedCorrectionRevision(session);return publish();}};
  const prior=await sessions.currentToolCatalogSelection(session);
  const catalog={ownerId:prior.ownerId,expectedRevision:prior.selection.revision,
    selection:captureToolCatalogSelection([]),operationId:'guarded-catalog'};
  const selected=await sessions.saveToolCatalogSelection(session,catalog,guard);
  const body={deliveryId:'guarded-peer',groupId:'group',sender:{participantId:'sender',sessionId:'sender'},
    recipient:{participantId:'recipient',sessionId:session.id},assignmentId:'assignment',assignmentRevision:1,
    senderRunId:'sender-run',correctionEpoch:0,content:'A model-authored finding.',shares:[]};
  const peer={...body,fingerprint:peerContributionFingerprint(body)};
  const imported=await sessions.appendPeerContribution(session,peer,guard);
  const stale={withOwnership:async()=>{assert.fail('An exact committed receipt does not reacquire live ownership.');}};
  assert.deepEqual(await sessions.saveToolCatalogSelection(session,catalog,stale),selected);
  assert.deepEqual(await sessions.appendPeerContribution(session,peer,stale),imported);
});
