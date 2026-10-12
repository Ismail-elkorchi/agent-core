import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeProvider } from '@agent-core/provider-claude';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  ContextService,
  HistoryReader,
  InferenceService,
  InMemoryInferenceRepository,
  agentEventCodec,
  createHistoryTools
} from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

async function fixture(
  t,
  { native = true, bound = true, capacity = 100000, transformFailure, onTransform, automatic = true, countInputTokens } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), 'native-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  let sessions = new JsonlSessionRepository(root);
  const session = await sessions.create({
    binding: { schemaId: 'test/native-context', schemaVersion: 1, subject: {} }
  });
  const profile = await new ClaudeProvider().describeModel('claude-sonnet-4-6');
  const calls = [];
  let generation = 0;
  let updateState = true;
  let instructions = 'Initial authority.';
  let extraTools = false;
  const definition = {
    ...profile,
    limits: { contextTokens: capacity, outputTokens: 1000 },
    capabilities: {
      ...profile.capabilities,
      streaming: false,
      protocol: {
        ...profile.capabilities.protocol,
        counting: 'provider',
        contextTransforms: native ? ['claude.compaction'] : [],
        ...(bound ? { reasoningPrefix: 'messages_and_tools' } : {})
      }
    }
  };
  const provider = new ClaudeProvider({
    apiKey: 'fixture',
    countTokens: true,
    modelProfiles: { [profile.id]: definition },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('count_tokens'))
        return Response.json({ input_tokens: countInputTokens?.(body) ?? Math.ceil(JSON.stringify(body).length / 4) });
      calls.push(body);
      if (body.compaction) {
        await onTransform?.();
        if (transformFailure) return new Response('temporarily unavailable', { status: 503 });
        return Response.json({
          type: 'message',
          id: `compact-${calls.length}`,
          role: 'assistant',
          model: profile.id,
          content: [
            {
              type: 'compaction',
              content: 'Preserved task evidence.',
              signature: `compact-signature-${calls.length}`
            }
          ],
          stop_reason: 'compaction',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            iterations: [{ type: 'compaction', input_tokens: 100, output_tokens: 30 }]
          }
        });
      }
      generation++;
      const update = updateState && generation <= 2;
      return Response.json({
        type: 'message',
        id: `message-${generation}`,
        role: 'assistant',
        model: profile.id,
        content: [
          {
            type: 'thinking',
            thinking: 'Reasoning display',
            signature: `thinking-signature-${generation}`
          },
          ...(update
            ? [
                {
                  type: 'tool_use',
                  id: `state-${generation}`,
                  name: 'context_transition',
                  input: {
                    reason: 'Revise useful understanding.',
                    workingState: generation === 1 ? 'Initial understanding.' : 'Revised understanding.'
                  }
                }
              ]
            : [{ type: 'text', text: 'Answered.' }])
        ],
        stop_reason: update ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 20, output_tokens: 10 }
      });
    }
  });
  // Every runtime uses the same governed service; replay reads the protected originals it owns.
  const service = new InferenceService({
    provider,
    artifacts,
    repository: new InMemoryInferenceRepository()
  });
  let context;
  const runtime = () => {
    const history = new HistoryReader({ repository: sessions, session, artifacts, events });
    context = new ContextService({
      repository: sessions,
      session,
      artifacts,
      history,
      policy: {
        maxSourceBytes: 2 * 1024 * 1024,
        historyRead: { history, isAvailable: () => true }
      }
    });
    return new AgentRuntime({
      provider,
      model: profile.id,
      context,
      contextRenewal: { automatic },
      inferenceService: service,
      inferenceOwnerId: 'owner',
      maxOutputTokens: 1000,
      instructions: () => [{ id: 'authority', role: 'system', content: instructions }],
      tools: [
        ...context.toolDefinitions(),
        ...(extraTools ? createHistoryTools({ history }) : [])
      ],
      repositories: {
        artifacts,
        events,
        session: { repository: sessions, descriptor: session }
      },
      toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
      toolPolicy: { allowedRisks: ['read', 'write'] }
    });
  };
  return {
    calls,
    runtime,
    service,
    session,
    context: () => context,
    sessions: () => sessions,
    capacity(value) {
      definition.limits.contextTokens = value;
    },
    changeInstructions(value) {
      instructions = value;
    },
    addTools() {
      extraTools = true;
    },
    async freshContinuation() {
      const cut = await context.history.capture();
      const window = await context.history.selectedContext(cut);
      const selection = await context.freshSelection({
        selection: await context.selectSources(cut, { retain: await context.protectedSources() }),
        model: { provider: profile.provider, model: profile.id },
        profile: definition,
        cut,
        resetId: 'explicit-test-fresh-continuation'
      });
      await context.transition({
        expectedWindowId: window?.windowId ?? null,
        expectedSourceRevision: cut.sourceRevision,
        idempotencyKey: 'explicit-test-fresh-continuation',
        reason: 'Explicitly choose fresh continuation while preserving accepted input.',
        selection
      });
    },
    restoreConfiguration() {
      instructions = 'Initial authority.';
      extraTools = false;
    },
    allowTransform() {
      transformFailure = false;
    },
    noUpdates() {
      updateState = false;
    },
    updateAgain() {
      generation = 0;
      updateState = true;
    },
    reopen() {
      sessions = new JsonlSessionRepository(root);
    }
  };
}

