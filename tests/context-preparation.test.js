import test from 'node:test';
import assert from 'node:assert/strict';
import { conservativeProtocolCapabilities, compileModelRequest, ModelProviderError } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, AgentSession, AgentRunCoordinator, ContextService, HistoryReader, InMemorySessionRepository, InMemoryInferenceRepository, InferenceService, agentEventCodec } from '@agent-core/runtime';

const marker = 'Prepare a fresh context for the same ongoing work';
const transient = () => new ModelProviderError({ provider: 'preparation-fixture', code: 'provider_unavailable', message: 'Temporary compiler outage.', retryable: true });

async function fixture({ compileFailure, onProgress, automatic = true } = {}) {
  const sessions = new InMemorySessionRepository();
  const descriptor = await sessions.create({ binding: { schemaId: 'preparation-tests', schemaVersion: 1, subject: {} } });
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  const history = new HistoryReader({ repository: sessions, session: descriptor, events, artifacts });
  const repository = new InMemoryInferenceRepository();
  const compilations = [];
  const generations = [];
  const admissions = [];
  const provider = {
    id: 'preparation-fixture', implementationId: 'preparation-fixture@1',
    describe: () => ({ id: 'preparation-fixture', displayName: 'Preparation fixture', defaultModel: 'fixture' }),
    describeModel: async () => ({ id: 'fixture', provider: 'preparation-fixture',
      capabilities: { protocol: conservativeProtocolCapabilities('fixture://preparation', { contextReset: 'fresh_request' }), streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 64000, outputTokens: 1024 }, supportedParameters: ['tools', 'maxOutputTokens'] }),
    compileRequest: async request => {
      const control = request.messages.some(m => m.content.includes(marker));
      compilations.push({ control, request });
      await compileFailure?.({ control, request, count: compilations.filter(item => item.control === control).length });
      const { signal: _signal, ...body } = request;
      return compileModelRequest({ request, body, profile: await provider.describeModel(), endpoint: 'fixture://preparation', providerInputTokens: control ? 200 : 100 });
    },
    complete: async request => {
      generations.push(request);
      return { provider: 'preparation-fixture', model: 'fixture', content: '4', terminationReason: 'stop' };
    }
  };
  const options = () => {
    const context = new ContextService({ repository: sessions, session: descriptor, history, artifacts, policy: { maxSourceBytes: 100000, historyRead: { history, isAvailable: () => true } } });
    return { provider, model: 'fixture', context, contextRenewal: { automatic },
      repositories: { events, artifacts, session: { repository: sessions, descriptor } },
      tools: context.toolDefinitions(), toolPolicy: { allowedRisks: ['read', 'write'] },
      toolBoundary: { authorizationPolicyId: 'preparation-tests', executionTargetId: 'preparation-tests' }, maxOutputTokens: 512,
      inferenceService: new InferenceService({ provider, artifacts, repository, admitRequest: compiled => { admissions.push(compiled); } }),
      ...(onProgress ? { onProgress } : {}) };
  };
  const records = async runId => { const log = []; for await (const { event } of events.read(runId)) log.push(event); return log; };
  return { options, sessions, descriptor, events, artifacts, compilations, generations, admissions, records };
}

for (const failControl of [true, false]) {
  test(`one transient ${failControl ? 'checkpoint probe' : 'ordinary'} compilation failure retries before generation`, async () => {
    const f = await fixture({ compileFailure: ({ control, count }) => { if (control === failControl && count === 1) throw transient(); } });
    const result = await new AgentRuntime(f.options()).run({ runId: 'transient', task: 'What is 2 + 2?' }).result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(f.compilations.filter(item => item.control === failControl).length, 2);
    assert.equal(f.generations.length, 1);
    assert.equal((await f.records('transient')).filter(event => event.type === 'model.requested').length, 1);
    if (failControl) assert.ok(f.admissions.length >= 2, 'Ordinary request is re-admitted; failed probe cannot establish a reserve.');
  });
}

test('persistent retryable probe failure suspends durably and resumes after compiler recovery', async () => {
  let unavailable = true;
  const f = await fixture({ compileFailure: ({ control }) => { if (control && unavailable) throw transient(); } });
  const result = await new AgentRuntime(f.options()).run({ runId: 'persistent', task: 'What is 2 + 2?' }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.reason, 'context_admission');
  assert.equal(result.contextAdmission.kind, 'request_preparation');
  assert.equal(result.contextAdmission.recovery, 'request_unavailable');
  assert.ok(result.contextAdmission.actions.includes('retry'));
  assert.equal(f.compilations.filter(item => item.control).length, 3);
  assert.equal(f.generations.length, 0);
  assert.ok(!(await f.records('persistent')).some(event => event.type === 'run.ended'));
  unavailable = false;
  const resumed = await new AgentRuntime(f.options()).resume('persistent').result;
  assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
  assert.equal(f.generations.length, 1);
});

