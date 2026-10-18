import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { defineTool } from '@agent-core/tools';
import { conservativeProtocolCapabilities } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  ModelWindow,
  InMemorySessionRepository,
  HistoryReader,
  ContextService,
  createHistoryTools,
  agentEventCodec
} from '@agent-core/runtime';

function profile(capacity) {
  return {
    id: 'context',
    provider: 'fixture',
    capabilities: {
      streaming: false,
      toolCalling: true,
      supportedToolInputs: [{ kind: 'json' }],
      jsonMode: false,
      jsonSchema: false,
      logprobs: false,
      temperature: true,
      topP: false,
      protocol: conservativeProtocolCapabilities('fixture://context', {
        roles: ['system', 'developer', 'user', 'assistant'], contextReset: 'fresh_request'
      })
    },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: capacity, outputTokens: 256 },
    supportedParameters: ['maxOutputTokens', 'tools', 'temperature']
  };
}
async function fixture() {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'tests/context', schemaVersion: 1, subject: {} }
  });
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const policy = { maxSourceBytes: 4 * 1024 * 1024, historyRead: { history, isAvailable: () => true } };
  const context = new ContextService({
    artifacts,
    repository: sessions,
    session,
    history,

    policy
  });
  const requests = [];
  let capacity = 60000;
  const provider = {
    id: 'fixture',
    implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'context' }),
    describeModel: async () => profile(capacity),
    complete: async (request) => {
      requests.push(request);
      return {
        provider: 'fixture',
        model: 'context',
        content: request.tools
          ? 'Recorded answer.'
          : JSON.stringify({
              text: 'Recorded answer.'
            }),
        terminationReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }
      };
    }
  };
  const options = {
    provider,
    model: 'context',
    context,

    maxOutputTokens: 128,
    tools: [...createHistoryTools({ history }), ...context.toolDefinitions()],
    repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
    toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
    toolPolicy: { allowedRisks: ['read', 'write'] }
  };
  return {
    sessions,
    session,
    events,
    history,
    context,
    requests,

    provider,
    options,
    setCapacity(value) {
      capacity = value;
    }
  };
}


function lookupTool() {
  return defineTool({
    name: 'lookup', implementationId: 'lookup@1', description: 'Read evidence.',
    schema: z.strictObject({}), outputSchema: z.strictObject({ value: z.string() }),
    canonicalizeInput: input => input,
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'facts' }], lockScopes: [] },
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'facts' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    invoke: async () => ({ kind: 'result', output: { value: 'original observation' }, summary: 'Observed',
      scope: { resources: ['facts'], coverage: 'complete' } })
  });
}
function toolTurns(f, count) {
  let turns = 0;
  f.provider.complete = async request => {
    f.requests.push(request);
    turns++;
    return { provider: 'fixture', model: 'context', content: turns <= count ? '' : 'Done',
      terminationReason: turns <= count ? 'tool_calls' : 'stop',
      ...(turns <= count ? { toolCalls: [{ id: `call-${turns}`, name: 'lookup', type: 'function',
        input: { kind: 'json', value: {} } }] } : {}) };
  };
  return { ...f.options, tools: [lookupTool()] };
}
function countRepositoryReads(f) {
  const counts = { ledgerRecords: 0, ledgerRuns: {}, metadataCalls: 0, metadataRecords: 0, rangeRecords: 0 };
  const read = f.events.read.bind(f.events);
  f.events.read = async function* (runId) {
    for await (const record of read(runId)) { counts.ledgerRecords++; counts.ledgerRuns[runId] = (counts.ledgerRuns[runId] ?? 0) + 1; yield record; }
  };
  for (const method of ['readMetadataRange', 'readRange']) {
    const original = f.events[method].bind(f.events);
    f.events[method] = async (...args) => {
      const page = await original(...args);
      if (method === 'readMetadataRange') {
        counts.metadataCalls++;
        counts.metadataRecords += page.records.length;
      } else counts.rangeRecords += page.records.length;
      return page;
    };
  }
  return counts;
}