async function completed(runtime, runId, task) {
  const result = await runtime.run({ runId, task }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  return result;
}

test('prefix-bound reasoning preserves admitted state placement, tool results, restart and new user input', async (t) => {
  const f = await fixture(t, { native: false });
  await completed(f.runtime(), 'first', 'Inspect the project.');
  assert.equal(f.calls.length, 3);
  assert.equal((await f.context().workingState()).text, 'Revised understanding.');
  const first = f.calls[0];
  const second = f.calls[1];
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert(JSON.stringify(f.calls[2]).includes('Initial understanding.'));
  assert(JSON.stringify(f.calls[2]).includes('Revised understanding.'));
  const entries = await f.sessions().readConversation(f.session);
  assert(
    entries
      .filter((entry) => entry.type === 'assistant')
      .every((entry) => entry.inferenceInput?.visibility === 'protected')
  );
  f.reopen();
  await completed(f.runtime(), 'second', 'Now explain the change.');
  const last = f.calls.at(-1);
  assert.deepEqual(last.messages.slice(0, f.calls[2].messages.length), f.calls[2].messages);
  assert.equal(JSON.stringify(last).split('Now explain the change.').length - 1, 1);
});

for (const change of ['authority', 'tools']) {
  test(`native compaction lawfully replaces a bound ${change} before applying the new configuration`, async (t) => {
    const f = await fixture(t);
    await completed(f.runtime(), 'initial', 'Inspect the project.');
    const original = f.calls.at(-1);
    if (change === 'authority') f.changeInstructions('New required authority.');
    else f.addTools();
    f.reopen();
    await completed(f.runtime(), 'changed', 'Continue with the new configuration.');
    const transform = f.calls.find((call) => call.compaction);
    assert(transform, 'changed bound material needs a native transition');
    assert.deepEqual(transform.system, original.system);
    assert.deepEqual(transform.tools, original.tools);
    assert.deepEqual(transform.messages.slice(0, original.messages.length), original.messages);
    const successor = f.calls.at(-1);
    assert.equal(successor.messages[0].content[0].type, 'compaction');
    assert(!JSON.stringify(successor).includes('thinking-signature-1'));
    assert(JSON.stringify(successor).includes('Continue with the new configuration.'));
    if (change === 'authority')
      assert.equal(successor.system[0].text, 'New required authority.');
    else assert(successor.tools.length > original.tools.length);
    assert.equal((await f.context().workingState()).text, 'Revised understanding.');
    assert.equal((await f.service.settledRunUsage('owner', 'changed')).usage.promptTokens, 120);
    f.reopen();
    await completed(f.runtime(), 'reopened', 'Report status.');
    assert.equal(f.calls.filter((call) => call.compaction).length, 1);
    assert.equal(f.calls.at(-1).messages[0].content[0].type, 'compaction');
  });
}

// Exact provider counts make these boundary fixtures independent of control-tool schema text.
// Other tests retain byte-derived provider counts and assert actual compiled-request accounting.
function isRestrictedRecovery(body) {
  return JSON.stringify(body).includes('bounded context-management turn');
}
function capacityFixtureTokens(body) {
  if (isRestrictedRecovery(body)) return 100;
  const text = JSON.stringify(body);
  if (text.includes('Original detailed evidence.') || text.includes('Original evidence.'))
    return text.includes('Explain the result.') || text.includes('New input.') ? 8400 : 8000;
  return 2000;
}

for (const transformFailure of [false, true]) {
  test(`native capacity fallback ${transformFailure ? 'does not run while ordinary inference fits' : 'preserves protected input and records cost without working-state maintenance'}`, async (t) => {
    const f = await fixture(t, { bound: false, transformFailure, countInputTokens: capacityFixtureTokens });
    f.noUpdates();
    await completed(
      f.runtime(),
      'history',
      `Original detailed evidence. ${'repository evidence '.repeat(700)}`
    );
    const accounting = (await f.context().inspect()).admission.accounting;
    assert.equal(accounting.estimatedInputTokens, 8000);
    const capacity = accounting.estimatedInputTokens + (transformFailure ? 2500 : 1300);
    f.capacity(capacity);
    await completed(f.runtime(), 'renewed', `Explain the result. ${'New relevant input. '.repeat(100)}`);
    const transforms = f.calls.filter((call) => call.compaction);
    assert.equal(transforms.length, transformFailure ? 0 : 1);
    assert.equal(f.calls.filter(isRestrictedRecovery).length, 0);
    assert.ok(f.calls.filter(call => !call.compaction).every(call =>
      capacityFixtureTokens(call) + call.max_tokens <= capacity), 'No oversized ordinary request may be transported');
    assert.equal((await f.context().inspect()).admission.accounting.estimatedInputTokens, transformFailure ? 8400 : 2000);
    const last = f.calls.at(-1);
    assert(JSON.stringify(last).includes('Explain the result.'));
    assert.equal(JSON.stringify(last).split('Explain the result.').length - 1, 1);
    assert.equal((await f.context().workingState()).revision, null);
    if (transformFailure) {
      assert.equal((await f.context().inspect()).window, null);
      assert(JSON.stringify(last).includes('Original detailed evidence.'));

    } else {
      assert.equal(last.messages[0].content[0].type, 'compaction');
      assert(!JSON.stringify(last).includes('Original detailed evidence.'));
      assert.equal(
        (await f.service.settledRunUsage('owner', 'renewed')).usage.promptTokens,
        120
      );
      const window = (await f.context().inspect()).window;
      assert.equal(window.selection.strategy, 'provider');
      assert.equal(
        window.selection.protected,
        undefined,
        'temporary pending input is not promoted to permanent protection'
      );
      f.reopen();
      await completed(f.runtime(), 'after-restart', 'Continue after restart.');
      assert.equal(f.calls.filter((call) => call.compaction).length, 1);
      assert.equal(f.calls.at(-1).messages[0].content[0].type, 'compaction');
    }
  });
}

test('cancellation after native compaction settles records its cost without publishing the window', async (t) => {
  const abort = new AbortController();
  const f = await fixture(t, {
    bound: false,
    onTransform: () => abort.abort(new Error('User cancelled.'))
  });
  f.noUpdates();
  await completed(
    f.runtime(),
    'history',
    `Original evidence. ${'source evidence '.repeat(900)}`
  );
  f.capacity((await f.context().inspect()).admission.accounting.estimatedInputTokens + 1300);
  const result = await f
    .runtime()
    .run({ runId: 'cancelled-renewal', task: `Continue. ${'New relevant input. '.repeat(100)}`, signal: abort.signal }).result;
  assert.notEqual(result.terminal?.executionStatus, 'completed');
  assert.equal(f.calls.filter((call) => call.compaction).length, 1);
  assert.equal(f.calls.length, 2, 'no new generation starts after cancellation');
  assert.equal((await f.context().inspect()).window, null);
  assert.equal(
    (await f.service.settledRunUsage('owner', 'cancelled-renewal')).usage.promptTokens,
    100
  );
});

test('unavailable required compaction preserves the old window and does not dispatch an oversized request', async (t) => {
  const f = await fixture(t, { bound: false, transformFailure: true, countInputTokens: capacityFixtureTokens });
  f.noUpdates();
  await completed(
    f.runtime(),
    'history',
    `Original evidence. ${'source evidence '.repeat(900)}`
  );
  f.capacity((await f.context().inspect()).admission.accounting.estimatedInputTokens + 1300);
  const result = await f
    .runtime()
    .run({ runId: 'blocked-renewal', task: `New input. ${'details '.repeat(250)}` }).result;
  assert.notEqual(result.terminal?.executionStatus, 'completed');
  const ordinary = f.calls.filter(call => !call.compaction && !isRestrictedRecovery(call));
  assert.equal(ordinary.length, 1, 'No oversized ordinary successor may be transported');
  assert.equal(f.calls.filter(call => call.compaction).length, 1);
  assert.equal(f.calls.filter(isRestrictedRecovery).length, 1, 'A fitting bounded recovery request may follow failed compaction');
  assert.ok(!ordinary.some(call => JSON.stringify(call).includes('New input.')));
  assert.equal((await f.context().inspect()).window, null);
  assert.equal((await f.context().inspect()).admission.status, 'blocked');
});

test('a branch restores its selected bound inference rather than the parent’s later input', async (t) => {
  const f = await fixture(t, { native: false });
  await completed(f.runtime(), 'before-fork', 'Original request.');
  const point = (await f.sessions().readConversation(f.session))
    .filter((entry) => entry.type === 'assistant')
    .at(-1);
  await completed(f.runtime(), 'parent-only', 'Parent-only task.');
  await f.sessions().branchFrom(f.session, point.id, 'Earlier branch');
  f.reopen();
  await completed(f.runtime(), 'child', 'Child-only task.');
  const body = JSON.stringify(f.calls.at(-1));
  assert(body.includes('Original request.'));
  assert(body.includes('Child-only task.'));
  assert(!body.includes('Parent-only task.'));
  assert.equal((await f.context().workingState()).text, 'Revised understanding.');
});

test('repeated native renewal compacts the committed window without replaying the discarded archive', async (t) => {
  const f = await fixture(t, { bound: false });
  f.noUpdates();
  await completed(
    f.runtime(),
    'old',
    `Old archive marker. ${'old original evidence '.repeat(800)}`
  );
  f.capacity((await f.context().inspect()).admission.accounting.estimatedInputTokens + 1300);
  await completed(f.runtime(), 'compact-old', `Summarize the outcome. ${'New relevant input. '.repeat(100)}`);
  f.capacity(100000);
  await completed(
    f.runtime(),
    'recent',
    `Recent evidence marker. ${'recent original evidence '.repeat(800)}`
  );
  f.capacity((await f.context().inspect()).admission.accounting.estimatedInputTokens + 1300);
  await completed(f.runtime(), 'compact-recent', `Explain the new result. ${'New relevant input. '.repeat(100)}`);
  const transforms = f.calls.filter((call) => call.compaction);
  assert.equal(transforms.length, 2);
  assert.equal(transforms[1].messages[0].content[0].type, 'compaction');
  assert(JSON.stringify(transforms[1]).includes('Recent evidence marker.'));
  assert(!JSON.stringify(transforms[1]).includes('Old archive marker.'));
  f.reopen();
  await completed(f.runtime(), 'after-both', 'Continue.');
  assert.equal(f.calls.filter((call) => call.compaction).length, 2);
});

for (const kind of ['openai', 'openai-codex']) {
  test(`${kind} automatic renewal preserves its provider-native result and the current input exactly once`, async (t) => {
    const { OpenAIProvider } = await import('@agent-core/provider-openai');
    const { OpenAICodexProvider } = await import('@agent-core/provider-openai-codex');
    const root = await mkdtemp(path.join(tmpdir(), 'responses-renewal-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sessions = new JsonlSessionRepository(root);
    const session = await sessions.create({
      binding: { schemaId: 'test/responses-renewal', schemaVersion: 1, subject: {} }
    });
    const artifacts = new InMemoryArtifactRepository();
    const events = new InMemoryEventRepository(agentEventCodec);
    const calls = [];
    const model = 'gpt-6.1-sol';
    const nativeItem = { type: 'compaction', encrypted_content: 'opaque-renewal+/=' };
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith('/input_tokens'))
        return Response.json({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) });
      const compact =
        String(url).endsWith('/compact') || body.input.at(-1)?.type === 'compaction_trigger';
      calls.push({ body, compact });
      const output = compact
        ? [
            ...(kind === 'openai'
              ? body.input
                  .filter((item) => item.role === 'user')
                  .map((item) => ({
                    ...item,
                    type: 'message',
                    content:
                      typeof item.content === 'string'
                        ? [{ type: 'input_text', text: item.content }]
                        : item.content
                  }))
              : []),
            nativeItem
          ]
        : [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: calls.length === 1 ? 'Original answer evidence. '.repeat(700) : 'Done.'
                }
              ]
            }
          ];
      const payload = {
        id: `response-${calls.length}`,
        model,
        status: 'completed',
        output,
        usage: {
          input_tokens: 100,
          output_tokens: calls.length === 1 ? 4500 : 20,
          total_tokens: calls.length === 1 ? 4600 : 120
        }
      };
      return body.stream
        ? new Response(
            `data: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`
          )
        : Response.json(payload);
    };
    const base = await new OpenAIProvider().describeModel(model);
    const definition = {
      ...base,
      limits: { contextTokens: 9800, outputTokens: 4096 },
      capabilities: { ...base.capabilities, streaming: false }
    };
    delete definition.id;
    delete definition.provider;
    delete definition.capabilities.protocol;
    if (kind === 'openai-codex')
      definition.supportedParameters = definition.supportedParameters.filter(
        (parameter) => parameter !== 'maxOutputTokens'
      );
    const provider =
      kind === 'openai'
        ? new OpenAIProvider({
            apiKey: 'fixture',
            countTokens: true,
            modelProfiles: { [model]: definition },
            fetch
          })
        : new OpenAICodexProvider({
            modelProfiles: { [model]: definition },
            fetch,
            auth: {
              describe: () => ({ type: 'bearer', label: 'fixture' }),
              getBearerToken: async () => ({
                token: `head.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`
              })
            }
          });
    const service = new InferenceService({
      provider,
      artifacts,
      repository: new InMemoryInferenceRepository()
    });
    const createRuntime = () => {
      const history = new HistoryReader({ repository: sessions, session, artifacts, events });
      const context = new ContextService({
        repository: sessions,
        session,
        history,
        artifacts,
        policy: {
          maxSourceBytes: 1024 * 1024,
          historyRead: { history, isAvailable: () => true }
        }
      });
      return new AgentRuntime({
        provider,
        model,
        inferenceService: service,
        inferenceOwnerId: 'work',
        context,
        contextRenewal: { automatic: true },
        maxOutputTokens: 4096,
        repositories: {
          events,
          artifacts,
          session: { repository: sessions, descriptor: session }
        },
        toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' }
      });
    };
    await completed(createRuntime(), 'original', 'Inspect the project.');
    await completed(createRuntime(), 'renewed', `Explain the current result. ${'Relevant new constraint. '.repeat(350)}`);
    assert.equal(
      calls.filter((call) => call.compact).length,
      1,
      JSON.stringify(calls.map((call) => [call.compact, JSON.stringify(call.body).length]))
    );
    const successor = calls.at(-1).body;
    assert(
      successor.input.some(
        (item) =>
          item.type === 'compaction' && item.encrypted_content === nativeItem.encrypted_content
      )
    );
    assert.equal(JSON.stringify(successor).split('Explain the current result.').length - 1, 1);
    assert(!JSON.stringify(successor).includes('Original answer evidence.'));
    if (kind === 'openai') assert(JSON.stringify(successor).includes('Inspect the project.'));
    assert.equal((await service.settledRunUsage('work', 'renewed')).invocations, 2);
  });
}

