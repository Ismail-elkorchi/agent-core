import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { defineTool } from '@agent-core/tools';
import { modelOutputToInput, requestAccountingInputTokens } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  ContextService,
  HistoryReader,
  InferenceService,
  InMemorySessionRepository,
  agentEventCodec,
  createHistoryTools
} from '@agent-core/runtime';
import {
  continuation,
  continuityProvider,
  model,
  providerIds,
  thinking
} from './continuity-provider-fixtures.js';

for (const id of ['openai', 'openai-codex']) {
  test(`${id} replays original reasoning with current instructions and background`, async () => {
    const provider = continuityProvider(id, { opaqueReasoning: true });
    const initial = {
      model,
      messages: [
        { role: 'developer', content: 'Original repository guidance.' },
        { role: 'user', content: 'Original workspace context.' },
        { role: 'user', content: 'Inspect the repository.' }
      ],
      ...(id === 'openai-codex' ? { reasoning: { strategy: 'effort', effort: 'low' } } : {})
    };
    const response = await provider.complete(initial);
    const output = modelOutputToInput(response.output);
    const compiled = await provider.compileRequest({
      ...initial,
      messages: [
        { role: 'developer', content: 'Current scoped repository guidance.' },
        { role: 'user', content: 'Current working state and workspace context.' },
        initial.messages[2],
        ...output,
        { role: 'user', content: 'Continue the inspection.' }
      ]
    }, { outputReservation: 4096 });
    assert.deepEqual(
      compiled.body.input.filter((item) => item.type === 'reasoning'),
      [{ type: 'reasoning', id: 'reasoning-1', encrypted_content: 'original-opaque+/=', summary: [] }]
    );
    assert.deepEqual(
      compiled.logicalRequest.messages.filter((item) => item.role === 'protocol'),
      output.filter((item) => item.role === 'protocol')
    );
    assert.ok(JSON.stringify(compiled.body).includes('Current scoped repository guidance.'));
    assert.ok(!JSON.stringify(compiled.body).includes('Original repository guidance.'));
    assert.equal((await provider.completeCompiled(compiled)).terminationReason, 'stop');
  });
}

for (const id of providerIds) {
  test(`${id} renews context without changing instruction authority or the conversation prefix`, async () => {
    const sessions = new InMemorySessionRepository();
    const session = await sessions.create({
      binding: { schemaId: 'tests/continuity', schemaVersion: 1, subject: {} }
    });
    const artifacts = new InMemoryArtifactRepository();
    const events = new InMemoryEventRepository(agentEventCodec);
    const history = new HistoryReader({ repository: sessions, session, events, artifacts });
    const context = new ContextService({
      repository: sessions,
      session,
      history,
      artifacts,
      policy: { maxSourceBytes: 4 * 1024 * 1024, historyRead: { history, isAvailable: () => true } }
    });
    const compiled = [];
    const bodies = [];
    const options = {
      model,
      context,
      maxOutputTokens: 4096,
      ...(id === 'openai-codex'
        ? { reasoning: { strategy: 'effort', effort: 'low' } }
        : { temperature: 0.3 }),
      ...(id === 'claude' ? {} : { responseFormat: 'json' }),
      instructions: [
        {
          id: 'policy',
          role: 'system',
          content: 'Preserve user constraints and report observed evidence.'
        }
      ],
      tools: createHistoryTools({ history }),
      repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
      toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
      toolPolicy: { allowedRisks: ['read'] }
    };
    const inference = (provider) =>
      InferenceService.inMemory({ provider, admitRequest: (request) => compiled.push(request) });
    const original = `Repair validation without changing public behavior. ${'Observed historical detail. '.repeat(2000)}`;
    const firstProvider = continuityProvider(id, { bodies });
    const first = await new AgentRuntime({
      ...options,
      provider: firstProvider,
      inferenceService: inference(firstProvider)
    }).run({ task: original }).result;
    assert.equal(first.terminal?.executionStatus, 'completed', JSON.stringify(first));
    const firstRequest = compiled.at(-1);
    const provider = continuityProvider(id, {
      contextTokens: requestAccountingInputTokens(firstRequest.accounting) + 4096 + 1800,
      bodies,
      respond: (body) =>
        body.tools?.length
          ? 'Repair and checks completed.'
          : JSON.stringify({
              text: continuation
            })
    });
    const service = inference(provider);
    const current = 'Continue the same repair, retaining the original constraints.';
    const result = await new AgentRuntime({
      ...options,
      provider,
      inferenceService: service,
      contextRenewal: { automatic: true }
    }).run({ runId: 'continue', task: current }).result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(bodies.length, 3, 'one original answer, one note, one resumed answer');
    const summary = compiled.find((request) => !request.logicalRequest.tools);
    assert.ok(summary, 'continuation passes through normal admission');
    const messages = summary.logicalRequest.messages;
    assert.deepEqual(
      messages.slice(0, firstRequest.logicalRequest.messages.length),
      firstRequest.logicalRequest.messages
    );
    assert.equal(messages.at(-1).role, 'user');
    assert.match(messages.at(-1).content, /working state/);
    assert.deepEqual(
      messages.filter((message) => ['system', 'developer'].includes(message.role)),
      firstRequest.logicalRequest.messages.filter((message) => message.role === 'system')
    );
    assert.ok(messages.some((message) => message.content === original));
    assert.ok(messages.some((message) => message.content === current));
    assert.equal(summary.logicalRequest.temperature, firstRequest.logicalRequest.temperature);
    assert.deepEqual(summary.logicalRequest.reasoning, firstRequest.logicalRequest.reasoning);
    assert.equal(
      summary.logicalRequest.maxOutputTokens,
      firstRequest.logicalRequest.maxOutputTokens
    );
    assert.equal(summary.logicalRequest.responseFormat, undefined);
    const resumed = compiled.at(-1).logicalRequest;
    assert.ok(resumed.tools.length > 0);
    assert.equal(resumed.responseFormat, options.responseFormat);
    assert.ok(resumed.messages.some((message) => message.content?.includes(continuation)));
    assert.ok(!resumed.messages.some((message) => message.content === original));
    assert.equal(resumed.messages.filter((message) => message.content === current).length, 1);
    const inspected = await context.inspect();
    assert.ok(inspected.workingState.revisionId);
    assert.equal((await context.workingState()).text, continuation);
    const usage = await service.settledRunUsage('continue', 'continue');
    assert.equal(usage.invocations, 2);
    assert.equal(usage.usage.promptTokens, 40);
    assert.equal(usage.usage.completionTokens, 20);
    const auxiliaryHistory = await history.search({
      query: 'Runtime context-maintenance task',
      filter: { sourceType: 'input' }
    });
    assert.equal(auxiliaryHistory.items.length, 0, 'auxiliary task is not a user contribution');
    if (id === 'claude')
      assert.deepEqual(
        bodies[1].messages.find((message) => message.role === 'assistant').content[0],
        thinking
      );
    if (id === 'ollama')
      assert.equal(
        bodies[1].messages.find((message) => message.role === 'assistant').thinking,
        'Original thinking.'
      );
  });
}