test('own committed tool turns extend the model window without rereading the growing ledger', async () => {
  const measurements = [];
  for (const count of [2, 4, 8, 16]) {
    const f = await fixture();
    const counts = countRepositoryReads(f);
    const result = await new AgentRuntime(toolTurns(f, count)).run({ runId: `incremental-${count}`, task: 'Continue.' }).result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(f.requests.length, count + 1);
    assert.equal(f.requests.at(-1).messages.filter(item => item.role === 'tool').length, count);
    measurements.push({ count, ...counts });
  }
  for (const row of measurements) {
    assert.ok(row.ledgerRecords <= 20, JSON.stringify(measurements));
    assert.ok(row.metadataCalls <= 65 * row.count + 40, JSON.stringify(measurements));
    assert.ok(row.metadataRecords <= 8 * row.count + 20, JSON.stringify(measurements));
    assert.ok(row.rangeRecords <= 16 * row.count + 20, JSON.stringify(measurements));
  }
});

for (const timing of ['observation-mirror', 'delta-read']) {
  test(`external correction during ${timing} is applied before dispatch despite already-applied own results`, async () => {
    const f = await fixture();
    const correction = `Late correction during ${timing}: keep this read-only.`;
    let added = false;
    if (timing === 'observation-mirror') {
      const append = f.sessions.appendObservation.bind(f.sessions);
      f.sessions.appendObservation = async (...args) => {
        const entry = await append(...args);
        if (!added) {
          added = true;
          await f.sessions.appendInput(f.session, { runId: 'external-correction', task: correction });
        }
        return entry;
      };
    } else {
      const metadataPage = f.history.metadataPage.bind(f.history);
      f.history.metadataPage = async request => {
        const page = await metadataPage(request);
        if (!added && request.after && page.items.some(item => item.type === 'observation')) {
          added = true;
          await f.sessions.appendInput(f.session, { runId: 'external-correction', task: correction });
        }
        return page;
      };
    }
    const result = await new AgentRuntime(toolTurns(f, 1)).run({ runId: `race-${timing}`, task: 'Continue.' }).result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(added, true);
    assert.equal(f.requests.length, 2, 'No stale intermediate request may be dispatched');
    const messages = f.requests[1].messages;
    assert.equal(messages.filter(item => item.content === correction).length, 1);
    assert.equal(messages.filter(item => item.role === 'tool' && item.toolCallId === 'call-1').length, 1);
  });
}

test('a failed observation mirror does not force replay of its already-applied authoritative result', async () => {
  const f = await fixture();
  const counts = countRepositoryReads(f);
  f.sessions.appendObservation = async () => { throw new Error('Mirror unavailable'); };
  const result = await new AgentRuntime(toolTurns(f, 4)).run({ runId: 'missing-mirror', task: 'Continue.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(f.requests.at(-1).messages.filter(item => item.role === 'tool').length, 4);
  assert.ok(counts.ledgerRecords <= 20, JSON.stringify(counts));
});


test('applied durable identities belong to the specific model window', () => {
  const window = new ModelWindow();
  const source = { runId: 'run:one', eventId: 'assistant:event', sequence: 7, hash: 'original' };
  assert.equal(window.hasAppliedSource(source), false);
  window.recordModelOutput({ source, turnIndex: 1, content: 'Applied output.', toolCalls: [] });
  assert.equal(window.hasAppliedSource(source), true);
  assert.equal(window.hasAppliedSource({ ...source, hash: 'changed' }), false);
  assert.throws(() => window.recordAppliedSource({ ...source, hash: 'changed' }), /immutable identity/);
  const replacement = new ModelWindow();
  replacement.replaceWith(window);
  assert.equal(replacement.hasAppliedSource(source), true);
  replacement.replaceWith(new ModelWindow());
  assert.equal(replacement.hasAppliedSource(source), false);
});

test('continuing own turns does not scan finalized historical ledgers', async () => {
  const f = await fixture();
  const seed = await new AgentRuntime(f.options).run({ runId: 'historical-run', task: 'Earlier requirement.' }).result;
  assert.equal(seed.terminal?.executionStatus, 'completed');
  const counts = countRepositoryReads(f);
  const result = await new AgentRuntime(toolTurns(f, 8)).run({ runId: 'current-run', task: 'Continue.' }).result;
  assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(counts.ledgerRuns['historical-run'], undefined, JSON.stringify(counts));
  assert.ok(counts.ledgerRecords <= 20, JSON.stringify(counts));
  assert.equal(f.requests.at(-1).messages.filter(item => item.content === 'Earlier requirement.').length, 1);
});
