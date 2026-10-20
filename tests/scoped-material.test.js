import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository, InMemoryEventRepository, PersistenceConflictError, hashJson } from '@agent-core/persistence';
import { ContextService, HistoryReader, InMemorySessionRepository, InMemoryMaterialRepository, InMemoryMaterialGrantProvider,
  EventMaterialRepository, ScopedMaterialService, materialEventCodec, MaterialAccessError, validateErasureReceipt } from '@agent-core/runtime';
import { JsonlMaterialRepository, JsonlSessionRepository } from '@agent-core/runtime/node';

const scope = id => ({ kind: 'scope', scopeId: id });
const owner = scope('private-a');
async function fixture(options = {}) {
  const sessionRepository = options.sessionRepository ?? new InMemorySessionRepository();
  const session = options.session ?? await sessionRepository.create({binding:{schemaId:'material-tests',schemaVersion:1,subject:{}}});
  const artifacts = options.artifacts ?? new InMemoryArtifactRepository();
  const repository = options.repository ?? new InMemoryMaterialRepository();
  const grants = options.grants ?? new InMemoryMaterialGrantProvider([{owner,revision:'initial',read:true,write:true}, {owner:scope('private-b'),revision:'initial',read:true,write:true}]);
  const history = new HistoryReader({repository:sessionRepository,session,artifacts});
  const requestRef = await artifacts.storeProtected({label:'request',content:Buffer.from('{}')});
  const serviceOptions = {repository,artifacts,grants,history,sessionRepository,session,assertWrite:async batch=>assert.deepEqual(batch.inference.requestRef,requestRef),authorizeTransfer:async()=>{},...options.service};
  const service = new ScopedMaterialService(serviceOptions);
  const batch = async (key, operations, target = owner) => { const capturedHistoryCut=await history.capture(); return {owner:target,idempotencyKey:key,branchId:capturedHistoryCut.branchId,capturedHistoryCut,inference:{ownerId:session.id,invocationId:'invocation',requestRef},operations}; };
  const save = async (key, operations, target) => service.save(await batch(key,operations,target));
  return {sessionRepository,session,artifacts,repository,grants,history,requestRef,service,serviceOptions,batch,save};
}
const unqualified = ({itemId,revisionId})=>({itemId,revisionId});

test('general scoped observations persist across sessions with exact owner, subject, and producing attribution', async()=>{
  const f=await fixture();
  const receipt=await f.save('observations',[
    {kind:'create',text:'Prefers quiet mornings',subject:{person:'opaque-a'}},
    {kind:'create',text:'Mina and Alex collaborate',subject:{relationship:'opaque-r'}},
    {kind:'create',text:'The weekly run is ongoing',subject:{activity:'opaque-t'}},
    {kind:'create',text:'The train station is under repair',subject:{environment:'opaque-e'}}
  ]);
  const other=await fixture({repository:f.repository,artifacts:f.artifacts,grants:f.grants});
  assert.notEqual(other.session.id,f.session.id);
  assert.equal((await other.service.list(owner)).items.length,4);
  assert.equal((await other.service.read(receipt.revisions[0])).text,'Prefers quiet mornings');
  const revision=await f.repository.read(receipt.revisions[0]);
  assert.deepEqual(revision.owner,owner);
  assert.equal(revision.capturedHistoryCut.sessionId,f.session.id);
  assert.deepEqual(revision.subject,{person:'opaque-a'});
  assert.equal((await new ContextService({repository:other.sessionRepository,session:other.session,artifacts:other.artifacts,history:other.history,policy:{maxSourceBytes:65536}}).sessionState()).items.length,0);
});

test('shared material reuses per-item conditional operations and preserves disjoint writes',async()=>{
  const f=await fixture();const [a,b]=(await f.save('initial',[{kind:'create',text:'a'},{kind:'create',text:'b'}])).revisions;
  const replace=(ref,text)=>({kind:'replace',itemId:ref.itemId,expectedRevisionId:ref.revisionId,text});
  await Promise.all([f.save('a',[replace(a,'a2')]),f.save('b',[replace(b,'b2')])]);
  await assert.rejects(f.save('stale',[{kind:'create',text:'must not commit'},replace(a,'stale')]),PersistenceConflictError);
  assert.equal((await f.service.list(owner)).items.length,2);
  assert.equal((await f.service.read(a)).text,'a');
});