for (const change of ['authority', 'tools']) {
  for (const failure of ['automatic_disabled', 'unsupported', 'transform_failed']) {
    test(`native ${change} conflict ${failure} preserves a resumable run`, async (t) => {
      const f = await fixture(t, {
        automatic: failure !== 'automatic_disabled',
        native: failure !== 'unsupported',
        transformFailure: failure === 'transform_failed'
      });
      f.noUpdates();
      await completed(f.runtime(), 'before-conflict', 'Keep the original evidence.');
      const originalWindow = (await f.context().inspect()).window;
      if (change === 'authority') f.changeInstructions('Changed required authority.');
      else f.addTools();
      const runtime = f.runtime();
      const blocked = await runtime.run({ runId: 'continuity-conflict', task: 'Continue accepted work.' }).result;
      assert.equal(blocked.state, 'suspended', JSON.stringify(blocked));
      assert.equal(blocked.reason, 'context_admission');
      assert.equal(blocked.contextAdmission.kind, 'native_continuity');
      assert.equal(blocked.contextAdmission.reason, failure);
      assert.equal(blocked.terminal, undefined);
      assert.equal(blocked.contextAdmission.inputIdentity, undefined);
      assert.deepEqual((await f.context().inspect()).window, originalWindow);
      const repeated = await f.runtime().resume('continuity-conflict').result;
      assert.equal(repeated.state, 'suspended', JSON.stringify(repeated));
      assert.equal(repeated.contextAdmission.kind, 'native_continuity');
      if (failure === 'transform_failed') f.allowTransform();
      else if (change === 'tools') await f.freshContinuation();
      else f.restoreConfiguration();
      f.reopen();
      const resumed = await f.runtime().resume('continuity-conflict').result;
      assert.equal(resumed.terminal?.executionStatus, 'completed', JSON.stringify(resumed));
      const successor = f.calls.at(-1);
      assert.equal(JSON.stringify(successor).split('Continue accepted work.').length - 1, 1);
      assert.equal((await f.context().workingState()).revision, null);
    });
  }
}