for (const id of ['openai', 'openai-codex', 'openrouter']) {
  test(`${id} continues with original opaque replay state after runtime recreation`, async () => {
    const sessions = new InMemorySessionRepository();
    const session = await sessions.create({
      binding: { schemaId: 'tests/continuity', schemaVersion: 1, subject: {} }
    });
    const artifacts = new InMemoryArtifactRepository();
    const events = new InMemoryEventRepository(agentEventCodec);
    const history = new HistoryReader({ repository: sessions, session, events, artifacts });
    const context = new ContextService({
      repository: sessions,
      session,
      history,
      artifacts,
      policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } }
    });
    const bodies = [];
    const provider = continuityProvider(id, { bodies, opaqueReasoning: true });
    const options = {
      provider,
      model,
      context,
      maxOutputTokens: 4096,
      contextRenewal: { automatic: true },
      repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
      toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' }
    };
    const first = await new AgentRuntime(options).run({ task: 'Inspect the problem.' }).result;
    assert.equal(first.terminal?.executionStatus, 'completed', JSON.stringify(first));
    const next = await new AgentRuntime(options).run({ task: 'Continue the repair.' }).result;
    assert.equal(next.terminal?.executionStatus, 'completed', JSON.stringify(next));
    assert.equal(
      bodies.length,
      2,
      'uncertain component costs do not create an auxiliary inference'
    );
    assert.ok(
      JSON.stringify(bodies[1]).includes('original-opaque+/='),
      'original encrypted state is replayed'
    );
    const inspected = await context.inspect();
    assert.equal(inspected.window, null);
    assert.equal(inspected.admission.status, 'admitted');
    assert.ok(
      inspected.admission.accounting.unknownComponents.length > 0,
      'uncertainty remains explicit'
    );
    assert.equal(inspected.workingState.revisionId, null);
  });
}

test('mid-run renewal preserves signed reasoning and the completed tool exchange', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'tests/continuity', schemaVersion: 1, subject: {} }
  });
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    artifacts,
    policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } }
  });
  let inspections = 0;
  const effectEnvelope = { accesses: [{ mode: 'read', scope: 'fixture' }], lockScopes: [] };
  const inspect = defineTool({
    name: 'inspect',
    implementationId: 'test/inspect',
    description: 'Inspect original evidence.',
    schema: z.strictObject({}),
    outputSchema: z.string(),
    effectEnvelope,
    canonicalizeInput: (input) => input,
    deriveEffects: () => ({ ...effectEnvelope, recovery: { kind: 'unknown' } }),
    invoke: async () => {
      inspections++;
      return {
        kind: 'result',
        output: 'Observation. '.repeat(7800),
        summary: 'Inspected original evidence.',
        scope: { resources: ['fixture'], coverage: 'complete' }
      };
    }
  });
  const bodies = [];
  const provider = continuityProvider('claude', {
    contextTokens: 42000,
    bodies,
    firstTool: 'inspect',
    respond: (body) =>
      body.tools?.length
        ? 'Inspected evidence.'
        : JSON.stringify({
            text: continuation
          })
  });
  const result = await new AgentRuntime({
    provider,
    model,
    context,
    maxOutputTokens: 4096,
    contextRenewal: { automatic: true },
    tools: [inspect, ...createHistoryTools({ history })],
    toolPolicy: { allowedRisks: ['read'] },
    repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
    toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' }
  }).run({ task: 'Inspect the evidence and finish the repair.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(inspections, 1);
  assert.equal(
    bodies.length,
    3,
    JSON.stringify(
      bodies.map((body) => ({ bytes: JSON.stringify(body).length, tools: body.tools?.length }))
    )
  );
  assert.deepEqual(
    bodies[1].messages.find((message) => message.role === 'assistant').content[0],
    thinking
  );
  assert.ok(JSON.stringify(bodies[1]).includes('inspection-call'));
  assert.ok(JSON.stringify(bodies[2]).includes(continuation));
});