test('inventory removal retains exact historical revisions; revocation prevents all future reads',async()=>{
  const f=await fixture();const ref=(await f.save('initial',[{kind:'create',text:'historical'}])).revisions[0];
  const deps=await f.service.captureDependencies([ref]);
  await f.save('remove',[{kind:'remove',itemId:ref.itemId,expectedRevisionId:ref.revisionId}]);
  assert.equal((await f.service.list(owner)).items.length,0);
  assert.equal((await f.service.read(ref)).text,'historical');
  const revoke={owner,operationId:'withdraw-exact',expectedRevision:0,refs:[unqualified(ref)]};
  const receipt=await f.service.revoke(revoke);
  assert.deepEqual(await f.service.revoke(revoke),receipt,'retries replay durable revocation receipts');
  await assert.rejects(f.service.read(ref),MaterialAccessError);
  await assert.rejects(f.service.assertDependencies(deps),MaterialAccessError);
});

test('exact Unicode spans, bounded output, same-name subjects remain independent',async()=>{
  const f=await fixture();const refs=(await f.save('unicode',[
    {kind:'create',text:'A😀éB',subject:{name:'Alex',identity:'first'}},
    {kind:'create',text:'Different Alex',subject:{name:'Alex',identity:'second'}}
  ])).revisions;
  assert.equal((await f.service.read({...refs[0],range:{offset:1,bytes:4}},{maxBytes:2048})).text,'😀');
  await assert.rejects(f.service.read({...refs[0],range:{offset:2,bytes:1}}),/UTF-8/);
  await assert.rejects(f.service.read(refs[0],{maxBytes:1}),/bounded read/);
  assert.deepEqual((await f.service.read(refs[1])).subject,{name:'Alex',identity:'second'});
});

test('metadata inventory hydrates no artifact bodies and one selected read consumes one range',async()=>{
  const f=await fixture();const operations=Array.from({length:180},(_,i)=>({kind:'create',text:`Fact ${i}: ${'x'.repeat(1000)}`}));
  const refs=(await f.save('large',operations)).revisions;
  let full=0,ranges=0;const read=f.artifacts.readVerified.bind(f.artifacts),range=f.artifacts.readVerifiedRange.bind(f.artifacts);
  f.artifacts.readVerified=async(...args)=>{full++;return read(...args)};
  f.artifacts.readVerifiedRange=async(...args)=>{ranges++;return range(...args)};
  const page=await f.service.list(owner,{limit:3,maxBytes:4096});
  assert.equal(page.items.length,3);assert.equal(full,0);assert.equal(ranges,0);
  await f.service.read({...refs[72],range:{offset:0,bytes:7}});
  assert.equal(ranges,1);assert.equal(full,1,'in-memory verified range internally verifies exactly the addressed body');
});

test('returned inventory envelopes fit the output budget and grant changes invalidate cursors',async()=>{
  const f=await fixture();await f.save('pages',Array.from({length:10},(_,i)=>({kind:'create',text:`item ${i} ${'x'.repeat(160)}`})));
  const page=await f.service.list(owner,{limit:10,maxBytes:2400});
  assert.ok(page.cursor);assert.ok(Buffer.byteLength(JSON.stringify(page))<=2400);assert.ok(page.items.length<10);
  const next=await f.service.list(owner,{cursor:page.cursor,limit:10,maxBytes:2400});
  assert.ok(next.items.length);assert.notEqual(next.items[0].itemId,page.items[0].itemId);
  const prior=await f.grants.get(owner);await f.grants.withdraw(owner,prior.revision);
  await f.grants.set({owner,revision:'initial',read:true,write:true});
  assert.notEqual((await f.grants.get(owner)).revision,prior.revision);
  await assert.rejects(f.service.list(owner,{cursor:page.cursor,maxBytes:2400}),MaterialAccessError);
});

