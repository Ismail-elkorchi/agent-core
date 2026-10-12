import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRunCoordinator, AgentSession, InMemorySessionRepository, agentEventCodec } from '@agent-core/runtime';

async function fixture(scheduling = 'automatic') {
  const binding = { schemaId: 'test/session-observer', schemaVersion: 1, subject: {} };
  const repository = new InMemorySessionRepository();
  const descriptor = await repository.create({ id: 'observer', binding });
  const controls = [];
  const session = new AgentSession({
    descriptor,
    scheduling,
    expectedBinding: binding,
    repository,
    runs: new AgentRunCoordinator(new InMemoryEventRepository(agentEventCodec), new InMemoryArtifactRepository()),
    configuration: { provider: 'test', model: 'first' },
    createRuntime() {
      return {
        run({ runId }) {
          const completion = Promise.withResolvers();
          const result = { state: 'ended', terminal: { runId }, deliveryDiagnostics: [] };
          const control = { runId, result: completion.promise, abort() { completion.resolve(result); }, finish() { completion.resolve(result); } };
          controls.push(control);
          return control;
        }
      };
    }
  });
  return { session, repository, descriptor, controls };
}

test('session observers can await inspect and configure after committed configuration', { timeout: 2000 }, async () => {
  const { session } = await fixture();
  const observed = Promise.withResolvers();
  session.subscribe(async (event) => {
    if (event.type !== 'configuration.changed' || event.configuration.responseFormat !== 'json') return;
    assert.equal((await session.inspect()).session.configuration.responseFormat, 'json');
    await session.configure({ responseFormat: 'text' });
    observed.resolve();
  }, observed.reject);
  await session.configure({ responseFormat: 'json' });
  await observed.promise;
  assert.equal(session.state().configuration.responseFormat, 'text');
  await session.close();
});

test('a never-settling observer cannot block execution, settlement, other observers or close', { timeout: 2000 }, async () => {
  const { session, controls, repository, descriptor } = await fixture();
  session.subscribe(() => new Promise(() => {}), assert.fail);
  const received = [];
  session.subscribe((event) => received.push(event.type), assert.fail);
  await session.configure({ responseFormat: 'json' });
  const first = await session.submit({ task: 'first' });
  const second = await session.submit({ task: 'second' });
  assert.equal(first.kind, 'started');
  assert.equal(second.kind, 'queued');
  controls[0].finish();
  await first.completion;
  await setImmediate();
  assert.equal(controls.length, 2);
  await session.close();
  await second.completion;
  assert.deepEqual(await repository.loadPendingSubmissions(descriptor), []);
  assert.equal(received.filter((type) => type === 'run.completed').length, 2);
});

test('session observer overflow reports a gap and permits authoritative inspection', { timeout: 2000 }, async () => {
  const { session } = await fixture();
  const blocked = Promise.withResolvers();
  const recovered = Promise.withResolvers();
  const received = [];
  session.subscribe(async (event) => {
    received.push(event.type);
    if (received.length === 1) await blocked.promise;
    if (event.type === 'delivery.gap') recovered.resolve((await session.inspect()).session);
  }, recovered.reject);
  await session.configure({ responseFormat: 'text' });
  for (let index = 0; index < 100; index++) await session.configure({ responseFormat: { type: 'json_schema', schema: { title: `schema-${index}` } } });
  blocked.resolve();
  assert.equal((await recovered.promise).configuration.responseFormat.schema.title, 'schema-99');
  assert.deepEqual(received, ['configuration.changed', 'delivery.gap']);
  await session.close();
});

test('a session observer can close its session without joining its own delivery', { timeout: 2000 }, async () => {
  const { session } = await fixture();
  const closed = Promise.withResolvers();
  session.subscribe(async () => {
    await session.close();
    closed.resolve();
  }, closed.reject);
  await session.configure({ responseFormat: 'json' });
  await closed.promise;
  await assert.rejects(session.configure({ responseFormat: 'text' }), /closed/u);
});

test('run completion observers read committed submission settlement', { timeout: 2000 }, async () => {
  const { session, controls } = await fixture();
  const settled = Promise.withResolvers();
  session.subscribe(async (event) => {
    if (event.type === 'run.completed') {
      assert.equal(session.state().phase, 'idle');
      settled.resolve(await session.inspect());
    }
  }, settled.reject);
  const submission = await session.submit({ task: 'complete' });
  controls[0].finish();
  await submission.completion;
  const inspection = await settled.promise;
  assert.equal(inspection.session.phase, 'idle');
  assert.deepEqual(inspection.pendingSubmissions, []);
  await session.close();
});

test('permanent refresh failure rejects waiting completion and isolates failing failure handlers', { timeout: 2000 }, async () => {
  const { session, repository } = await fixture('manual');
  const failed = Promise.withResolvers();
  session.subscribe(() => new Promise(() => {}), () => {
    throw new Error('observer failure handler threw');
  });
  session.subscribe(() => {}, (error) => {
    failed.resolve(error);
    return Promise.reject(new Error('observer failure handler rejected'));
  });
  const submitted = await session.submit({ task: 'queued' });
  assert.equal(submitted.kind, 'queued');
  let reads = 0;
  repository.loadPendingSubmissions = async () => {
    reads++;
    throw new Error('permanent read failure');
  };
  await assert.rejects(submitted.completion, /permanent read failure/u);
  assert.match((await failed.promise).message, /permanent read failure/u);
  await session.close();
  assert.equal(reads, 1);
});
