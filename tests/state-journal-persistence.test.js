import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { hashJson, InMemoryArtifactRepository, InMemoryEventRepository, typedEventCodec } from '@agent-core/persistence';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
const binding = {schemaId:'state-journal-test',schemaVersion:1,subject:{}};
async function fixture(t,kind) {
  const root = await mkdtemp(path.join(tmpdir(),'state-journal-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const repository = kind === 'memory' ? new InMemorySessionRepository() : new JsonlSessionRepository(root);
  const session = await repository.create({binding});
  const artifacts = new InMemoryArtifactRepository();
  const requestRef = await artifacts.storeProtected({label:'inference',content:Buffer.from('{}')});
  return {root,repository,session,artifacts,inference:{ownerId:'owner',invocationId:'inference',requestRef}};
}
async function cut(f) {
  const snapshot = await f.repository.sourceSnapshot(f.session);
  return {format:'agent-core.history/1',sessionId:f.session.id,branchId:snapshot.branchId,throughEntryId:snapshot.boundary.leafId,sourceRevision:snapshot.sourceRevision,ledgerCoverage:'session'};
}
async function batch(f,key,operations,capturedHistoryCut = undefined,maxStorageBytes = 16*1024*1024) {
  capturedHistoryCut ??= await cut(f);
  const command = {idempotencyKey:key,branchId:capturedHistoryCut.branchId,inference:f.inference,capturedHistoryCut,operations};
  const fingerprint = hashJson(command), revisions = [];
  for (const [index,operation] of operations.entries()) {
    const contentRef = await f.artifacts.storeProtected({label:'state-item',mediaType:'text/plain',content:Buffer.from(operation.text ?? '')});
    revisions.push({itemId:operation.itemId ?? `state-item-${hashJson({branchId:command.branchId,fingerprint,index})}`,
      revisionId:`state-revision-${hashJson({fingerprint,index})}`,previousRevisionId:operation.expectedRevisionId ?? null,
      deleted:operation.kind === 'remove',contentRef,contentSha256:contentRef.sha256,contentBytes:contentRef.size,
      inference:command.inference,capturedHistoryCut});
  }
  const {operations:_,...metadata} = command;
  return {...metadata,fingerprint,revisions,maxStorageBytes};
}
for (const kind of ['memory','jsonl']) {
  test(`${kind}: independent state writes use per-item CAS, retry receipts and immutable historical refs`,async t => {
    const f = await fixture(t,kind);
    const first = await batch(f,'initial',[{kind:'create',text:'one'},{kind:'create',text:'two'}]);
    const receipt = await f.repository.saveSessionState(f.session,first);
    const [one,two] = receipt.revisions;
    const captured = await cut(f);
    const changes = await Promise.all([one,two].map((item,i) => batch(f,`change-${i}`,[{kind:'replace',itemId:item.itemId,expectedRevisionId:item.revisionId,text:`changed-${i}`}],captured)));
    const results = await Promise.all(changes.map(change => f.repository.saveSessionState(f.session,change)));
    assert.equal(results.length,2);
    assert.deepEqual(await f.repository.saveSessionState(f.session,first),receipt);
    assert.deepEqual(await f.repository.findSessionStateBatch(f.session,'initial'),receipt);
    assert.equal((await f.repository.readSessionStateItem(f.session,one)).revisionId,one.revisionId);
    assert.equal((await f.repository.currentSessionStateItem(f.session,one.itemId)).revisionId,results[0].revisions[0].revisionId);
    assert.equal((await f.repository.readConversation(f.session)).length,0);
    const conflict = await batch(f,'conflicting',[{kind:'replace',itemId:one.itemId,expectedRevisionId:one.revisionId,text:'stale'},{kind:'create',text:'must not publish'}]);
    const revision = await f.repository.revision(f.session);
    await assert.rejects(f.repository.saveSessionState(f.session,conflict),/changed after/);
    assert.equal(await f.repository.revision(f.session),revision);
    await assert.rejects(f.repository.saveSessionState(f.session,{...first,maxStorageBytes:first.maxStorageBytes+1}),/conflicting content/);
  });
  test(`${kind}: forks inherit exact state roots and exclude abandoned future revisions`,async t => {
    const f = await fixture(t,kind);
    const original = await f.repository.saveSessionState(f.session,await batch(f,'before',[{kind:'create',text:'before'}]));
    const ref = original.revisions[0];
    const future = await f.repository.saveSessionState(f.session,await batch(f,'future',[{kind:'replace',itemId:ref.itemId,expectedRevisionId:ref.revisionId,text:'future'}]));
    await f.repository.branchFrom(f.session,original.entryId,'fork');
    assert.equal((await f.repository.currentSessionStateItem(f.session,ref.itemId)).revisionId,ref.revisionId);
    await assert.rejects(f.repository.readSessionStateItem(f.session,future.revisions[0]),/unavailable/);
    assert.equal(await f.repository.findSessionStateBatch(f.session,'future'),undefined);
    const fork = await f.repository.saveSessionState(f.session,await batch(f,'fork',[{kind:'replace',itemId:ref.itemId,expectedRevisionId:ref.revisionId,text:'fork'}]));
    assert.notEqual(fork.revisions[0].revisionId,ref.revisionId);
  });
  test(`${kind}: accepted input fences stale state, quotas reject atomically, and pages pin their boundary`,async t => {
    const f = await fixture(t,kind);
    const operations = Array.from({length:9},(_,i) => ({kind:'create',text:`item-${i}`}));
    const original = await batch(f,'original',operations);
    await f.repository.saveSessionState(f.session,original);
    const page = await f.repository.listSessionState(f.session,{limit:3});
    assert.equal(page.coverage,'partial');
    const next = await f.repository.listSessionState(f.session,{limit:3,cursor:page.cursor});
    assert.equal(new Set([...page.items,...next.items].map(item => item.itemId)).size,6);
    const stale = await batch(f,'stale',[{kind:'create',text:'stale'}]);
    await f.repository.appendInput(f.session,{runId:'new-input',task:'Correction'});
    await assert.rejects(f.repository.saveSessionState(f.session,stale),/Accepted input|accepted input/);
    const tooLarge = await batch(f,'quota',[{kind:'create',text:'more'}],undefined,1);
    await assert.rejects(f.repository.saveSessionState(f.session,tooLarge),/quota/);
    assert.equal((await f.repository.listSessionState(f.session)).items.length,9);
    await assert.rejects(f.repository.listSessionState(f.session,{limit:257}),/bounds/);
    await assert.rejects(f.repository.readSessionStateItem(f.session,{itemId:original.revisions[0].itemId,revisionId:original.revisions[0].revisionId,range:{offset:0,bytes:999}}));
  });
}
test('jsonl: metadata-only state pages survive restart and index rebuild without storing item bodies in journal',async t => {
  const f = await fixture(t,'jsonl');
  const marker = 'body-is-only-an-artifact-'.repeat(300);
  const commit = await batch(f,'large',Array.from({length:32},() => ({kind:'create',text:marker})));
  const saved = await f.repository.saveSessionState(f.session,commit);
  const bytes = await readFile(f.repository.location(f.session.id),'utf8');
  assert.equal(bytes.includes(marker),false);
  const restarted = new JsonlSessionRepository(f.root);
  const session = await restarted.open(f.session.id,binding);
  const before = restarted.historyReadMetrics(session.id);
  const page = await restarted.listSessionState(session,{limit:5});
  const after = restarted.historyReadMetrics(session.id);
  assert.equal(page.items.length,5);
  assert.equal(after.bodyRecordsRead-before.bodyRecordsRead,0);
  assert.equal(after.scannedBytes-before.scannedBytes,0);
  await restarted.rebuildHistoryIndex(session.id,binding);
  assert.deepEqual(await restarted.findSessionStateBatch(session,'large'),saved);
  assert.equal((await restarted.listSessionState(session)).items.length,32);
});
test('jsonl: source append with lost index publication returns the original state receipt on retry',async t => {
  const f = await fixture(t,'jsonl');
  const commit = await batch(f,'lost-receipt',[{kind:'create',text:'once'}]);
  const prepare = DatabaseSync.prototype.prepare;
  let failed = false;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this,sql);
    if (sql.startsWith('INSERT OR REPLACE INTO projection_root')) statement.run = () => {failed = true; throw new Error('injected publication failure');};
    return statement;
  };
  try {await assert.rejects(f.repository.saveSessionState(f.session,commit),/injected|publication/i);}
  finally {DatabaseSync.prototype.prepare = prepare;}
  assert(failed);
  const restarted = new JsonlSessionRepository(f.root);
  const receipt = await restarted.saveSessionState(f.session,commit);
  assert.deepEqual(await restarted.saveSessionState(f.session,commit),receipt);
  const records = (await readFile(restarted.location(f.session.id),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(record => record.type === 'session_state_batch').length,1);
});
test('jsonl: incompatible prior session format is rejected without altering source bytes',async t => {
  const f = await fixture(t,'jsonl');
  const file = f.repository.location(f.session.id);
  const originalIndex = await readFile(`${file}.index`);
  const prior = (await readFile(file,'utf8')).replace('agent-core.session/5','agent-core.session/4');
  await writeFile(file,prior);
  const restarted = new JsonlSessionRepository(f.root);
  await assert.rejects(restarted.open(f.session.id,binding),error => {
    for (let cause = error; cause; cause = cause.cause) if (cause.message.includes('Incompatible session format')) return true;
    return false;
  });
  assert.equal(await readFile(file,'utf8'),prior);
  assert.deepEqual(await readFile(`${file}.index`),originalIndex);
});
for (const kind of ['memory','jsonl']) {
  test(`${kind}: state commit checks execution ownership under append lock and receipt retries need no live owner`,async t => {
    const f = await fixture(t,kind);
    const owner = await f.repository.tryAcquireExecution(f.session);
    assert(owner);
    const first = await batch(f,'owned',[{kind:'create',text:'owned'}]);
    const saved = await f.repository.saveSessionState(f.session,first,{withOwnership:async publish => {await owner.assertOwned();return publish();}});
    await owner.release();
    assert.deepEqual(await f.repository.saveSessionState(f.session,first,{withOwnership:async publish => {await owner.assertOwned();return publish();}}),saved);
    const stale = await batch(f,'released',[{kind:'create',text:'cannot publish'}]);
    await assert.rejects(f.repository.saveSessionState(f.session,stale,{withOwnership:async publish => {await owner.assertOwned();return publish();}}),/ownership|lock/i);
    assert.equal(await f.repository.findSessionStateBatch(f.session,'released'),undefined);
  });
}
test('jsonl: independent repository writers serialize touched-item checks without disjoint-item conflicts',async t => {
  const f = await fixture(t,'jsonl');
  const first = await f.repository.saveSessionState(f.session,await batch(f,'seed',[{kind:'create',text:'left'},{kind:'create',text:'right'}]));
  const captured = await cut(f);
  const changes = await Promise.all(first.revisions.map((item,index) => batch(f,`writer-${index}`,[{kind:'replace',itemId:item.itemId,expectedRevisionId:item.revisionId,text:`value-${index}`}],captured)));
  const writers = [new JsonlSessionRepository(f.root),new JsonlSessionRepository(f.root)];
  const saved = await Promise.all(writers.map((writer,index) => writer.saveSessionState(f.session,changes[index])));
  assert.equal(saved.length,2);
  const ref = saved[0].revisions[0], nextCut = await cut(f);
  const conflicts = await Promise.all([0,1].map(index => batch(f,`contender-${index}`,[{kind:'replace',itemId:ref.itemId,expectedRevisionId:ref.revisionId,text:`contender-${index}`},{kind:'create',text:`atomic-${index}`}],nextCut)));
  const settled = await Promise.allSettled(writers.map((writer,index) => writer.saveSessionState(f.session,conflicts[index])));
  assert.equal(settled.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(settled.filter(result => result.status === 'rejected').length,1);
  assert.equal((await f.repository.listSessionState(f.session)).items.length,3);
});
for (const kind of ['memory','jsonl']) {
  test(`${kind}: retained storage quota includes revisions on abandoned branches`,async t => {
    const f = await fixture(t,kind);
    const initial = await batch(f,'base',[{kind:'create',text:'1234'}]);
    const first = await f.repository.saveSessionState(f.session,initial);
    const ref = first.revisions[0];
    const abandoned = await batch(f,'abandoned',[{kind:'replace',itemId:ref.itemId,expectedRevisionId:ref.revisionId,text:'5678'}]);
    await f.repository.saveSessionState(f.session,abandoned);
    await f.repository.branchFrom(f.session,first.entryId);
    const retainedBytes = [initial,abandoned].reduce((total,commit) => total + Buffer.byteLength(JSON.stringify(commit)) + commit.revisions.reduce((bytes,item) => bytes + item.contentBytes,0),0);
    const overflow = await batch(f,'fork-overflow',[{kind:'create',text:'12345'}],undefined,retainedBytes);
    await assert.rejects(f.repository.saveSessionState(f.session,overflow),/quota/);
  });
}
for (const kind of ['memory','jsonl']) {
  test(`${kind}: rejected staged artifacts are outside committed journal quota and are never unsafely deleted`,async t => {
    const f = await fixture(t,kind);
    let stagedArtifacts = 0;
    const store = f.artifacts.storeProtected.bind(f.artifacts);
    f.artifacts.storeProtected = async input => {stagedArtifacts++;return store(input);};
    const initial = await batch(f,'committed',[{kind:'create',text:'retained body'}]);
    await f.repository.saveSessionState(f.session,initial);
    const retained = await f.repository.committedRetainedStateBytes(f.session);
    const revision = await f.repository.revision(f.session);
    const staged = await batch(f,'not-committed',[{kind:'create',text:'distinct staged body'}]);
    await assert.rejects(f.repository.saveSessionState(f.session,staged,{withOwnership:async () => {throw new Error('execution owner changed');}}),/owner changed/);
    assert.equal(stagedArtifacts,2);
    assert.equal(await f.repository.revision(f.session),revision);
    assert.equal(await f.repository.committedRetainedStateBytes(f.session),retained);
    assert.equal(Buffer.from(await f.artifacts.readVerified(staged.revisions[0].contentRef)).toString(),'distinct staged body');
    assert.equal(Buffer.from(await f.artifacts.readVerified(initial.revisions[0].contentRef)).toString(),'retained body');
  });
}
for (const kind of ['memory','jsonl']) {
  test(`${kind}: state-batch fork boundaries retain captured ledger source heads`,async t => {
    const f = await fixture(t,kind);
    const captured = await cut(f);
    const head = {runId:'captured-run',sequence:7,hash:'a'.repeat(64)};
    const commit = await batch(f,'captured-cut',[{kind:'create',text:'understanding'}],{...captured,ledgerCoverage:'authoritative',ledgerHeads:[head]});
    const saved = await f.repository.saveSessionState(f.session,commit);
    await f.repository.branchFrom(f.session,saved.entryId);
    const fork = await f.repository.sourceSnapshot(f.session);
    assert.deepEqual((await fork.inheritedHeads).get(head.runId),head);
  });
}
for (const kind of ['memory','jsonl']) {
  test(`${kind}: state metadata page byte bounds include the envelope and continuation cursor`,async t => {
    const f = await fixture(t,kind);
    await f.repository.saveSessionState(f.session,await batch(f,'bounded-page',Array.from({length:11},(_,index) => ({kind:'create',text:String(index)}))));
    const seen = new Set();
    let cursor;
    do {
      const page = await f.repository.listSessionState(f.session,{maxBytes:1024,...(cursor ? {cursor} : {})});
      assert(Buffer.byteLength(JSON.stringify(page)) <= 1024);
      assert(page.items.length > 0);
      for (const item of page.items) {assert(!seen.has(item.itemId));seen.add(item.itemId);}
      cursor = page.cursor;
    } while (cursor);
    assert.equal(seen.size,11);
  });
}

for (const kind of ['memory','jsonl']) {
  test(`${kind}: state publication cannot cross a driver takeover and lost receipts survive takeover`,async t => {
    const f = await fixture(t,kind);
    const events = kind === 'memory' ? new InMemoryEventRepository(typedEventCodec) : new JsonlEventRepository({rootDir:path.join(f.root,'events'),codec:typedEventCodec});
    const contender = kind === 'memory' ? events : new JsonlEventRepository({rootDir:path.join(f.root,'events'),codec:typedEventCodec});
    await events.append('run',{type:'initial'});
    const tail = await events.tail('run');
    let enter,release;
    const entered = new Promise(resolve => {enter=resolve;});
    const gate = new Promise(resolve => {release=resolve;});
    const commit = await batch(f,'fenced',[{kind:'create',text:'before takeover'}]);
    let published = false;
    const saving = f.repository.saveSessionState(f.session,commit,{withOwnership:publish => events.withDriverGeneration('run',0,async () => {
      enter();await gate;const receipt=await publish();published=true;return receipt;
    })});
    await entered;
    const takeover = contender.appendConditional('run',{type:'takeover'},{expectedTail:tail,driverGeneration:1,idempotencyKey:'takeover'}).then(result => {assert(published);return result;});
    release();
    const receipt = await saving;
    assert.equal((await takeover).kind,'committed');
    const withOwnership = publish => events.withDriverGeneration('run',0,publish);
    assert.deepEqual(await f.repository.saveSessionState(f.session,commit,{withOwnership}),receipt);
    const stale = await batch(f,'after-takeover',[{kind:'create',text:'must not publish'}]);
    const revision = await f.repository.revision(f.session);
    await assert.rejects(f.repository.saveSessionState(f.session,stale,{withOwnership}),/ownership was lost/);
    assert.equal(await f.repository.revision(f.session),revision);
    assert.equal((await f.repository.listSessionState(f.session)).items.length,1);
  });
}