test('grant restart and withdrawal cannot resurrect prepared dependency stamps',async()=>{
  const f=await fixture();const ref=(await f.save('one',[{kind:'create',text:'private'}])).revisions[0];
  const deps=await f.service.captureDependencies([ref]);
  const grants=new InMemoryMaterialGrantProvider([{owner,revision:'initial',read:true,write:true}]);
  const recreated=new ScopedMaterialService({...f.serviceOptions,grants});
  await assert.rejects(recreated.assertDependencies(deps),MaterialAccessError);
});

test('cross-owner provenance requires explicit transfer and artifact authorization before staging',async()=>{
  const f=await fixture();const ref=(await f.save('origin',[{kind:'create',text:'private source'}])).revisions[0];
  let stores=0;const store=f.artifacts.storeProtected.bind(f.artifacts);f.artifacts.storeProtected=async input=>{stores++;return store(input)};
  const denied=new ScopedMaterialService({...f.serviceOptions,authorizeTransfer:undefined});
  await assert.rejects(denied.save(await f.batch('copy',[{kind:'create',text:'copy',dependencies:[ref]}],scope('private-b'))),/transfer authorization/);
  assert.equal(stores,0);
  const artifact=await f.artifacts.store({label:'source',content:Buffer.from('source')});
  await assert.rejects(f.save('artifact-copy',[{kind:'create',text:'copied',artifactSources:[artifact]}]),/Artifact provenance/);
  assert.equal(stores,0);
});

test('same-session material provenance can safely flow to shared owner under the producer fence',async()=>{
  const f=await fixture();const context=new ContextService({repository:f.sessionRepository,session:f.session,artifacts:f.artifacts,history:f.history,policy:{maxSourceBytes:65536},assertStateWrite:f.serviceOptions.assertWrite});
  const cut=await f.history.capture(),local={kind:'session',sessionId:f.session.id,branchId:cut.branchId};
  const original=await context.saveSessionState(await f.batch('local',[{kind:'create',text:'local evidence'}],local));
  const localRef={...original.revisions[0],owner:local};
  const shared=(await f.save('derived-local',[{kind:'create',text:'attributed transfer',dependencies:[localRef]}])).revisions[0];
  assert.equal((await f.service.read(shared)).text,'attributed transfer');
  await f.service.revoke({owner:local,operationId:'revoke-local',expectedRevision:0,refs:[unqualified(localRef)]});
  await assert.rejects(f.service.read(shared),MaterialAccessError);
});

test('physical erasure is unsupported unless the host implements it and requires prior exact revocation',async()=>{
  const f=await fixture();const ref=(await f.save('one',[{kind:'create',text:'erase me'}])).revisions[0];
  await assert.rejects(f.service.erase([ref]),/unsupported/);
  let calls=0;
  const eraser=new ScopedMaterialService({...f.serviceOptions,erasure:{erase:async targets=>{calls++;return receipt(targets)}}});
  await assert.rejects(eraser.erase([ref]),/Revoke exact/);assert.equal(calls,0);
  const deps=await f.service.captureDependencies([ref]);
  await f.service.revoke({owner,operationId:'revoke',expectedRevision:0,refs:[unqualified(ref)]});
  const result=await eraser.erase([ref]);assert.equal(calls,1);assert.equal(result.coverage[0].retainedSharedBytes,23);assert.equal(result.priorRemoteDelivery,'not_erased');
  await assert.rejects(eraser.withDependencies(deps,async()=>{throw new Error('must not dispatch')}),MaterialAccessError);
});
function receipt(targets){return {targets,coverage:targets.map(target=>({target,bodies:'retained',previews:'removed',indexes:'removed',caches:'removed',retainedSharedBytes:23})),originalHistory:'separately_governed',requestSnapshots:'separately_governed',priorRemoteDelivery:'not_erased',semanticDerivation:'unknown'};}

