import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {InMemoryEventRepository,typedEventCodec} from '@agent-core/persistence';
import {JsonlEventRepository} from '@agent-core/persistence/node';

const codec = {
  metadataIndexes:[{field:'route'}],
  encode:typedEventCodec.encode,
  decode(value) {
    if (value.failure === 'decode') throw new Error('Rejected event decoding');
    return typedEventCodec.decode(value);
  },
  metadata(value) {
    if (value.failure === 'metadata') throw new Error('Rejected event metadata');
    if (value.failure === 'metadata_shape') return {route:42};
    return {route:value.route};
  }
};
for (const kind of ['memory','jsonl']) for (const mode of ['append','conditional']) for (const failure of ['decode','metadata','metadata_shape']) {
  test(`${kind} ${mode}: ${failure} rejection leaves source, tail, idempotency and routing unchanged`,async t => {
    const root = await mkdtemp(path.join(tmpdir(),'event-append-atomicity-'));
    t.after(() => rm(root,{recursive:true,force:true}));
    const repository = kind === 'memory' ? new InMemoryEventRepository(codec) : new JsonlEventRepository({rootDir:root,codec});
    const runId = 'atomic';
    const first = await repository.append(runId,{type:'record',route:'kept'},{idempotencyKey:'first'});
    const tail = await repository.tail(runId);
    const before = kind === 'jsonl' ? await readFile(repository.location(runId)) : undefined;
    const input = {type:'record',route:'rejected',failure};
    const publish = event => mode === 'append'
      ? repository.append(runId,event,{idempotencyKey:'retry'})
      : repository.appendConditional(runId,event,{idempotencyKey:'retry',expectedTail:tail,driverGeneration:tail.driverGeneration});
    await assert.rejects(publish(input));
    assert.deepEqual(await repository.tail(runId),tail);
    assert.equal((await repository.latestOfType(runId,'record')).eventId,first.eventId);
    assert.equal(await repository.referenceByKey(runId,'retry'),undefined);
    assert.equal((await repository.readRange(runId)).records.length,1);
    assert.equal((await repository.readMetadataRange(runId,{metadata:{route:'kept'}})).records.length,1);
    assert.equal((await repository.readMetadataRange(runId,{metadata:{route:'rejected'}})).records.length,0);
    assert.equal((await repository.verifyIntegrity(runId)).ok,true);
    if (kind === 'jsonl') assert.deepEqual(await readFile(repository.location(runId)),before);
    const next = await publish({type:'record',route:'recovered'});
    assert.equal(mode === 'append' ? next.sequence : next.receipt.sequence,1);
    assert.equal((await repository.readMetadataRange(runId,{metadata:{route:'recovered'}})).records.length,1);
    assert.equal((await repository.verifyIntegrity(runId)).ok,true);
  });
}
for (const kind of ['memory','jsonl']) {
  test(`${kind}: append captures codec routing once before committing`,async t => {
    const root = await mkdtemp(path.join(tmpdir(),'event-codec-once-'));
    t.after(() => rm(root,{recursive:true,force:true}));
    let decodes = 0, metadataCalls = 0;
    const once = {encode:typedEventCodec.encode,decode(value) {decodes++;return typedEventCodec.decode(value);},
      metadata() {if (++metadataCalls > 1) throw new Error('Codec routing was evaluated again');return {route:'once'};},metadataIndexes:[{field:'route'}]};
    const repository = kind === 'memory' ? new InMemoryEventRepository(once) : new JsonlEventRepository({rootDir:root,codec:once});
    const receipt = await repository.append('once',{type:'record'});
    assert.equal(receipt.sequence,0);
    assert.equal(decodes,1);
    assert.equal(metadataCalls,1);
    assert.equal((await repository.tail('once')).sequence,0);
  });
}

for (const kind of ['memory','jsonl']) {
  test(`${kind}: driver fence serializes takeover and rejects reentrant event append`,async t => {
    const root = await mkdtemp(path.join(tmpdir(),'event-driver-fence-'));
    t.after(() => rm(root,{recursive:true,force:true}));
    const repository = kind === 'memory' ? new InMemoryEventRepository(typedEventCodec) : new JsonlEventRepository({rootDir:root,codec:typedEventCodec});
    const contender = kind === 'memory' ? repository : new JsonlEventRepository({rootDir:root,codec:typedEventCodec});
    await repository.append('run',{type:'initial'});
    const tail = await repository.tail('run');
    let enter,release;
    const entered = new Promise(resolve => {enter=resolve;});
    const gate = new Promise(resolve => {release=resolve;});
    let published = false, takenOver = false;
    const publication = repository.withDriverGeneration('run',0,async () => {
      enter();
      await gate;
      await assert.rejects(repository.append('run',{type:'reentrant'}),/inside ownership/);
      if (kind === 'jsonl') await assert.rejects(contender.append('run',{type:'reentrant'}),/inside ownership/);
      published = true;
    });
    await entered;
    const takeover = contender.appendConditional('run',{type:'takeover'},{expectedTail:tail,driverGeneration:1,idempotencyKey:'takeover'}).then(result => {assert(published);takenOver=true;return result;});
    await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(takenOver,false);
    release();
    await publication;
    assert.equal((await takeover).kind,'committed');
    await assert.rejects(repository.withDriverGeneration('run',0,async () => {throw new Error('must not run');}),/ownership was lost/);
    assert.equal((await repository.readRange('run')).records.length,2);
  });
}
