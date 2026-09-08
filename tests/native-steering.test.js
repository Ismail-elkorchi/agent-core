import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventRepository } from '@agent-core/persistence';
import { NativeSteeringCoordinator, SteeringDeliveryUnknownError, AgentRuntime, agentEventCodec } from '@agent-core/runtime';

function coordinator(events,runId='run') {return new NativeSteeringCoordinator({runId,events,append:(event,key)=>events.append(runId,event,{idempotencyKey:key})});}

test('native steering persists acceptance and acknowledgment, then applies once without local redelivery',async()=>{
 const events=new InMemoryEventRepository(agentEventCodec);const driver=coordinator(events);let submitted;
 const session={complete:async()=>{},steer:async input=>{submitted=input;return {deliveryId:input.deliveryId,responseId:input.responseId,status:'acknowledged'};},steeringStatus:async id=>({deliveryId:id,responseId:'response',status:'applied',providerEventId:'applied'})};
 driver.bind(session,true);await driver.observe({type:'response_started',responseId:'response'});await driver.accept('delivery','Keep the full correction.');
 await driver.finishResponse();assert.equal(submitted.input[0].role,'user');assert.equal(submitted.input[0].content,'Keep the full correction.');assert.deepEqual(await driver.nextRequestInputs(),[]);
 const reopened=coordinator(events);await reopened.restore();assert.deepEqual(await reopened.nextRequestInputs(),[]);
 const records=[];for await(const record of events.read('run')) records.push(record.event);
 assert.deepEqual(records.filter(event=>event.type==='input.steering.delivery').map(event=>event.delivery.status),['submitted','acknowledged','applied']);
});

test('disconnect after native submission remains uncertain across recovery and never becomes local redelivery',async()=>{
 const events=new InMemoryEventRepository(agentEventCodec);const driver=coordinator(events);
 driver.bind({complete:async()=>{},steer:async()=>{throw new Error('disconnect');},steeringStatus:async()=>{throw new Error('no evidence');}},true);
 await driver.observe({type:'response_started',responseId:'response'});await driver.accept('uncertain','Do not lose this accepted correction.');
 await assert.rejects(driver.finishResponse(),SteeringDeliveryUnknownError);
 const reopened=coordinator(events);await reopened.restore();await assert.rejects(reopened.nextRequestInputs(),SteeringDeliveryUnknownError);
});

test('provider-confirmed native rejection permits exactly one next-boundary delivery',async()=>{
 const events=new InMemoryEventRepository(agentEventCodec);const driver=coordinator(events);
 driver.bind({complete:async()=>{},steer:async input=>({deliveryId:input.deliveryId,responseId:input.responseId,status:'failed'}),steeringStatus:async()=>{}},true);
 await driver.observe({type:'response_started',responseId:'response'});await driver.accept('failed','Use the corrected source.');await driver.finishResponse();
 assert.deepEqual(await driver.nextRequestInputs(),[{id:'failed',content:'Use the corrected source.'}]);assert.deepEqual(await driver.nextRequestInputs(),[]);
});

test('AgentRuntime delivers native steering during an active provider response',async()=>{
 const events=new InMemoryEventRepository(agentEventCodec);let handle;let submitted;let notify;const received=new Promise(resolve=>{notify=resolve;});
 const profile={id:'native',provider:'fixture',capabilities:{streaming:true,toolCalling:false,supportedToolInputs:[],jsonMode:false,jsonSchema:false,logprobs:false,temperature:false,topP:false,protocol:{version:1,revision:'fixture1',endpoint:'fixture',roles:['system','developer','user','assistant'],inputKinds:['text'],outputKinds:['text'],state:'none',continuation:'replay',asyncTools:false,steering:'native',contextTransforms:[],toolChoice:['auto'],counting:'estimate'}},modalities:{input:['text'],output:['text']},limits:{contextTokens:20000,outputTokens:128},supportedParameters:['maxOutputTokens']};
 const session={complete:async()=>{throw new Error('stream expected');},async *stream(){yield {type:'response_started',responseId:'response'};yield {type:'content',content:'working',accumulated:'working'};await received;yield {type:'steering',delivery:{deliveryId:submitted.deliveryId,responseId:'response',status:'applied',providerEventId:'receipt'}};yield {type:'done',response:{provider:'fixture',model:'native',content:'Corrected result.',terminationReason:'stop',usage:{promptTokens:20,completionTokens:10,totalTokens:30}}};},steer:async input=>{submitted=input;notify();return {deliveryId:input.deliveryId,responseId:'response',status:'acknowledged'};},steeringStatus:async id=>({deliveryId:id,responseId:'response',status:'applied',providerEventId:'receipt'})};
 const provider={id:'fixture',implementationId:'fixture@1',describe:()=>({id:'fixture',displayName:'Fixture',defaultModel:'native'}),describeModel:async()=>profile,createSession:()=>session,complete:session.complete};
 const runtime=new AgentRuntime({provider,model:'native',repositories:{events},toolBoundary:{authorizationPolicyId:'none',executionTargetId:'none'},onProgress:event=>{if(event.type==='assistant.delta'&&event.accumulated==='working')handle.injectSteering({instruction:'Apply this correction now.'});}});
 handle=runtime.run({task:'Run the task.'});const result=await handle.result;
 assert.equal(result.state,'ended');assert.equal(result.terminal.executionStatus,'completed');assert.equal(submitted.input[0].content,'Apply this correction now.');
});