test('erasure receipts require exact complete target coverage and honest bounded retained-byte counts',()=>{
  const ref={owner,itemId:'item',revisionId:'rev'};
  assert.throws(()=>validateErasureReceipt({...receipt([ref]),coverage:[]},[ref]));
  assert.throws(()=>validateErasureReceipt(receipt([{...ref,revisionId:'other'}]),[ref]),/exact/);
  assert.throws(()=>validateErasureReceipt({...receipt([ref]),coverage:[{...receipt([ref]).coverage[0],retainedSharedBytes:-1}]},[ref]));
  assert.throws(()=>validateErasureReceipt({...receipt([ref]),priorRemoteDelivery:'erased'},[ref]));
});

test('shared journal restarts preserve revocation and reject old-format material records without rewriting them',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'core-material-'));
  try{
    const f=await fixture({repository:new JsonlMaterialRepository({rootDir:root})});
    const ref=(await f.save('one',[{kind:'create',text:'retained historical bytes'}])).revisions[0];
    await f.service.revoke({owner,operationId:'revoke',expectedRevision:0,refs:[unqualified(ref)]});
    const restarted=new ScopedMaterialService({...f.serviceOptions,repository:new JsonlMaterialRepository({rootDir:root})});
    await assert.rejects(restarted.read(ref),MaterialAccessError);
    assert.equal((await restarted.list(owner)).items.length,0);
    assert.throws(()=>materialEventCodec.decode({type:'material.batch',format:'agent-core.material/0',batch:{}}));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('dependency closure bounds reject oversized sets before acquiring a host grant lock',async()=>{
  const f=await fixture();let locks=0;const withGrant=f.grants.withGrant.bind(f.grants);f.grants.withGrant=(...args)=>{locks++;return withGrant(...args)};
  const values=Array.from({length:257},(_,i)=>({ref:{owner,itemId:`item-${i}`,revisionId:`revision-${i}`},grantRevision:'r',revocationRevision:0}));
  await assert.rejects(f.service.withDependencies(values,async()=>{}),/256/);assert.equal(locks,0);
});

test('declaration cycles are bounded and every dependency revision is authorized once per traversal',async()=>{
  const f=await fixture();const real=(await f.save('one',[{kind:'create',text:'base'}])).revisions[0];
  const revision=await f.repository.read(real),a={owner,itemId:'a',revisionId:'a'},b={owner,itemId:'b',revisionId:'b'};
  let reads=0;f.repository.read=async ref=>{reads++;return {...revision,itemId:ref.itemId,revisionId:ref.revisionId,dependencies:[ref.itemId==='a'?b:a]}};
  assert.equal((await f.service.captureDependencies([a])).length,2);assert.equal(reads,2);
});

test('dependency depth is bounded even with a host-provided graph',async()=>{
  const f=await fixture();const real=(await f.save('one',[{kind:'create',text:'base'}])).revisions[0];const revision=await f.repository.read(real);
  f.repository.read=async ref=>({...revision,itemId:ref.itemId,revisionId:ref.revisionId,dependencies:[{owner,itemId:String(Number(ref.itemId)+1),revisionId:String(Number(ref.itemId)+1)}]});
  await assert.rejects(f.service.captureDependencies([{owner,itemId:'0',revisionId:'0'}]),/depth/);
});

function artifactAuthorityFixture() {
  let revision=1,available=true,tail=Promise.resolve();
  const locked=operation=>{const next=tail.then(operation);tail=next.then(()=>undefined,()=>undefined);return next;};
  const capture=async()=>{if(!available)throw new MaterialAccessError('Artifact source withdrawn.');return `artifact-authority:${revision}`;};
  return {capture,withAuthority:(dependencies,operation)=>locked(async()=>{for(const dependency of dependencies)if(await capture()!==dependency.revision)throw new MaterialAccessError('Artifact source authority changed.');return operation();}),withdraw:()=>locked(async()=>{available=false;revision++;})};
}

test('artifact provenance denies unfenced hosts before staging and captures exact authority revisions',async()=>{
  const authority=artifactAuthorityFixture(),f=await fixture({service:{artifactAuthority:authority}});
  const artifact=await f.artifacts.store({label:'authorized source',content:Buffer.from('source')});
  let stores=0;const store=f.artifacts.storeProtected.bind(f.artifacts);f.artifacts.storeProtected=async input=>{stores++;return store(input)};
  const unfenced=new ScopedMaterialService({...f.serviceOptions,artifactAuthority:{capture:authority.capture}});
  await assert.rejects(unfenced.save(await f.batch('unfenced',[{kind:'create',text:'derived',artifactSources:[artifact]}])),/authority fence/);
  assert.equal(stores,0);
  const ref=(await f.save('fenced',[{kind:'create',text:'derived',artifactSources:[artifact]}])).revisions[0];
  const dependencies=await f.service.captureDependencies([ref]);
  assert.equal(dependencies[0].artifacts[0].revision,'artifact-authority:1');
  assert.equal((await f.service.read(ref)).text,'derived');
  await authority.withdraw();
  await assert.rejects(new ScopedMaterialService(f.serviceOptions).read(ref),/withdrawn/);
  await assert.rejects(f.service.assertDependencies(dependencies),/withdrawn/);
});

test('artifact withdrawal winning before shared publication appends no material revision',async()=>{
  const authority=artifactAuthorityFixture(),f=await fixture({service:{artifactAuthority:authority}});
  const artifact=await f.artifacts.store({label:'source',content:Buffer.from('source')});
  let entered,release;const ready=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});let writes=0;
  const service=new ScopedMaterialService({...f.serviceOptions,assertWrite:async batch=>{await f.serviceOptions.assertWrite(batch);if(++writes===2){entered();await gate;}}});
  const pending=service.save(await f.batch('artifact-race',[{kind:'create',text:'derived',artifactSources:[artifact]}]));
  await ready;await authority.withdraw();release();
  await assert.rejects(pending,/withdrawn|authority changed/);
  assert.equal((await f.repository.list(owner)).items.length,0);
});

