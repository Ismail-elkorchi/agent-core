import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as z from 'zod';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { defineTool } from '@agent-core/tools';
import {
  AgentRuntime, ContextService, HistoryReader, InferenceService, InMemoryInferenceRepository,
  InMemoryMaterialGrantProvider, InMemoryMaterialRepository, InMemorySessionRepository,
  ScopedMaterialService, agentEventCodec
} from '@agent-core/runtime';
import { admitContext } from './context-admission-fixtures.js';

class Socket extends EventEmitter {
  readyState = 1;
  constructor(dispatch, errors) { super(); this.dispatch = dispatch; this.errors = errors; }
  send(data) { try { this.dispatch(JSON.parse(data), this); } catch (error) { this.errors.push(error); throw error; } }
  feed(...events) { for (const event of events) this.emit('message', JSON.stringify(event)); }
  close() { this.readyState = 3; }
}

const remembered = 'SELECTED-MATERIAL: preserve the original inspection evidence';
const correction = 'CORRECTION: report the original tool result exactly once';
const reasoning = { type: 'reasoning', id: 'reasoning-original', encrypted_content: 'opaque-original-reasoning', summary: [] };
const call = { type: 'function_call', call_id: 'inspection-original', name: 'inspect', arguments: '{}' };
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const response = (id, output) => ({ id, model: 'gpt-6-astra', status: 'completed', output,
  usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } });

async function selectedMaterial(kind) {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding: { schemaId: 'tests/material-native-fallback', schemaVersion: 1, subject: {} } });
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  const history = new HistoryReader({ repository: sessions, session, artifacts, events });
  const cut = await history.capture();
  const owner = kind === 'session'
    ? { kind: 'session', sessionId: cut.sessionId, branchId: cut.branchId }
    : { kind: 'scope', scopeId: 'private-material' };
  const repository = new InMemoryMaterialRepository();
  const grants = new InMemoryMaterialGrantProvider([{ owner, revision: 'grant-1', read: true, write: true }]);
  const context = new ContextService({ repository: sessions, session, artifacts, history,
    materials: { repository, artifacts, grants }, policy: { maxSourceBytes: 1000000 }, assertStateWrite: async () => {} });
  const materials = new ScopedMaterialService({ repository, artifacts, history, sessionRepository: sessions,
    session, grants, assertWrite: async () => {} });
  const requestRef = await artifacts.storeProtected({ label: 'producer-request', content: Buffer.from('{}') });
  const batch = { owner, idempotencyKey: 'save-material', branchId: cut.branchId, capturedHistoryCut: cut,
    inference: { ownerId: 'producer', invocationId: 'producer', requestRef }, operations: [{ kind: 'create', text: remembered }] };
  const saved = kind === 'session' ? await context.saveSessionState(batch) : await materials.save(batch);
  const ref = saved.revisions[0];
  const selection = { retained: [], ...(kind === 'session' ? { sessionState: [ref] } : { materials: [{ ...ref, owner }] }) };
  await context.transition({ expectedWindowId: null, expectedSourceRevision: (await history.capture()).sourceRevision,
    idempotencyKey: 'select-material', reason: 'Use exact selected material', renewal: true, selection }, { admit: admitContext });
  return { sessions, session, artifacts, events, context };
}

