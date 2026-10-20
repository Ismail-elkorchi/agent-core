import assert from 'node:assert/strict';
import test from 'node:test';
import { conservativeProtocolCapabilities } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, ContextService, HistoryReader, InMemorySessionRepository, InferenceService,
  agentEventCodec, createHistoryTools, sessionStateItemContentSchema, sessionStateBatchSchema } from '@agent-core/runtime';
const stateText = state => state.items[0]?.text ?? '';
async function fixture() {
  const artifacts = new InMemoryArtifactRepository();
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding: { schemaId: 'state-attribution', schemaVersion: 1, subject: {} } });
  const events = new InMemoryEventRepository(agentEventCodec);
  const history = new HistoryReader({ repository: sessions, session, artifacts, events });
  const context = new ContextService({ repository: sessions, session, artifacts, history,
    policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } } });
  return { artifacts, sessions, session, events, history, context };
}

test('normal inference supplies selected view and exact request attribution to the admitted context transition', async (t) => {
  const f = await fixture(t);
  const requests = [];
  const events = f.events;
  const provider = {
    id: 'fixture',
    implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture' }),
    describeModel: async () => ({
      id: 'fixture',
      provider: 'fixture',
      capabilities: {
        protocol: conservativeProtocolCapabilities('https://fixture.example', { contextReset: 'fresh_request', inputKinds: ['text', 'tool_call', 'tool_result'], toolChoice: ['auto', 'none', 'required', 'named'] }),
        streaming: false,
        toolCalling: true,
        supportedToolInputs: [{ kind: 'json' }],
        jsonMode: false,
        jsonSchema: false,
        logprobs: false,
        temperature: false,
        topP: false
      },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 100_000, outputTokens: 1024 },
      supportedParameters: ['tools', 'maxOutputTokens']
    }),
    complete: async (request) => {
      requests.push(request);
      return requests.length === 1
        ? {
            provider: 'fixture',
            model: 'fixture',
            content: '',
            terminationReason: 'tool_calls',
            toolCalls: [
              {
                type: 'function',
                id: 'update',
                name: 'context_save_and_activate',
                input: { kind: 'json', value: { operations: [{ kind: 'create', text: 'Purpose and scoped feedback' }], reason: 'Useful understanding' } }
              }
            ]
          }
        : {
            provider: 'fixture',
            model: 'fixture',
            content: 'Answered the current question.',
            terminationReason: 'stop'
          };
    }
  };
  const inference = InferenceService.inMemory({ provider });
  const runtime = new AgentRuntime({
    provider,
    model: 'fixture',
    context: f.context,
    inferenceService: inference,
    tools: [...f.context.toolDefinitions(), ...createHistoryTools({ history: f.history })],
    maxOutputTokens: 512,
    repositories: {
      events,
      artifacts: f.artifacts,
      session: { repository: f.sessions, descriptor: f.session }
    },
    toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
    toolPolicy: { allowedRisks: ['read', 'write'] }
  });
  const result = await runtime.run({ task: 'Explain the proposal.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.ok(requests[1].messages.some((x) => x.content?.includes('Purpose and scoped feedback')), JSON.stringify(requests[1].messages));
  const state = await f.context.sessionState();
  const { itemId, revisionId } = state.items[0];
  const original = JSON.parse(
    new TextDecoder().decode(
      await inference.options.artifacts.readVerified((await f.sessions.readSessionStateItem(f.session, { itemId, revisionId })).inference.requestRef)
    )
  );
  assert.equal(original.stateSelectionId, null);
  assert.equal(
    original.logical.messages.some((x) => x.content === 'Explain the proposal.'),
    true
  );
  assert.equal(stateText(state), 'Purpose and scoped feedback');
  for await (const record of events.read(result.runId)) {
    if (record.event.type !== 'inference.request.fingerprinted') continue;
    const { stateSelectionId, ...incompatible } = record.event.fingerprint;
    assert.ok(stateSelectionId === null || typeof stateSelectionId === 'string');
    assert.throws(
      () => agentEventCodec.decode({ ...record.event, fingerprint: incompatible }),
      /stateSelectionId/
    );
  }
});

test('captured state attribution validates its binding without imposing tool-JSON quotas on recorded input', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const requestRef = await artifacts.storeProtected({
    label: 'large-recorded-inference',
    mediaType: 'application/json',
    content: new TextEncoder().encode(
      JSON.stringify({
        stateSelectionId: null,
        capturedHistoryCut: { format: 'agent-core.history/1', sessionId: 'session', branchId: 'session', throughEntryId: null, sourceRevision: 0, ledgerCoverage: 'session' },
        body: Array.from({ length: 25000 }, (_, i) => ({ original: i }))
      })
    )
  });
  const inference = new InferenceService({
    provider: {},
    artifacts,
    repository: { load: async () => ({ invocation: { start: { requestRef } } }) }
  });
  const origin = await inference.sessionStateOrigin('owner', 'invocation');
  assert.equal(origin.stateSelectionId, null);
  assert.equal(origin.inference.requestRef, requestRef);
});

