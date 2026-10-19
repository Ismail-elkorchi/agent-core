import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime, AgentSession, AgentRunCoordinator, InferenceService,
  InMemoryInferenceRepository, InMemorySessionRepository, agentEventCodec,
  CollaborationCoordinator, EventCollaborationRepository, InMemoryCollaborationRepository,
  parseCollaborationPolicy, createParticipantArtifactRepository
} from '@agent-core/runtime';
import { JsonlCollaborationRepository } from '@agent-core/runtime/node';
import { collaborationProvider, deferred } from './fixtures/collaboration-provider.mjs';

const sessionBinding={schemaId:'tests/collaboration-lifecycle',schemaVersion:1,subject:{}};
const task=(operationId,extra={})=>({operationId,task:'Investigate the assigned issue.',expectedEpoch:0,capabilityRevision:'capability-v1',capabilities:{toolNames:[]},budgetScopeId:'scope-'+operationId,...extra});

function harness(options={}) {
  const fixture=collaborationProvider(options.steps ?? [{},{},{},{}]);
  const artifacts=new InMemoryArtifactRepository();
  const events=new InMemoryEventRepository(agentEventCodec);
  const runs=new AgentRunCoordinator(events,artifacts);
  const sessions=new InMemorySessionRepository();
  const inference=new InMemoryInferenceRepository();
  const inferenceService=new InferenceService({provider:fixture.provider,repository:inference,artifacts,budget:{maxInvocations:32}});
  const created=[];
  const bindings=[];
  const instances=new Map();
  const repository=options.repository ?? new InMemoryCollaborationRepository();
  const open=(extra={})=>CollaborationCoordinator.open({
    groupId:'group',hostId:'host',supervisorSessionId:'supervisor',budgetOwnerId:'owner',repository,runs,
    maxParticipants:4,maxConcurrentRuns:2,maxWaitMs:2000,
    async readSubmission({sessionId,runId}) {
      const descriptor=await sessions.open(sessionId,sessionBinding);
      const pending=(await sessions.pendingSubmissionSummaries(descriptor)).find(value=>value.runId===runId);
      return pending && sessions.readSubmission(descriptor,pending.submissionId);
    },
    async createSession({participant,assignment,binding,coordinator}) {
      assert.ok(coordinator);
      created.push({participant,assignment});bindings.push(binding);
      await inferenceService.registerBudgetScope({ownerId:'owner',participantId:participant.participantId,scopeId:assignment.budgetScopeId,budget:{maxInvocations:8}});
      let descriptor;
      try {descriptor=await sessions.open(participant.sessionId,sessionBinding);}
      catch {descriptor=await sessions.create({id:participant.sessionId,binding:sessionBinding});}
      const agent=new AgentSession({descriptor,expectedBinding:sessionBinding,repository:sessions,runs,
        configuration:{provider:fixture.profile.provider,model:fixture.profile.id},
        createRuntime(_configuration,onProgress) {
          return new AgentRuntime({provider:fixture.provider,model:fixture.profile.id,maxOutputTokens:64,
            repositories:{events,artifacts,session:{repository:sessions,descriptor}},
            toolBoundary:{authorizationPolicyId:'test',executionTargetId:'test'},
            inferenceService,participant:binding,onProgress});
        }
      });
      instances.set(participant.sessionId,agent);return agent;
    },...extra
  });
  return {open,fixture,artifacts,events,runs,sessions,inference,repository,created,bindings,instances};
}

async function settled(coordinator,participantId) {
  const result=await coordinator.wait({participantIds:[participantId],timeoutMs:2000});
  assert.equal(result.reason,'settled',JSON.stringify(result));
  return result.participants[0];
}

test('participants are distinct ordinary sessions; operation retries and continuation preserve identity and scope',async t=>{
  const h=harness();const host=await h.open();t.after(()=>host.close());
  const input=task('start');
  const first=await host.start(input);
  const finished=await settled(host,first.participant.participantId);
  assert.equal(finished.phase,'ended');
  assert.notEqual(first.participant.sessionId,'supervisor');
  assert.notEqual(first.participant.participantId,first.assignment.runId);
  assert.equal(h.fixture.requests.length,1);
  const repeated=await host.start(input);
  assert.equal(repeated.participant.participantId,first.participant.participantId);
  assert.equal(repeated.assignment.runId,first.assignment.runId);
  assert.equal(h.fixture.requests.length,1);
  await assert.rejects(host.start({...input,task:'Changed under the same operation.'}),/reused/);
  const next=await host.continue(task('continue',{participantId:first.participant.participantId,budgetScopeId:first.assignment.budgetScopeId}));
  await settled(host,first.participant.participantId);
  assert.equal(next.participant.sessionId,first.participant.sessionId);
  assert.notEqual(next.assignment.runId,first.assignment.runId);
  assert.equal(next.assignment.revision,2);
  assert.equal(h.created.length,2,'A fresh factory binding is used for the same session on each assignment.');
  await assert.rejects(host.continue(task('reset-budget',{participantId:first.participant.participantId})),/reset.*budget scope/);
  const state=await host.inspect();
  const results=state.participants[0].results;
  assert.equal(results.length,2);
  assert.equal(results.every(result=>result.kind==='final' && !('terminal' in result)),true);
  for(const result of results){
    const authoritative=await h.events.readReference(result.runEnded);
    assert.equal(authoritative.event.type,'run.ended');
    assert.equal(authoritative.event.terminal.finalizationId,result.finalizationId);
  }
  const scope=await h.inference.load('owner',{participantId:first.participant.participantId,budgetScopeId:first.assignment.budgetScopeId});
  assert.equal(scope.settledUsage.invocations,2);
});