for (const kind of ['session', 'scope']) {
  test(`${kind} material uses governed OpenAI websocket requests without losing steering, reasoning or tool replay`, { timeout: 30000 }, async t => {
    const state = await selectedMaterial(kind);
    const frames = [];
    const socketErrors = [];
    const provider = new OpenAIProvider({ apiKey: 'fixture', transport: 'websocket', streamIdleTimeoutMs: 1000,
      fetch: async () => { throw new Error('This deterministic qualification must not use the network.'); },
      webSocketFactory: () => new Socket((body, socket) => {
        frames.push(body);
        assert.equal(body.type, 'response.create', 'Governed fallback must not submit native steering frames');
        assert.equal(body.previous_response_id, undefined, 'Each OpenAI fallback request owns its governed full replay');
        assert.match(JSON.stringify(body.input), /SELECTED-MATERIAL/);
        const id = `response-${frames.length}`;
        socket.feed({ type: 'response.created', response: { id } });
        if (frames.length === 1) {
          socket.feed({ type: 'response.output_text.delta', response_id: id, delta: 'Inspecting.' },
            { type: 'response.completed', response: response(id, [reasoning, message('Inspecting.'), call]) });
        } else {
          assert.deepEqual(body.input.filter(item => item.type === 'reasoning'), [reasoning],
            'Opaque provider reasoning must survive governed continuation and durable session replay');
          assert.deepEqual(body.input.filter(item => item.type === 'function_call'), [call]);
          const results = body.input.filter(item => item.type === 'function_call_output');
          assert.equal(results.length, 1);
          assert.equal(results[0].call_id, call.call_id);
          assert.deepEqual(JSON.parse(results[0].output), { value: 'original inspection result' });
          assert.equal(body.input.filter(item => typeof item.content === 'string' && item.content.includes(correction)).length, 1,
            'The accepted correction must be delivered once at the next governed request boundary');
          socket.feed({ type: 'response.completed', response: response(id, [message('Inspection complete.')]) });
        }
      }, socketErrors) });
    let effects = 0;
    const inspect = defineTool({ name: 'inspect', implementationId: 'tests/material-native-inspect@1', description: 'Inspect evidence',
      schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
      effectEnvelope: { accesses: [{ mode: 'read', scope: 'evidence' }], lockScopes: [] },
      canonicalizeInput: value => value,
      deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'evidence' }], lockScopes: [], recovery: { kind: 'unknown' } }),
      invoke: async () => { effects++; return { kind: 'result', output: { value: 'original inspection result' }, summary: 'original inspection result',
        scope: { resources: ['evidence'], coverage: 'complete' } }; }
    });
    const inferences = new InMemoryInferenceRepository();
    const inference = new InferenceService({ provider, repository: inferences, artifacts: state.artifacts });
    const options = { provider, model: 'gpt-6-astra', inferenceService: inference, inferenceOwnerId: 'material-owner',
      context: state.context, maxOutputTokens: 128, tools: [inspect],
      repositories: { artifacts: state.artifacts, events: state.events, session: { repository: state.sessions, descriptor: state.session } },
      toolBoundary: { authorizationPolicyId: 'tests/material-native', executionTargetId: 'tests/material-native' } };
    let handle;
    const runtime = new AgentRuntime({ ...options, onProgress: event => {
      if (event.type === 'assistant.delta' && event.accumulated === 'Inspecting.')
        handle.injectSteering({ instruction: correction, deliveryId: 'one-correction' });
    } });
    t.after(() => runtime.close());
    handle = runtime.run({ runId: 'first-material-run', task: 'Inspect the original evidence' });
    const first = await handle.result;
    assert.deepEqual(socketErrors, []);
    assert.equal(first.terminal?.executionStatus, 'completed', JSON.stringify(first));
    assert.equal(frames.length, 2);
    assert.equal(effects, 1);
    const records = [];
    for await (const { event } of state.events.read('first-material-run')) records.push(event);
    assert.equal(records.filter(event => event.type === 'input.steering.local_applied').length, 1);
    assert.equal(records.filter(event => event.type === 'input.steering.delivery').length, 0,
      'An unsent native correction must never be classified as uncertain delivery');
    const owner = await inferences.load('material-owner');
    assert.equal(owner.latestInvocation.start.operation, 'generation');
    const admitted = await inference.admittedInput('material-owner', owner.latestInvocation.start.invocationId);
    assert.ok(admitted.presentation.materialDependencies.length > 0, 'Both material owners must retain live dispatch dependencies');
    await runtime.close();
    const restored = new AgentRuntime(options);
    t.after(() => restored.close());
    const next = await restored.run({ runId: 'restored-material-run', task: 'Explain the preserved inspection' }).result;
    assert.deepEqual(socketErrors, []);
    assert.equal(next.terminal?.executionStatus, 'completed', JSON.stringify(next));
    assert.equal(frames.length, 3);
    assert.equal(effects, 1, 'Restoring typed tool history must not repeat the original effect');
  });
}