test('artifact withdrawal between dependency inspection and dispatch blocks cached material',async()=>{
  const authority=artifactAuthorityFixture(),f=await fixture({service:{artifactAuthority:authority}});
  const artifact=await f.artifacts.store({label:'source',content:Buffer.from('source')});
  const ref=(await f.save('artifact-dispatch',[{kind:'create',text:'derived',artifactSources:[artifact]}])).revisions[0];
  const dependencies=await f.service.captureDependencies([ref]);
  let entered,release;const ready=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
  const original=authority.withAuthority;authority.withAuthority=async(deps,operation)=>{entered();await gate;return original(deps,operation)};
  let dispatched=false;const pending=f.service.withDependencies(dependencies,async()=>{dispatched=true});
  await ready;await authority.withdraw();release();
  await assert.rejects(pending,/withdrawn|authority changed/);assert.equal(dispatched,false);
});

for(const ErrorType of [MaterialAccessError,PersistenceConflictError])test(`shared publication reconciles a committed receipt when host guard later throws ${ErrorType.name}`,async()=>{
  const f=await fixture({service:{withOwnership:async operation=>{await operation();throw new ErrorType('host guard lost after commit')}}});
  const batch=await f.batch(`post-commit-${ErrorType.name}`,[{kind:'create',text:'durably committed'}]);
  const result=await f.service.save(batch);
  assert.equal(result.revisions.length,1);
  assert.deepEqual(result,await f.service.findSavedBatch(batch));
  assert.equal((await f.repository.list(owner)).items.length,1);
});