test('host ownership stays fenced across live work and idle gaps and is reusable after clean close',async t=>{
  const gate=deferred();const h=harness({steps:[()=>gate.promise]});
  const host=await h.open();t.after(async()=>{gate.resolve({});await host.close();});
  const passive=await h.open({hostId:'passive'});t.after(()=>passive.close());
  assert.equal((await passive.inspect()).hostGeneration,0);
  const first=await host.start(task('active'));
  await assert.rejects(passive.start(task('competing')),/live host/);
  await assert.rejects(h.open({hostId:'competitor'}),/live host/);
  gate.resolve({});await settled(host,first.participant.participantId);
  await assert.rejects(h.open({hostId:'competitor'}),/live host/,'A completed child does not release group ownership.');
  await host.close();
  const next=await h.open({hostId:'replacement'});t.after(()=>next.close());
  const recovered=await next.inspect();
  assert.equal(recovered.hostGeneration,2);
  assert.equal(recovered.participants[0].participant.sessionId,first.participant.sessionId);
  assert.equal(h.fixture.requests.length,1);
});

test('admission and wait bounds are explicit; cancellation requires an explicit cascade and exact target',async t=>{
  const gate=deferred();const h=harness({steps:[()=>gate.promise,{}]});
  const host=await h.open({maxParticipants:2,maxConcurrentRuns:1});
  t.after(async()=>{gate.resolve({});await host.close();});
  const first=await host.start(task('first'));
  await assert.rejects(host.start(task('second')),/concurrency bound/);
  await assert.rejects(host.wait({participantIds:[first.participant.participantId],timeoutMs:2001}),/bounded participant wait/);
  const wait=await host.wait({participantIds:[first.participant.participantId],timeoutMs:0});assert.equal(wait.reason,'timeout');
  const signal=new AbortController();signal.abort();
  const aborted=await host.wait({participantIds:[first.participant.participantId],signal:signal.signal});assert.equal(aborted.reason,'aborted');
  await assert.rejects(host.cancel({operationId:'cancel',participantId:first.participant.participantId,expectedEpoch:0,reason:'Stop'}),/explicit cascade/);
  await assert.rejects(host.cancel({operationId:'cancel',participantId:first.participant.participantId,expectedEpoch:0,reason:'Stop',cascade:false,expectedRunId:'wrong'}),/target is stale/);
  gate.resolve({});await settled(host,first.participant.participantId);
  const second=await host.start(task('second'));await settled(host,second.participant.participantId);
  await assert.rejects(host.start(task('third')),/count bound/);
});