test('cancellation during preparation retry prevents another compile or generation', async () => {
  const abort = new AbortController();
  const f = await fixture({ compileFailure: ({ control }) => { if (control) throw transient(); },
    onProgress: event => { if (event.type === 'assistant.status' && event.message.startsWith('Request preparation')) abort.abort('Cancel retry.'); } });
  const result = await new AgentRuntime(f.options()).run({ runId: 'cancel', task: 'What is 2 + 2?', signal: abort.signal }).result;
  assert.equal(result.terminal?.executionStatus, 'aborted', JSON.stringify(result));
  assert.equal(f.compilations.filter(item => item.control).length, 1);
  assert.equal(f.generations.length, 0);
});

test('preparation retry refreshes accepted sources before measuring reserve and dispatching', async () => {
  let f;
  f = await fixture({ compileFailure: ({ control, count }) => { if (control && count === 1) throw transient(); },
    onProgress: async event => {
      if (event.type === 'assistant.status' && event.message.startsWith('Request preparation'))
        await f.sessions.appendInput(f.descriptor, { runId: 'correction', task: 'NEW SOURCE: include this accepted correction.' });
    } });
  const result = await new AgentRuntime(f.options()).run({ runId: 'invalidation', task: 'What is 2 + 2?' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  const probes = f.compilations.filter(item => item.control);
  assert.ok(!probes[0].request.messages.some(m => m.content.includes('NEW SOURCE')));
  assert.ok(probes[1].request.messages.some(m => m.content.includes('NEW SOURCE')));
  assert.ok(f.generations[0].messages.some(m => m.content.includes('NEW SOURCE')));
});

for (const error of [new Error('Compiler invariant failed.'), new ModelProviderError({ provider: 'preparation-fixture', code: 'invalid_request', message: 'Unsupported compilation.', retryable: false })]) {
  test(`permanent ${error.name} is not retried or converted to suspension`, async () => {
    const f = await fixture({ compileFailure: ({ control }) => { if (control) throw error; } });
    const result = await new AgentRuntime(f.options()).run({ runId: 'permanent', task: 'What is 2 + 2?' }).result;
    assert.equal(result.terminal?.executionStatus, 'failed', JSON.stringify(result));
    assert.equal(f.compilations.filter(item => item.control).length, 1);
    assert.equal(f.generations.length, 0);
  });
}

test('elapsed run limit interrupts preparation backoff without dispatch', async () => {
  const f = await fixture({ compileFailure: ({ control }) => { if (control) throw transient(); } });
  const result = await new AgentRuntime({ ...f.options(), limits: { elapsedMs: 100 } }).run({ runId: 'deadline', task: 'What is 2 + 2?' }).result;
  assert.equal(result.terminal?.executionStatus, 'failed', JSON.stringify(result));
  assert.equal(result.terminal?.terminationReason, 'limit_exhausted');
  assert.equal(f.generations.length, 0);
  assert.ok(f.compilations.filter(item => item.control).length <= 1);
});

test('driver fencing is rechecked before retrying preparation', async t => {
  let replaced = false;
  const f = await fixture({ compileFailure: ({ control }) => { if (control) throw transient(); },
    onProgress: event => { if (event.type === 'assistant.status' && event.message.startsWith('Request preparation')) replaced = true; } });
  const tail = f.events.tail.bind(f.events);
  t.mock.method(f.events, 'tail', async (...args) => {
    const value = await tail(...args);
    return replaced ? { ...value, driverGeneration: value.driverGeneration + 1 } : value;
  });
  await assert.rejects(new AgentRuntime(f.options()).run({ runId: 'fenced', task: 'What is 2 + 2?' }).result,
    { name: 'AgentRunOwnershipLostError' });
  assert.equal(f.compilations.filter(item => item.control).length, 1);
  assert.equal(f.generations.length, 0);
});


test('session preparation suspension exposes ordinary resume and restores that action durably', async t => {
  let unavailable = true;
  const f = await fixture({ compileFailure: ({ control }) => { if (control && unavailable) throw transient(); } });
  const options = {
    descriptor: f.descriptor, repository: f.sessions,
    expectedBinding: { schemaId: 'preparation-tests', schemaVersion: 1, subject: {} },
    configuration: { provider: 'preparation-fixture', model: 'fixture' },
    runs: new AgentRunCoordinator(f.events, f.artifacts),
    createRuntime: (_configuration, onProgress) => new AgentRuntime({ ...f.options(), onProgress })
  };
  const session = new AgentSession(options);
  t.after(() => session.close());
  const submission = await session.submit({ task: 'What is 2 + 2?' });
  assert.equal((await submission.completion).state, 'suspended');
  const suspension = session.inspectSuspension();
  assert.equal(suspension.contextAdmission.kind, 'request_preparation');
  assert.deepEqual(suspension.actions, ['resume', 'context', 'abort']);
  assert.deepEqual((await f.sessions.loadPendingSubmissions(f.descriptor))[0].suspension.actions, suspension.actions);
  unavailable = false;
  const result = await session.resumeContextAdmission(suspension.runId);
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(f.generations.length, 1);
});