test('state-only updates preserve an admitted provider selection without requesting another compaction', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await completed(f.runtime(), 'state-before-transform', 'Inspect the original requirements.');
  f.changeInstructions('New required authority.');
  await completed(f.runtime(), 'state-transform', 'Continue under the changed instructions.');
  const before = await f.context().inspect();
  assert.equal(before.window.selection.strategy, 'provider');
  const transformCount = f.calls.filter(call => call.compaction).length;
  assert.equal(transformCount, 1);
  const providerState = (await f.context().history.selectedContext()).selection.providerState;
  f.updateAgain();
  await completed(f.runtime(), 'state-after-transform', 'Revise only the fallible interpretation.');
  assert.equal((await f.context().workingState()).text, 'Revised understanding.');
  const after = await f.context().history.selectedContext();
  assert.equal(after.selection.strategy, 'provider');
  assert.deepEqual(after.selection.providerState, providerState);
  assert.equal(f.calls.filter(call => call.compaction).length, transformCount);
  const transitions = (await f.sessions().loadReplayState(f.session)).branch.filter(entry =>
    entry.type === 'context_transition' && entry.workingState);
  assert.equal(transitions.length, 4);
  assert.ok(transitions.slice(-2).every(entry => entry.transition.preservedSelection === true &&
    entry.transition.admission.status === 'admitted'));
});