test('correction serializes against an admitted boundary and blocks stale new work and acceptance',async t=>{
  const h=harness();const host=await h.open();t.after(()=>host.close());
  const first=await host.start(task('first'));await settled(host,first.participant.participantId);
  const inside=deferred(),release=deferred();
  const publication=host.withCurrent(0,async()=>{inside.resolve();await release.promise;return 'published';});
  await inside.promise;
  let correctionDone=false;
  const correction=host.correct({operationId:'correct',expectedEpoch:0,reason:'The requirements changed.'}).then(state=>{correctionDone=true;return state;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(correctionDone,false);
  release.resolve();assert.equal(await publication,'published');assert.equal((await correction).epoch,1);
  await assert.rejects(h.bindings[0].assertCurrent(),/epoch is stale/);
  await assert.rejects(host.start(task('stale')),/epoch is stale/);
  const result=(await host.inspect()).participants[0].results[0];
  await assert.rejects(host.acceptResult({operationId:'accept-old',resultId:result.resultId,expectedEpoch:1}),/acceptance is stale/);
  const second=await host.start(task('current',{expectedEpoch:1}));await settled(host,second.participant.participantId);
  const current=(await host.inspectParticipant(second.participant.participantId)).results[0];
  await host.acceptResult({operationId:'accept',resultId:current.resultId,expectedEpoch:1});
  await host.acceptResult({operationId:'accept',resultId:current.resultId,expectedEpoch:1});
  assert.equal((await host.inspect()).acceptances.length,1);
});

test('a crash after assignment commit recovers the same participant session and run without duplicate admission',async t=>{
  const backing=new InMemoryCollaborationRepository();let fail=true;
  const repository={
    readPublicArtifact:(...args)=>backing.readPublicArtifact(...args),findAssignment:(...args)=>backing.findAssignment(...args),readResult:(id,resultId)=>backing.readResult(id,resultId),acquireHost:input=>backing.acquireHost(input),load:id=>backing.load(id),operation:(id,key)=>backing.operation(id,key),
    async append(owner,event,tail,key){await backing.append(owner,event,tail,key);if(fail && event.type==='collaboration.assigned'){fail=false;throw new Error('Simulated crash after durable assignment.');}}
  };
  const h=harness({repository});const first=await h.open();
  await assert.rejects(first.start(task('assigned')),/Simulated crash/);
  const recorded=(await backing.load('group')).participants[0];assert.equal(h.created.length,0);
  await first.close();
  const replacement=await h.open({hostId:'recovery'});t.after(()=>replacement.close());
  const result=await settled(replacement,recorded.participant.participantId);
  assert.equal(result.participant.sessionId,recorded.participant.sessionId);
  assert.equal(result.assignment.runId,recorded.assignment.runId);
  assert.equal(h.fixture.requests.length,1);
  assert.equal((await backing.load('group')).participants.length,1);
});

test('assignment admission owns its model configuration before dispatch and never recaptures a retry',async t=>{
  const backing=new InMemoryCollaborationRepository();let failAssignment=true,captures=0;
  const repository={
    readPublicArtifact:(...args)=>backing.readPublicArtifact(...args),findAssignment:(...args)=>backing.findAssignment(...args),readResult:(...args)=>backing.readResult(...args),
    acquireHost:input=>backing.acquireHost(input),load:id=>backing.load(id),operation:(...args)=>backing.operation(...args),
    async append(owner,event,tail,key){
      await backing.append(owner,event,tail,key);
      if(failAssignment && event.type==='collaboration.assigned')throw new Error('Injected failure before session creation.');
    }
  };
  const h=harness({repository});
  const configuration={provider:h.fixture.profile.provider,model:h.fixture.profile.id};
  const original={...configuration};
  const host=await h.open({captureConfiguration(){captures++;return configuration;}});t.after(()=>host.close());
  const input=task('captured-model');
  await assert.rejects(host.start(input),/before session creation/);
  assert.equal(h.created.length,0);assert.equal(captures,1);
  configuration.endpoint='https://replacement.invalid';
  const recorded=(await backing.load('group')).participants[0];
  assert.deepEqual(recorded.assignment.configuration,original);
  failAssignment=false;
  const retry=await host.start(input);await settled(host,retry.participant.participantId);
  assert.deepEqual(retry.assignment.configuration,original);assert.equal(captures,1);
  failAssignment=true;
  await assert.rejects(host.continue(task('capture-next',{participantId:retry.participant.participantId,budgetScopeId:retry.assignment.budgetScopeId})),/before session creation/);
  assert.equal(captures,2);
  assert.deepEqual((await backing.load('group')).participants[0].assignment.configuration,configuration);
});

test('a participant factory cannot dispatch a session with a different captured model configuration',async t=>{
  const h=harness();
  const host=await h.open({captureConfiguration:()=>({provider:h.fixture.profile.provider,model:h.fixture.profile.id,endpoint:'https://captured.invalid'})});
  t.after(()=>host.close());
  await assert.rejects(host.start(task('wrong-model-binding')),/configuration differs from its admitted assignment/);
  assert.equal(h.fixture.requests.length,0);
  assert.equal((await host.inspect()).participants.length,1,'The original captured admission remains recoverable.');
});

test('crash after authoritative run finalization republishes only its missing result reference',async t=>{
  const backing=new InMemoryCollaborationRepository();let owner;let failResult=true;
  const repository={
    async acquireHost(input){owner=await backing.acquireHost(input);return owner;},
    readPublicArtifact:(...args)=>backing.readPublicArtifact(...args),findAssignment:(...args)=>backing.findAssignment(...args),readResult:(id,resultId)=>backing.readResult(id,resultId),load:id=>backing.load(id),operation:(id,key)=>backing.operation(id,key),
    async append(host,event,tail,key){if(failResult && event.type==='collaboration.result_recorded')throw new Error('Simulated result publication crash.');await backing.append(host,event,tail,key);}
  };
  const h=harness({repository});const first=await h.open();
  let assigned;
  try{assigned=await first.start(task('finalized'));}catch(error){assert.match(error.message,/publication crash/);}
  assigned ??=(await backing.load('group')).participants[0];
  const deadline=Date.now()+2000;
  while((await h.runs.find(assigned.assignment.runId))?.state.phase.kind!=='terminal'){
    assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal((await backing.load('group')).participants[0].results.length,0);
  // No work remains in the old process. Dropping its lifetime owner models process death.
  await owner.release();failResult=false;
  const replacement=await h.open({hostId:'recovered'});t.after(()=>replacement.close());
  const result=await settled(replacement,assigned.participant.participantId);
  assert.equal(result.results.length,1);assert.equal(h.fixture.requests.length,1);
  assert.equal(result.assignment.runId,assigned.assignment.runId);
});

test('bounded participant summaries retain truncation and authoritative result references',async t=>{
  const h=harness();const host=await h.open();t.after(()=>host.close());
  const first=await host.start(task('long',{task:'A'.repeat(20000)}));await settled(host,first.participant.participantId);
  const page=await host.inspectParticipants({limit:1});assert.equal(page.participants.length,1);
  assert.equal(page.participants[0].taskTruncated,true);assert.equal(page.participants[0].assignment.task.length,8192);
  assert.equal('capabilities' in page.participants[0].assignment,false);
  assert.equal('controls' in page,false);assert.equal('acceptances' in page,false);
  assert.equal(page.maxWaitMs,2000);
  await assert.rejects(host.inspectParticipants({limit:257}),/Invalid participant page/);
});

test('policy bounds reject unknown configuration and own immutable allowance values',()=>{
  const input={participantBudget:{maxInvocations:3}};const parsed=parseCollaborationPolicy(input);
  input.participantBudget.maxInvocations=100;assert.equal(parsed.participantBudget.maxInvocations,3);
  assert.equal(parsed.maxParticipants,4);assert.equal(parsed.maxConcurrentRuns,2);
  assert.throws(()=>parseCollaborationPolicy({maxParticipants:1,maxConcurrentRuns:2}),/Invalid collaboration/);
  assert.throws(()=>parseCollaborationPolicy({maxWaitMs:300001}),/Invalid collaboration/);
  assert.throws(()=>parseCollaborationPolicy({unexpected:true}),/Unknown/);
});

test('JSONL group host excludes a live process and reclaims ownership only after that process dies',async t=>{
  const rootDir=await mkdtemp(path.join(tmpdir(),'collaboration-host-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
  const config={groupId:'group',hostId:'child',supervisorSessionId:'supervisor',budgetOwnerId:'owner',maxParticipants:4,maxConcurrentRuns:2};
  const script=`import {JsonlCollaborationRepository} from '@agent-core/runtime/node';const r=new JsonlCollaborationRepository({rootDir:${JSON.stringify(rootDir)}});await r.acquireHost(${JSON.stringify(config)});process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));
  await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('ready'))resolve();});child.once('error',reject);child.once('exit',code=>reject(new Error(`Child exited early: ${code}`)));});
  const repository=new JsonlCollaborationRepository({rootDir});
  await assert.rejects(repository.acquireHost({...config,hostId:'competitor'}),/live host/);
  child.kill('SIGKILL');await once(child,'exit');
  const owner=await repository.acquireHost({...config,hostId:'recovery'});t.after(()=>owner.release());
  assert.equal(owner.generation,2);await owner.assertOwned();
  await owner.release();await assert.rejects(owner.assertOwned(),/released/);
});


test('unchanged host guards reuse their verified projection and append reads only new events',async()=>{
  const repository=new InMemoryCollaborationRepository();
  let records=0,calls=0;const readRange=repository.events.readRange.bind(repository.events);
  repository.events.readRange=async(...args)=>{calls++;const page=await readRange(...args);records+=page.records.length;return page;};
  const owner=await repository.acquireHost({groupId:'cached',hostId:'host',supervisorSessionId:'supervisor',budgetOwnerId:'owner',maxParticipants:4,maxConcurrentRuns:2});
  await repository.load('cached');records=0;calls=0;
  for(let i=0;i<100;i++){await owner.assertOwned();await repository.load('cached');}
  assert.equal(records,0);assert.equal(calls,0);
  const state=await repository.load('cached');
  await repository.append(owner,{type:'collaboration.corrected',operationId:'correct',requestFingerprint:'fingerprint',epoch:1,correctionRevision:0,reason:'Changed'},state.tail,'operation:correct');
  assert.equal((await repository.load('cached')).epoch,1);assert.equal(records,1);
  const second=new EventCollaborationRepository(repository.events);
  await assert.rejects(second.acquireHost({groupId:'cached',hostId:'other',supervisorSessionId:'supervisor',budgetOwnerId:'owner',maxParticipants:4,maxConcurrentRuns:2}),/live host/);
  await owner.release();
});

test('bounded authority and waits reject overload while reserved cancellation room remains available',async t=>{
  const h=harness();const host=await h.open({maxPendingOperations:2});t.after(()=>host.close());
  await host.withCurrent(0,async()=>undefined);
  const gate=deferred(),entered=deferred();
  const first=host.withCurrent(0,async()=>{entered.resolve();await gate.promise;});await entered.promise;
  const second=host.withCurrent(0,async()=>undefined);
  await assert.rejects(host.withCurrent(0,async()=>undefined),/admission bound/);
  const correction=host.correct({operationId:'reserved-correction',expectedEpoch:0,reason:'Priority correction'});
  gate.resolve();await Promise.all([first,second,correction]);
  assert.equal((await host.inspect()).epoch,1);
});

test('participant final text is an exact bounded model-authored read independent of acceptance',async t=>{
  const h=harness({steps:[{content:'first αβγ last'.repeat(1000)}]});const host=await h.open();t.after(()=>host.close());
  const first=await host.start(task('result'));await settled(host,first.participant.participantId);
  const final=(await host.inspectParticipant(first.participant.participantId)).results[0];
  const page=await host.readResult({resultId:final.resultId,maxBytes:2048});
  assert.ok(page.text.startsWith('first αβγ last'));assert.ok(page.nextOffset>0);assert.equal(page.coverage,'partial');assert.ok(Buffer.byteLength(JSON.stringify(page))<=2048);
  assert.equal(page.classification,'model_authored');assert.equal(page.completeness,'complete');assert.equal(page.executionStatus,'completed');
  assert.equal((await host.inspect()).acceptances.length,0);
  const rest=await host.readResult({resultId:final.resultId,offset:page.nextOffset,maxBytes:32768});
  assert.equal(page.text+rest.text,'first αβγ last'.repeat(1000));assert.equal(rest.nextOffset,null);
  assert.equal('reasoning' in rest,false);
  await assert.rejects(host.readResult({resultId:final.resultId,maxBytes:32769}),/byte range/);
  await assert.rejects(host.publishPartial({participantId:first.participant.participantId,resultId:'forged',expectedEpoch:0,source:{...final.runEnded,runId:'other'}}),/another run/);
  await assert.rejects(host.publishPartial({participantId:first.participant.participantId,resultId:'forged-type',expectedEpoch:0,source:final.runEnded}),/original assistant/);
});

test('wait graph rejects self-waits and cycles and releases edges on abort',async t=>{
  const leftGate=deferred(),rightGate=deferred();
  const h=harness({steps:[()=>leftGate.promise,()=>rightGate.promise]});const host=await h.open();
  t.after(async()=>{leftGate.resolve({});rightGate.resolve({});await host.close();});
  const left=await host.start(task('left')),right=await host.start(task('right'));
  const leftId=left.participant.participantId,rightId=right.participant.participantId;
  await assert.rejects(host.wait({participantIds:[leftId],requesterParticipantId:leftId}),/self-wait|cycle/);
  const controller=new AbortController();
  const pending=host.wait({participantIds:[rightId],requesterParticipantId:leftId,signal:controller.signal});
  await assert.rejects(host.wait({participantIds:[leftId],requesterParticipantId:rightId}),/cycle/);
  controller.abort();assert.equal((await pending).reason,'aborted');
  assert.equal((await host.wait({participantIds:[leftId],requesterParticipantId:rightId,timeoutMs:0})).reason,'timeout');
});

test('cancel without cascade preserves peer work and nested creation records its actual causal session',async t=>{
  const leftGate=deferred(),rightGate=deferred();
  const h=harness({steps:[()=>leftGate.promise,()=>rightGate.promise]});const host=await h.open();
  t.after(async()=>{leftGate.resolve({});rightGate.resolve({});await host.close();});
  const parent=await host.start(task('parent'));
  const child=await host.start(task('child',{parentParticipantId:parent.participant.participantId}));
  assert.equal(child.participant.createdBySessionId,parent.participant.sessionId);
  const cancelling=host.cancel({operationId:'cancel-parent',participantId:parent.participant.participantId,expectedEpoch:0,reason:'Stop only this participant.',cascade:false});
  leftGate.resolve({});await cancelling;
  let state=await host.inspect();
  assert.equal(state.participants.find(p=>p.participant.participantId===parent.participant.participantId).cancelled,true);
  assert.equal(state.participants.find(p=>p.participant.participantId===child.participant.participantId).cancelled,false);
  assert.equal(state.controls.length,0,'Completed control requests do not accumulate in live state.');
  leftGate.resolve({});rightGate.resolve({});await settled(host,parent.participant.participantId);await settled(host,child.participant.participantId);
  await host.cancel({operationId:'cascade',participantId:parent.participant.participantId,expectedEpoch:0,reason:'Stop the explicit subtree.',cascade:true});
  state=await host.inspect();assert.equal(state.participants.every(p=>p.cancelled),true);
});

test('capability policy changes reject continuation before durable assignment admission',async t=>{
  let allowed=true;
  const h=harness();const host=await h.open({validateCapabilities(){if(!allowed)throw new Error('Current application mode forbids this grant.');}});t.after(()=>host.close());
  const first=await host.start(task('first'));await settled(host,first.participant.participantId);
  allowed=false;
  await assert.rejects(host.continue(task('forbidden',{participantId:first.participant.participantId,budgetScopeId:first.assignment.budgetScopeId})),/application mode/);
  const after=await host.inspectParticipant(first.participant.participantId);
  assert.equal(after.assignment.assignmentId,first.assignment.assignmentId);assert.equal(after.assignment.revision,1);
  await assert.rejects(host.start(task('forbidden-new')),/application mode/);
  assert.equal((await host.inspect()).participants.length,1);
});

test('derived recent results and pending controls stay bounded while exact original assignments remain indexed',async()=>{
  const repository=new InMemoryCollaborationRepository();
  const owner=await repository.acquireHost({groupId:'bounded',hostId:'host',supervisorSessionId:'supervisor',budgetOwnerId:'owner',maxParticipants:2,maxConcurrentRuns:1});
  const participant={groupId:'bounded',participantId:'participant',sessionId:'session',createdBySessionId:'supervisor'};
  const append=async(event,key)=>repository.append(owner,event,(await repository.load('bounded')).tail,key);
  for(let revision=1;revision<=40;revision++){
    const assignment={origin:'delegated',delegatedBy:{sessionId:'supervisor'},assignmentId:`assignment-${revision}`,participantId:'participant',revision,runId:`run-${revision}`,task:'Fixture assignment.',epoch:0,capabilityRevision:'v1',capabilities:{toolNames:[]},budgetOwnerId:'owner',budgetScopeId:'scope',sourceRefs:[],initialSources:[]};
    await append({type:'collaboration.assigned',operationId:`assignment-${revision}`,requestFingerprint:`request-${revision}`,participant,assignment},`operation:assignment-${revision}`);
    await append({type:'collaboration.result_recorded',result:{resultId:`result-${revision}`,participantId:'participant',assignmentId:assignment.assignmentId,assignmentRevision:revision,runId:assignment.runId,epoch:0,kind:'final',finalizationId:`final-${revision}`,runEnded:{runId:assignment.runId,eventId:`ended-${revision}`,sequence:1,hash:`hash-${revision}`}}},`result:result-${revision}`);
    await append({type:'collaboration.control_requested',operationId:`control-${revision}`,requestFingerprint:`control-request-${revision}`,mode:'interrupt',targets:[{participantId:'participant',assignmentId:assignment.assignmentId,assignmentRevision:revision,runId:assignment.runId}],reason:'Fixture control.',epoch:0},`operation:control-${revision}`);
    await append({type:'collaboration.control_applied',operationId:`control-${revision}`},`control-applied:control-${revision}`);
  }
  const state=await repository.load('bounded');assert.equal(state.participants[0].results.length,32);assert.equal(state.participants[0].resultCount,40);assert.equal(state.controls.length,0);
  assert.equal((await repository.readResult('bounded','result-1')).assignmentId,'assignment-1');
  assert.equal((await repository.findAssignment('bounded','participant','assignment-1',1,'run-1')).assignment.task,'Fixture assignment.');
  assert.equal(await repository.findAssignment('bounded','participant','assignment-1',2,'run-1'),undefined);
  await owner.release();
});

for(const kind of ['memory','jsonl'])test(`${kind}: historical assignment authority survives changed continuation, correction, cancellation, and restart`,async t=>{
  const rootDir=kind==='jsonl'?await mkdtemp(path.join(tmpdir(),'historical-assignment-')):undefined;
  const repository=rootDir?new JsonlCollaborationRepository({rootDir}):new InMemoryCollaborationRepository();
  const h=harness({repository});const first=await h.open();let recovered;
  t.after(async()=>{await first.close();await recovered?.close();if(rootDir)await rm(rootDir,{recursive:true,force:true});});
  const original=await first.start(task('original',{assignmentId:'same-label',capabilities:{toolNames:[],collaboration:{actions:['inspect'],participantIds:[]}}}));
  await settled(first,original.participant.participantId);
  await first.correct({operationId:'correction',expectedEpoch:0,reason:'New assignment requirements.'});
  const next=await first.continue(task('next',{assignmentId:'same-label',participantId:original.participant.participantId,budgetScopeId:original.assignment.budgetScopeId,expectedEpoch:1,capabilityRevision:'v2'}));
  await settled(first,next.participant.participantId);
  await first.cancel({operationId:'cancel',participantId:next.participant.participantId,expectedEpoch:1,reason:'The participant is finished.',cascade:false});
  const lookup=coordinator=>coordinator.findAssignment(original.participant.participantId,original.assignment.assignmentId,original.assignment.revision,original.assignment.runId);
  assert.deepEqual((await lookup(first)).assignment,original.assignment);
  await assert.rejects(h.bindings[0].assertCurrent(),/stale|no longer current/);
  await first.close();
  const reopenedRepository=rootDir?new JsonlCollaborationRepository({rootDir}):new EventCollaborationRepository(repository.events);
  recovered=await h.open({hostId:'replacement',repository:reopenedRepository});
  assert.deepEqual((await lookup(recovered)).assignment,original.assignment);
  assert.equal((await recovered.inspectParticipant(next.participant.participantId)).cancelled,true);
  assert.equal(h.fixture.requests.length,2);
});

test('permanent cancellation retries failed participant-resource cleanup before acknowledging control',async t=>{
  const h=harness();let cleanupCalls=0,failCleanup=true;
  const host=await h.open({async closeParticipant(){cleanupCalls++;if(failCleanup)throw new Error('Resource cleanup is unresolved.');}});
  t.after(async()=>{failCleanup=false;await host.close();});
  const participant=await host.start(task('first'));await settled(host,participant.participant.participantId);
  const control={operationId:'cancel-resources',participantId:participant.participant.participantId,expectedEpoch:0,reason:'Retire participant resources.',cascade:false};
  await assert.rejects(host.cancel(control),/cleanup is unresolved/);
  assert.equal((await host.inspect()).controls.length,1);assert.equal(cleanupCalls,1);
  await assert.rejects(host.cancel({...control,operationId:'another-cancel'}),/pending control/);
  assert.equal(cleanupCalls,1,'A new operation cannot accumulate another unresolved cancellation.');
  failCleanup=false;await host.cancel(control);
  assert.equal((await host.inspect()).controls.length,0);assert.equal(cleanupCalls,2);
});

test('interrupting a committed assignment before dispatch withdraws it without inventing a terminal result',async t=>{
  const h=harness();
  const failed=await h.open({createSession(){throw new Error('Factory is unavailable.');}});
  await assert.rejects(failed.start(task('unstarted')),/Factory is unavailable/);
  const assigned=(await failed.inspect()).participants[0];
  await failed.interrupt({operationId:'interrupt-before-admission',participantId:assigned.participant.participantId,expectedEpoch:0,reason:'Withdraw the unstarted assignment.'});
  const withdrawn=await failed.inspectParticipant(assigned.participant.participantId);
  assert.equal(withdrawn.phase,'cancelled');assert.equal(withdrawn.cancelled,false);assert.equal(withdrawn.results.length,0);
  assert.equal(await h.runs.find(assigned.assignment.runId),undefined);
  await failed.close();
  const recovered=await h.open({hostId:'replacement'});t.after(()=>recovered.close());
  assert.equal(h.fixture.requests.length,0,'Recovery cannot dispatch a withdrawn assignment.');
  const next=await recovered.continue(task('new-assignment',{participantId:assigned.participant.participantId,budgetScopeId:assigned.assignment.budgetScopeId}));
  await settled(recovered,next.participant.participantId);
  assert.equal(next.assignment.revision,2);assert.equal(h.fixture.requests.length,1);
});

for(const inspection of ['durable','local'])test(`${inspection}: uncertain provider abort inspects and waits as suspended before and after reopen`,async t=>{
  const entered=deferred(),release=deferred();
  const h=harness({steps:[async()=>{entered.resolve();await release.promise;return {};} ]});
  const inspectionOptions=inspection==='local'?{readSubmission:undefined}:{};
  let host=await h.open(inspectionOptions);
  t.after(async()=>{release.resolve();await host.close();});
  const original=await host.start(task('uncertain-abort'));await entered.promise;
  let unsubscribe=()=>undefined;
  const suspended=new Promise(resolve=>{
    unsubscribe=h.instances.get(original.participant.sessionId).subscribe(event=>{
      if(event.type==='run.completed' && event.result.state==='suspended')resolve(event.result);
    });
  });t.after(()=>unsubscribe());
  const control={operationId:'interrupt-provider',participantId:original.participant.participantId,
    expectedRunId:original.assignment.runId,expectedEpoch:0,reason:'Stop the in-flight request.'};
  await host.interrupt(control);release.resolve();
  assert.equal((await suspended).reason,'provider_outcome_unknown');
  const assertSuspended=async()=>{
    const factories=h.created.length;
    const run=await h.runs.inspect(original.assignment.runId);
    assert.equal(run.state.phase.kind,'active');assert.equal(run.state.control.status,'abort_requested');
    assert.equal(run.instruction.procedure,'finalize_abort');
    assert.equal((await host.inspect()).participants[0].phase,'suspended');
    assert.equal((await host.inspectParticipant(original.participant.participantId)).phase,'suspended');
    assert.equal((await host.inspectParticipants()).participants[0].phase,'suspended');
    const waited=await host.wait({participantIds:[original.participant.participantId],timeoutMs:0});
    assert.equal(waited.reason,'settled');assert.equal(waited.participants[0].phase,'suspended');
    const descriptor=await h.sessions.open(original.participant.sessionId,sessionBinding);
    const pending=(await h.sessions.pendingSubmissionSummaries(descriptor)).find(value=>value.runId===original.assignment.runId);
    assert.equal((await h.sessions.readSubmission(descriptor,pending.submissionId)).suspension.reason,'provider_outcome_unknown');
    assert.equal(h.created.length,factories,'Inspection cannot create participant sessions.');
    assert.equal(h.fixture.requests.length,1,'Inspection cannot retry an uncertain provider request.');
  };
  await assertSuspended();
  await host.close();host=await h.open({hostId:'recovered',...inspectionOptions});
  await assertSuspended();
  await host.interrupt({...control,operationId:'explicit-abort-recovery'});
  assert.equal((await settled(host,original.participant.participantId)).phase,'ended');
  assert.equal(h.fixture.requests.length,1);
});

for(const method of ['inspect','inspectParticipants','inspectParticipant'])test(`${method} releases authority before reading canonical submission state`,async t=>{
  const provider=deferred(),reading=deferred(),release=deferred();
  const h=harness({steps:[()=>provider.promise]});let block=false;
  const host=await h.open({async readSubmission({sessionId,runId}){
    if(block){reading.resolve();await release.promise;}
    const descriptor=await h.sessions.open(sessionId,sessionBinding);
    const pending=(await h.sessions.pendingSubmissionSummaries(descriptor)).find(value=>value.runId===runId);
    return pending && h.sessions.readSubmission(descriptor,pending.submissionId);
  }});
  t.after(async()=>{release.resolve();provider.resolve({});await host.close();});
  const original=await host.start(task('inspection-lock-order'));
  block=true;
  const inspection=method==='inspectParticipant'?host.inspectParticipant(original.participant.participantId):host[method]();
  await reading.promise;
  let admitted=false;
  // A canonical session repository writer can hold its queue while waiting for this
  // publication boundary. The inspector must not retain authority while waiting on it.
  const publication=host.withCurrent(0,async()=>{admitted=true;release.resolve();});
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(admitted,true,'Submission inspection must not block the publication authority boundary.');
  }finally{release.resolve();await Promise.all([publication,inspection]);}
});

for(const recovery of ['retry','reopen'])test(`pending interrupt ${recovery} cannot withdraw or abort a continued assignment`,async t=>{
  const backing=new InMemoryCollaborationRepository();
  let failReceipt=true,failContinuation=true;
  const repository={
    readPublicArtifact:(...args)=>backing.readPublicArtifact(...args),findAssignment:(...args)=>backing.findAssignment(...args),readResult:(...args)=>backing.readResult(...args),
    acquireHost:input=>backing.acquireHost(input),load:id=>backing.load(id),operation:(...args)=>backing.operation(...args),
    async append(owner,event,tail,key){
      if(failReceipt && event.type==='collaboration.control_applied')throw new Error('Injected control receipt failure.');
      await backing.append(owner,event,tail,key);
      if(failContinuation && event.type==='collaboration.assigned' && event.assignment.revision===2){
        failContinuation=false;throw new Error('Injected continuation dispatch failure.');
      }
    }
  };
  const entered=deferred(),release=deferred();
  const h=harness({repository,steps:[async()=>{entered.resolve();await release.promise;return {};},{}]});
  let host=await h.open();t.after(async()=>{release.resolve();failReceipt=false;await host.close();});
  const original=await host.start(task('original'));await entered.promise;
  let unsubscribe=()=>undefined;
  const suspended=new Promise(resolve=>{
    unsubscribe=h.instances.get(original.participant.sessionId).subscribe(event=>{
      if(event.type==='run.completed' && event.result.state==='suspended')resolve(event.result);
    });
  });t.after(()=>unsubscribe());
  const control={operationId:'interrupt-original',participantId:original.participant.participantId,
    expectedRunId:original.assignment.runId,expectedEpoch:0,reason:'Interrupt the original execution.'};
  await assert.rejects(host.interrupt(control),/control receipt failure/);
  release.resolve();
  assert.equal((await suspended).reason,'provider_outcome_unknown');
  assert.equal((await host.inspectParticipant(original.participant.participantId)).phase,'suspended');
  assert.equal((await host.wait({participantIds:[original.participant.participantId],timeoutMs:0})).reason,'settled');
  // An in-flight provider abort preserves uncertain exposure. Explicitly finish that
  // suspended abort through the ordinary session recovery path; its receipt still fails.
  await assert.rejects(host.interrupt(control),/control receipt failure/);
  await settled(host,original.participant.participantId);
  const nextInput=task('continued',{participantId:original.participant.participantId,budgetScopeId:original.assignment.budgetScopeId});
  await assert.rejects(host.continue(nextInput),/continuation dispatch failure/);
  const pending=await backing.load('group');
  const replacement=pending.participants[0].assignment;
  assert.equal(replacement.revision,2);assert.notEqual(replacement.runId,original.assignment.runId);
  assert.deepEqual(pending.controls[0].targets,[{participantId:original.participant.participantId,
    assignmentId:original.assignment.assignmentId,assignmentRevision:original.assignment.revision,runId:original.assignment.runId}]);
  await assert.rejects(host.interrupt({...control,operationId:'another-interrupt',expectedRunId:replacement.runId}),/pending control/);
  failReceipt=false;
  if(recovery==='reopen'){
    await host.close();host=await h.open({hostId:'recovered'});
  }else{
    await host.interrupt(control);
    await host.continue(nextInput);
  }
  const finished=await settled(host,original.participant.participantId);
  assert.equal(finished.assignment.runId,replacement.runId);
  assert.equal(finished.phase,'ended');assert.equal(finished.cancelled,false);
  const run=await h.runs.inspect(replacement.runId);
  assert.equal((await h.runs.readTerminal(run)).executionStatus,'completed');
  assert.equal(h.fixture.requests.length,2,'Only the two assigned runs should reach the provider.');
  assert.equal((await host.inspect()).controls.length,0);
});

test('assignment capture rejects oversized complete records before recording membership',async t=>{
  const h=harness();const host=await h.open();t.after(()=>host.close());
  await assert.rejects(host.start(task('oversized',{task:'α'.repeat(700000)})),/capture bound/);
  assert.equal((await host.inspect()).participants.length,0);assert.equal(h.created.length,0);
});

test('recovery keeps a stale unstarted assignment inspectable without dispatching across a correction',async t=>{
  const h=harness();const first=await h.open({createSession(){throw new Error('Factory is unavailable.');}});
  await assert.rejects(first.start(task('old-epoch')),/Factory is unavailable/);
  const original=(await first.inspect()).participants[0];
  await first.correct({operationId:'correct-before-restart',expectedEpoch:0,reason:'The original task is obsolete.'});
  await first.close();
  const recovered=await h.open({hostId:'replacement'});t.after(()=>recovered.close());
  assert.equal(h.created.length,0);assert.equal(h.fixture.requests.length,0);
  assert.equal((await recovered.inspectParticipant(original.participant.participantId)).phase,'suspended');
  await recovered.interrupt({operationId:'withdraw-stale',participantId:original.participant.participantId,expectedEpoch:1,reason:'Withdraw obsolete work.'});
  const next=await recovered.continue(task('current-epoch',{expectedEpoch:1,participantId:original.participant.participantId,budgetScopeId:original.assignment.budgetScopeId}));
  await settled(recovered,next.participant.participantId);assert.equal(h.fixture.requests.length,1);
});

test('replaying an old admission returns its original assignment instead of dispatching a newer one',async t=>{
  const h=harness();const host=await h.open();t.after(()=>host.close());
  const originalInput=task('original-receipt');
  const original=await host.start(originalInput);await settled(host,original.participant.participantId);
  const secondInput=task('second-receipt',{participantId:original.participant.participantId,budgetScopeId:original.assignment.budgetScopeId});
  const second=await host.continue(secondInput);await settled(host,second.participant.participantId);
  await host.continue(task('third-receipt',{participantId:original.participant.participantId,budgetScopeId:original.assignment.budgetScopeId}));await settled(host,original.participant.participantId);
  const originalReceipt=await host.start(originalInput),secondReceipt=await host.continue(secondInput);
  assert.deepEqual(originalReceipt.assignment,original.assignment);assert.deepEqual(secondReceipt.assignment,second.assignment);
  assert.deepEqual((await host.assignmentReceipt(originalInput.operationId)).assignment,original.assignment);
  assert.deepEqual((await host.assignmentReceipt(secondInput.operationId)).assignment,second.assignment);
  assert.equal(await host.assignmentReceipt('missing'),undefined);
  assert.equal(originalReceipt.phase,'ended');assert.equal(secondReceipt.phase,'ended');assert.equal(h.fixture.requests.length,3);
});

for(const kind of ['memory','jsonl'])test(`${kind}: participant artifact ownership is exact, durable, and independent of current assignment authority`,async t=>{
  const rootDir=kind==='jsonl'?await mkdtemp(path.join(tmpdir(),'participant-artifacts-')):undefined;
  const repository=rootDir?new JsonlCollaborationRepository({rootDir}):new InMemoryCollaborationRepository();
  const h=harness({repository});const host=await h.open();let reopened;
  t.after(async()=>{await host.close();await reopened?.close();if(rootDir)await rm(rootDir,{recursive:true,force:true});});
  const left=await host.start(task('left-artifacts'));await settled(host,left.participant.participantId);
  const right=await host.start(task('right-artifacts'));await settled(host,right.participant.participantId);
  const scoped=createParticipantArtifactRepository({artifacts:h.artifacts,participantId:left.participant.participantId,coordinator:()=>host});
  const unrelated=await h.artifacts.store({label:'Root-private public store',content:Buffer.from('Unrelated bytes.'),mediaType:'text/plain'});
  await host.correct({operationId:'changed-before-settlement',expectedEpoch:0,reason:'Changed requirements.'});
  await host.cancel({operationId:'cancel-before-settlement',participantId:left.participant.participantId,expectedEpoch:1,reason:'The participant is retired.',cascade:false});
  const artifact=await scoped.store({label:'Owned output',content:Buffer.from('Original public bytes.'),mediaType:'text/plain'});
  await scoped.recordProducedArtifact(artifact);
  assert.equal(await host.canReadPublicArtifact(left.participant.participantId,artifact),true);
  assert.equal(await host.canReadPublicArtifact(left.participant.participantId,unrelated),false);
  assert.equal(await host.canReadPublicArtifact(right.participant.participantId,artifact),false);
  assert.equal(await host.canReadPublicArtifact(left.participant.participantId,{...artifact,size:artifact.size+1}),false);
  assert.equal('artifacts' in (await host.inspect()),false);
  await host.close();
  const fresh=rootDir?new JsonlCollaborationRepository({rootDir}):new EventCollaborationRepository(repository.events);
  reopened=await h.open({hostId:'replacement',repository:fresh});
  assert.equal(await reopened.canReadPublicArtifact(left.participant.participantId,artifact.artifactId),true);
  assert.equal(await reopened.canReadPublicArtifact(right.participant.participantId,artifact.artifactId),false);
  const recoveredScoped=createParticipantArtifactRepository({artifacts:h.artifacts,participantId:left.participant.participantId,coordinator:()=>reopened});
  const restored=await recoveredScoped.resolve(artifact.artifactId);assert.deepEqual(restored,artifact);
  assert.equal(Buffer.from(await recoveredScoped.readVerified(restored)).toString(),'Original public bytes.');
  assert.equal(await recoveredScoped.resolve(unrelated.artifactId),undefined);
});

test('acceptance uniqueness uses its durable result index after recent acceptance projection rolls over',async()=>{
  const repository=new InMemoryCollaborationRepository();
  const owner=await repository.acquireHost({groupId:'acceptances',hostId:'host',supervisorSessionId:'supervisor',budgetOwnerId:'owner',maxParticipants:1,maxConcurrentRuns:1});
  const participant={groupId:'acceptances',participantId:'participant',sessionId:'session',createdBySessionId:'supervisor'};
  const assignment={origin:'delegated',delegatedBy:{sessionId:'supervisor'},assignmentId:'assignment',participantId:'participant',revision:1,runId:'run',task:'Fixture assignment.',epoch:0,capabilityRevision:'v1',capabilities:{toolNames:[]},budgetOwnerId:'owner',budgetScopeId:'scope',sourceRefs:[],initialSources:[]};
  const append=async(event,key)=>repository.append(owner,event,(await repository.load('acceptances')).tail,key);
  try{
    await append({type:'collaboration.assigned',operationId:'assignment',requestFingerprint:'request',participant,assignment},'operation:assignment');
    for(let index=0;index<260;index++){
      const resultId=`result-${index}`;
      await append({type:'collaboration.result_recorded',result:{resultId,participantId:'participant',assignmentId:'assignment',assignmentRevision:1,runId:'run',epoch:0,kind:'partial',source:{runId:'run',eventId:`assistant-${index}`,sequence:index,hash:`hash-${index}`}}},`result:${resultId}`);
      await append({type:'collaboration.result_accepted',operationId:`accept-${index}`,requestFingerprint:`request-${index}`,resultId,epoch:0},`operation:accept-${index}`);
    }
    assert.equal((await repository.load('acceptances')).acceptances.length,256);
    await assert.rejects(append({type:'collaboration.result_accepted',operationId:'repeat-old',requestFingerprint:'repeat-request',resultId:'result-0',epoch:0},'operation:repeat-old'),/already accepted/);
  }finally{await owner.release();}
});