for(const invalid of ['owner','target'])test(`session journal rejects a revocation with forged ${invalid} without altering source bytes`,async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'material-revocation-trust-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sessionRepository=new JsonlSessionRepository(root),f=await fixture({sessionRepository});
  const context=new ContextService({repository:sessionRepository,session:f.session,artifacts:f.artifacts,history:f.history,policy:{maxSourceBytes:65536},assertStateWrite:f.serviceOptions.assertWrite});
  const local=await f.service.currentSessionOwner();
  const saved=await context.saveSessionState(await f.batch('valid-local',[{kind:'create',text:'retained'}],local));
  await f.service.revoke({owner:local,operationId:'valid-revocation',expectedRevision:0,refs:saved.revisions});
  const file=sessionRepository.location(f.session.id),records=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
  const record=records.find(value=>value.type==='session_material_revocation');
  if(invalid==='owner')record.owner.branchId='forged-branch';else record.refs=[{itemId:'unavailable-item',revisionId:'unavailable-revision'}];
  const source=records.map(value=>JSON.stringify(value)).join('\n')+'\n';await writeFile(file,source);
  const restarted=new JsonlSessionRepository(root);
  await assert.rejects(restarted.rebuildHistoryIndex(f.session.id,f.session.header.binding),error=>{for(let cause=error;cause;cause=cause.cause)if(cause.message.includes(`revocation ${invalid}`))return true;return false;});
  assert.equal(await readFile(file,'utf8'),source);
});

test('shared journal rejects forged revocation targets absent from its immutable revision index',async()=>{
  const events=new InMemoryEventRepository(materialEventCodec),repository=new EventMaterialRepository(events),f=await fixture({repository});
  await f.save('valid-shared',[{kind:'create',text:'retained'}]);
  const [ledger]=await events.listRunIds();
  await events.append(ledger,{type:'material.revoked',format:'agent-core.material/1',owner,operationId:'forged',expectedRevision:0,revision:1,refs:[{itemId:'unavailable-item',revisionId:'unavailable-revision'}]});
  await assert.rejects(new EventMaterialRepository(events).list(owner),/revokes an unavailable revision/);
});

for(const kind of ['memory','jsonl'])test(`${kind}: trusted inherited prefix rebinding preserves exact revisions but rejects abandoned parent material`,async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'material-prefix-inheritance-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sessionRepository=kind==='memory'?new InMemorySessionRepository():new JsonlSessionRepository(root),f=await fixture({sessionRepository});
  const context=new ContextService({repository:sessionRepository,session:f.session,artifacts:f.artifacts,history:f.history,policy:{maxSourceBytes:65536},assertStateWrite:f.serviceOptions.assertWrite});
  const originalOwner=await f.service.currentSessionOwner();
  const original=await context.saveSessionState(await f.batch('prefix-source',[{kind:'create',text:'exact inherited bytes'}],originalOwner));
  const source={...original.revisions[0],owner:originalOwner};
  const derived=await context.saveSessionState(await f.batch('prefix-derived',[{kind:'create',text:'derived inherited bytes',dependencies:[source]}],originalOwner));
  const inherited={...derived.revisions[0],owner:originalOwner},prefix=await f.service.captureDependencies([inherited]);
  const later=await context.saveSessionState(await f.batch('abandoned',[{kind:'create',text:'later parent-only bytes'}],originalOwner));
  const abandoned=await f.service.captureDependencies([{...later.revisions[0],owner:originalOwner}]);
  await sessionRepository.branchFrom(f.session,derived.entryId);
  const child=await f.service.currentSessionOwner();
  await assert.rejects(f.service.read(inherited),MaterialAccessError,'direct stale owner references stay denied');
  const rebound=await f.service.captureInheritedPrefixDependencies(prefix);
  assert.equal(rebound.length,2);assert.ok(rebound.every(value=>value.ref.owner.branchId===child.branchId));
  assert.equal((await f.service.read({...inherited,owner:child})).text,'derived inherited bytes');
  await assert.rejects(f.service.captureInheritedPrefixDependencies(abandoned),/unavailable/);
  await f.service.revoke({owner:child,operationId:'revoke-inherited',expectedRevision:0,refs:[unqualified(source)]});
  await assert.rejects(f.service.captureInheritedPrefixDependencies(prefix),/authority changed|unavailable/);
});