test('narrative item content is owned and immutable with exact source association and whitespace', () => {
  const source = { sessionId: 's', entryId: 'e', sha256: 'a'.repeat(64) };
  const text = '文😀\nExact whitespace.  ';
  const input = { text, sources: [source] };
  const content = sessionStateItemContentSchema.parse(input);
  input.text = 'Mutated'; source.entryId = 'changed';
  assert.deepEqual(content, { text, sources: [{ sessionId: 's', entryId: 'e', sha256: 'a'.repeat(64) }] });
  assert.ok(Object.isFrozen(content));
  assert.ok(Object.isFrozen(content.sources));
  assert.ok(Object.isFrozen(content.sources[0]));
});

test('item contracts reject retired whole-body aliases, unknown claims and malformed sources', () => {
  for (const value of [{ blocks: [] }, { text: '' }, { text: 1 }, { text: 'x', authority: true },
    { text: 'x', status: 'active' }, { text: 'x', sources: 'not references' }])
    assert.equal(sessionStateItemContentSchema.safeParse(value).success, false, JSON.stringify(value));
  assert.equal(sessionStateBatchSchema.safeParse({ blocks: [{ text: 'old' }] }).success, false);
  const source = { sessionId: 's', entryId: 'e', sha256: 'a'.repeat(64) };
  assert.equal(sessionStateItemContentSchema.parse({ text: 'Evidence', sources: Array(256).fill(source) }).sources.length, 256);
  assert.equal(sessionStateItemContentSchema.safeParse({ text: 'Evidence', sources: Array(257).fill(source) }).success, false);
});

test('UTF-8 item edits preserve exact unedited bytes and reject overlap or split code points', async () => {
  const f = await fixture();
  const context = new ContextService({ repository: f.sessions, session: f.session, artifacts: f.artifacts,
    history: f.history, assertStateWrite: async () => {}, policy: { maxSourceBytes: 8192 } });
  const cut = await f.history.capture();
  const requestRef = await f.artifacts.storeProtected({ label: 'inference', content: Buffer.from('{}') });
  const batch = (idempotencyKey, operations) => ({ idempotencyKey, owner: { kind: 'session', sessionId: cut.sessionId, branchId: cut.branchId }, branchId: cut.branchId,
    capturedHistoryCut: cut, inference: { ownerId: 'owner', invocationId: 'inference', requestRef }, operations });
  const saved = await context.saveSessionState(batch('original', [{ kind: 'create', text: 'A文😀Z' }]));
  const ref = saved.revisions[0];
  assert.equal((await context.readSessionState({ ...ref, range: { offset: 1, bytes: 7 } })).text, '文😀');
  await assert.rejects(context.readSessionState({ ...ref, range: { offset: 2, bytes: 2 } }));
  const edit = edits => [{ kind: 'edit', itemId: ref.itemId, expectedRevisionId: ref.revisionId, edits }];
  const one = await context.stageSessionState(batch('one', edit([{ offset: 1, bytes: 3, text: '中' }])));
  const two = await context.stageSessionState(batch('two', edit([
    { offset: 8, bytes: 1, text: '!' }, { offset: 0, bytes: 1, text: '?' }
  ])));
  const stagedText = async staged => (await context.selectedSessionState(staged.revisions.map(({ itemId, revisionId }) => ({ itemId, revisionId })), cut, staged)).items[0].text;
  assert.equal(await stagedText(one), 'A中😀Z');
  assert.equal(await stagedText(two), '?文😀!');
  await assert.rejects(context.stageSessionState(batch('overlap', edit([
    { offset: 1, bytes: 7, text: '' }, { offset: 4, bytes: 4, text: '' }
  ]))), /overlap/);
  await assert.rejects(context.stageSessionState(batch('split', edit([{ offset: 2, bytes: 2, text: '' }]))));
  await assert.rejects(context.stageSessionState(batch('empty', edit([{ offset: 0, bytes: 9, text: '' }]))), /remove/);
  assert.equal((await context.readSessionState(ref)).text, 'A文😀Z', 'preparing edits and rejecting invalid edits cannot mutate saved content');
});
