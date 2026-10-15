import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeProvider } from '@agent-core/provider-claude';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, ContextService, HistoryReader, InferenceService, InMemoryInferenceRepository, agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

async function fixture(t, { reset = 'fresh_request', automatic = false, pressure = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fresh-native-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  let sessions = new JsonlSessionRepository(root);
  const session = await sessions.create({ binding: { schemaId: 'test/fresh-context', schemaVersion: 1, subject: {} } });
  const profile = await new ClaudeProvider().describeModel('claude-sonnet-4-6');
  const calls = [];
  let renew = false;
  let instructions = 'Initial authority.';
  const provider = new ClaudeProvider({ apiKey: 'fixture', countTokens: true,
    modelProfiles: { [profile.id]: { ...profile, limits: { contextTokens: pressure ? 10000 : 100000, outputTokens: 1000 },
      capabilities: { ...profile.capabilities, streaming: false, protocol: { ...profile.capabilities.protocol,
        contextReset: reset, reasoningPrefix: 'messages_and_tools' } } } },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('count_tokens')) {
        const text = JSON.stringify(body);
        const checkpoint = text.includes('Prepare a fresh context for the same ongoing work');
        return Response.json({ input_tokens: pressure
          ? (text.includes('thinking-signature-1') ? 8500 : 1000) + (checkpoint ? 100 : 0)
          : Math.ceil(text.length / 4) });
      }
      calls.push(body);
      const transition = renew || (pressure && JSON.stringify(body).includes('Prepare a fresh context for the same ongoing work'));
      renew = false;
      return Response.json({ type: 'message', id: `message-${calls.length}`, role: 'assistant', model: profile.id,
        content: [{ type: 'thinking', thinking: 'Reasoning display', signature: `thinking-signature-${calls.length}` },
          ...(transition ? [{ type: 'tool_use', id: `renew-${calls.length}`, name: 'context_transition',
            input: { reason: 'Start a fresh source window.', retain: [],
              sessionState: { understanding: [{ id: 'finding', text: 'Model interpretation retained explicitly.' }] } } }]
            : [{ type: 'text', text: 'Answered.' }])],
        stop_reason: transition ? 'tool_use' : 'end_turn', usage: { input_tokens: 20, output_tokens: 10 } });
    } });
  const service = new InferenceService({ provider, artifacts, repository: new InMemoryInferenceRepository() });
  let context;
  const runtime = () => {
    const history = new HistoryReader({ repository: sessions, session, artifacts, events });
    context = new ContextService({ repository: sessions, session, artifacts, history,
      policy: { maxSourceBytes: 2 * 1024 * 1024, historyRead: { history, isAvailable: () => true } } });
    return new AgentRuntime({ provider, model: profile.id, context, contextRenewal: { automatic },
      inferenceService: service, inferenceOwnerId: 'owner', maxOutputTokens: 1000,
      instructions: () => [{ id: 'authority', role: 'system', content: instructions }], tools: context.toolDefinitions(),
      repositories: { artifacts, events, session: { repository: sessions, descriptor: session } },
      toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' }, toolPolicy: { allowedRisks: ['read', 'write'] } });
  };
  return { calls, runtime, service, session, context: () => context, sessions: () => sessions,
    renew: () => { renew = true; }, changeInstructions: () => { instructions = 'Changed authority.'; },
    reopen: () => { sessions = new JsonlSessionRepository(root); } };
}
async function completed(runtime, runId, task) {
  const result = await runtime.run({ runId, task }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  return result;
}

test('native reasoning remains exact across ordinary continuation and repository restart', async t => {
  const f = await fixture(t);
  await completed(f.runtime(), 'first', 'Original source evidence.');
  const first = f.calls[0];
  f.reopen();
  await completed(f.runtime(), 'second', 'Continue accepted work.');
  const next = f.calls.at(-1);
  assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages);
  assert.ok(JSON.stringify(next).includes('thinking-signature-1'));
  assert.equal(JSON.stringify(next).split('Continue accepted work.').length - 1, 1);
  assert.equal((await f.service.settledRunUsage('owner', 'second')).invocations, 1);
});

test('explicit fresh renewal replaces native reasoning only after tool settlement and preserves archive', async t => {
  const f = await fixture(t);
  await completed(f.runtime(), 'first', 'Original archived evidence.');
  f.renew();
  await completed(f.runtime(), 'renewed', 'Continue current work.');
  const next = JSON.stringify(f.calls.at(-1));
  assert.ok(!next.includes('thinking-signature-1'));
  assert.ok(!next.includes('thinking-signature-2'));
  assert.ok(next.includes('Model interpretation retained explicitly.'));
  assert.equal(JSON.stringify(f.calls).includes('"compaction"'), false);
  const window = (await f.context().inspect()).window;
  assert.equal(window.selection.continuity.kind, 'fresh');
  assert.equal(window.selection.strategy, undefined);
  const archive = await f.sessions().readConversation(f.session);
  assert.ok(JSON.stringify(archive).includes('Original archived evidence.'));
  assert.ok(JSON.stringify(archive).includes('thinking-signature-1'));
  f.reopen();
  await completed(f.runtime(), 'reopened', 'Continue after restart.');
  assert.ok(!JSON.stringify(f.calls.at(-1)).includes('thinking-signature-1'));
});

test('changed prefix-bound authority uses an admitted fresh window and preserves the native archive', async t => {
  const f = await fixture(t);
  await completed(f.runtime(), 'first', 'Keep original evidence.');
  f.changeInstructions();
  await completed(f.runtime(), 'changed', 'Continue accepted work.');
  const transitions = (await f.sessions().loadReplayState(f.session)).branch.filter(entry => entry.type === 'context_transition');
  assert.equal(transitions.length, 1, 'Native state may be dropped only through an explicit admitted transition');
  assert.equal(transitions[0].transition.admission.status, 'admitted');
  assert.ok(transitions[0].transition.admission.compiledInputIdentity);
  assert.equal(transitions[0].window.selection.continuity.kind, 'fresh');
  const body = JSON.stringify(f.calls.at(-1));
  assert.ok(body.includes('Changed authority.'));
  assert.ok(body.includes('Keep original evidence.'));
  assert.ok(body.includes('Continue accepted work.'));
  assert.ok(!body.includes('thinking-signature-1'));
  assert.ok(JSON.stringify(await f.sessions().readConversation(f.session)).includes('thinking-signature-1'));
  assert.equal(f.calls.length, 2, 'Fresh reset makes no auxiliary provider invocation');
});

test('unsupported fresh renewal does not publish state or discard native evidence', async t => {
  const f = await fixture(t, { reset: 'unsupported' });
  await completed(f.runtime(), 'first', 'Original source evidence.');
  f.renew();
  const result = await f.runtime().run({ runId: 'unsupported', task: 'Continue accepted work.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal((await f.context().inspect()).window, null);
  assert.equal((await f.context().sessionState()).revision, null);
  assert.equal(f.calls.length, 3);
  assert.ok(JSON.stringify(f.calls.at(-1)).includes('thinking-signature-1'));
});

test('a branch replays its original native prefix without the parent later input', async t => {
  const f = await fixture(t);
  await completed(f.runtime(), 'before-fork', 'Original request.');
  const point = (await f.sessions().readConversation(f.session)).filter(entry => entry.type === 'assistant').at(-1);
  await completed(f.runtime(), 'parent-only', 'Parent-only task.');
  await f.sessions().branchFrom(f.session, point.id, 'Earlier branch');
  f.reopen();
  await completed(f.runtime(), 'child', 'Child-only task.');
  const body = JSON.stringify(f.calls.at(-1));
  assert.ok(body.includes('Original request.'));
  assert.ok(body.includes('Child-only task.'));
  assert.ok(!body.includes('Parent-only task.'));
});

test('changed bound authority cannot discard native state when fresh reset is unsupported', async t => {
  const f = await fixture(t, { reset: 'unsupported' });
  await completed(f.runtime(), 'first', 'Keep native evidence.');
  f.changeInstructions();
  const result = await f.runtime().run({ runId: 'incompatible', task: 'Continue accepted work.' }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.reason, 'context_admission');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.context().inspect()).window, null);
  assert.ok(JSON.stringify(await f.sessions().readConversation(f.session)).includes('thinking-signature-1'));
});


test('automatic pressure checkpoint preserves signed reasoning prefix and full original conversation', async t => {
  const f = await fixture(t, { automatic: true, pressure: true });
  await completed(f.runtime(), 'original', 'Original detailed evidence must remain visible to preparation.');
  await completed(f.runtime(), 'pressure', 'Continue the same ongoing work.');
  const checkpoint = f.calls.find(call => JSON.stringify(call).includes('Prepare a fresh context for the same ongoing work'));
  assert.ok(checkpoint, 'Capacity pressure must dispatch a checkpoint');
  assert.deepEqual(checkpoint.system, f.calls[0].system, 'Checkpoint cannot edit signed reasoning authority prefix');
  assert.deepEqual(checkpoint.tools, f.calls[0].tools, 'Checkpoint cannot edit signed reasoning tool catalog');
  assert.deepEqual(checkpoint.messages.slice(0, f.calls[0].messages.length), f.calls[0].messages);
  const body = JSON.stringify(checkpoint);
  assert.ok(body.includes('thinking-signature-1'));
  assert.ok(body.includes('Original detailed evidence must remain visible to preparation.'));
  assert.ok(body.includes('Continue the same ongoing work.'));
  assert.ok(!JSON.stringify(f.calls.at(-1)).includes('thinking-signature-1'));
  assert.equal((await f.context().inspect()).window.selection.continuity.kind, 'fresh');
  assert.equal((await f.service.settledRunUsage('owner', 'pressure')).invocations, 2);
});
