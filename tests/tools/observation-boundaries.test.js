import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  ObservationStore,
  resolveToolObservation,
  resolveToolModelContent,
  agentEventCodec
} from '@agent-core/runtime';
import { execCommandTool } from '@agent-core/tools-local';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import {
  defineTool,
  parseToolObservation,
  decodeOwnedToolObservationForPersistence,
  createToolCall,
  serializeToolModelContent
} from '@agent-core/tools';

const tool = defineTool({
  name: 'source',
  implementationId: 'tests/source',
  description: 'Read original source',
  schema: z.strictObject({}),
  outputSchema: z.json(),
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'source' }], lockScopes: [] },
  canonicalizeInput: (input) => input,
  deriveEffects: () => ({
    accesses: [{ mode: 'read', scope: 'source' }],
    lockScopes: [],
    recovery: { kind: 'unknown' }
  }),
  invoke: async () => ({
    kind: 'result',
    summary: 'Read',
    scope: { resources: ['source'], coverage: 'complete' },
    output: {}
  })
});
const call = createToolCall({ name: tool.name, input: { kind: 'json', value: {} } });
const observation = (output, extras = {}) =>
  parseToolObservation(tool, {
    kind: 'result',
    summary: 'Original source',
    scope: { resources: ['source'], coverage: 'complete' },
    output,
    ...extras
  });
const partialScope = {
  resources: ['source'],
  filters: { pattern: '*.txt' },
  limits: { maxFiles: 3 },
  coverage: 'partial',
  omitted: { files: 7 },
  causes: ['result_limit']
};

function assertPartialFacts(text, { presentation = 'complete', kind = 'result', execution = 'settled' } = {}) {
  assert.match(text, /Original result coverage: partial/);
  assert.match(text, /"resources":\["source"\]/);
  assert.match(text, /"filters":\{"pattern":"\*\.txt"\}/);
  assert.match(text, /"limits":\{"maxFiles":3\}/);
  assert.match(text, /"omitted":\{"files":7\}/);
  assert.match(text, /"causes":\["result_limit"\]/);
  assert.ok(text.includes(`Presentation coverage: ${presentation}.`));
  assert.ok(text.includes(`Invocation disposition: ${kind}; execution state: ${execution}.`));
  for (const label of ['Original result coverage:', 'Presentation coverage:', 'Invocation disposition:'])
    assert.equal(text.split(label).length - 1, 1, `${label} is disclosed exactly once`);
}

test('complete settled results preserve the exact selected JSON payload contract', async (t) => {
  const output = { selection: { items: [{ id: 'source-1' }] }, coverage: 'complete' };
  const value = observation(output, { execution: { state: 'settled' } });
  const defaultText = JSON.stringify(value.output, null, 2);
  for (const [name, formatter, expected] of [
    ['default', undefined, defaultText],
    ['custom', () => [{ type: 'text', text: JSON.stringify(output) }], JSON.stringify(output)],
    ['fallback', () => { throw new Error('formatter failed'); }, defaultText]
  ]) {
    await t.test(name, async () => {
      const store = new ObservationStore({ maxPresentationBytes: 1024 });
      const committed = await store.commitToolObservation({
        turnIndex: 1, call, tool: formatter ? { ...tool, buildModelContent: formatter } : tool,
        observation: value
      });
      const delivered = (await store.projectToolObservation(committed)).modelText;
      assert.equal(delivered, expected);
      assert.deepEqual(JSON.parse(delivered), output);
      assert.equal((await resolveToolObservation(committed.original)).execution.state, 'settled');
    });
  }
});

test('selected JSON stays first while shared facts survive every formatter and execution state', async (t) => {
  const output = { processId: 'process-1', status: 'running' };
  for (const scope of [{ resources: ['source'], coverage: 'complete' }, partialScope]) {
    for (const state of ['active', 'unknown', 'not_started', 'settled']) {
      for (const [name, formatter] of [
        ['default', undefined],
        ['custom', () => [{ type: 'text', text: JSON.stringify(output) }]],
        ['fallback', () => { throw new Error('formatter failed'); }],
        ['invalid fallback', () => [{ type: 'unknown' }]]
      ]) {
        await t.test(`${scope.coverage}/${state}/${name}`, async () => {
          const store = new ObservationStore();
          const committed = await store.commitToolObservation({
            turnIndex: 1, call,
            tool: formatter ? { ...tool, buildModelContent: formatter } : tool,
            observation: observation(output, { scope, execution: { state } })
          });
          const delivered = (await store.projectToolObservation(committed)).modelText;
          assert.deepEqual(JSON.parse(delivered.split('\n\n', 1)[0]), output);
          if (scope.coverage === 'partial') assertPartialFacts(delivered, { execution: state });
          else if (state !== 'settled') {
            assert.ok(delivered.includes(`Invocation disposition: result; execution state: ${state}.`));
            assert.doesNotMatch(delivered, /Presentation coverage: partial/);
          }
          assert.equal((await resolveToolObservation(committed.original)).execution.state, state);
        });
      }
    }
  }
});

test('running process presentation keeps control JSON first and discloses active execution', async () => {
  const combined = {
    segments: ['ready'], observedBytes: 5, capturedBytes: 5, omittedBytes: 0,
    startsAtOutputStart: true, endsAtOutputEnd: true
  };
  const output = execCommandTool.outputSchema.parse({
    processId: 'process-1', status: 'running', cursorStart: 0, cursorEnd: 5,
    owner: { ownerId: 'owner-1', runId: 'run-1', turnId: 'turn-1', toolBatchId: 'batch-1', callIndex: 0 },
    stdout: combined,
    stderr: { ...combined, segments: [], observedBytes: 0, capturedBytes: 0 },
    combined, originalOutput: { kind: 'captured', cursorEnd: 5, omittedBytes: 0 }
  });
  let formatted = false;
  const store = new ObservationStore();
  const committed = await store.commitToolObservation({
    turnIndex: 1, call: createToolCall({ name: execCommandTool.name, input: { kind: 'json', value: {} } }),
    tool: { ...execCommandTool, buildModelContent: request => {
      const selected = execCommandTool.buildModelContent(request);
      formatted = true;
      return selected;
    } },
    observation: parseToolObservation(execCommandTool, {
      kind: 'result', summary: 'Process remains running',
      scope: { resources: ['process-1'], coverage: 'complete' }, execution: { state: 'active' }, output
    })
  });
  assert.equal(formatted, true, 'the actual process formatter must succeed without fallback');
  const delivered = (await store.projectToolObservation(committed)).modelText;
  assert.deepEqual(JSON.parse(delivered.split('\n\n', 1)[0]), {
    status: 'running', outputCoverage: 'complete', processId: 'process-1', cursorStart: 0, cursorEnd: 5
  });
  assert.match(delivered, /\n\nready\n\nInvocation disposition: result; execution state: active\./);
  assert.deepEqual((await resolveToolObservation(committed.original)).output, output);
});

test('small partial observations retain authoritative scope across every formatter path', async (t) => {
  for (const [name, output, formatter] of [
    ['default string', 'No matches', undefined],
    ['default JSON', { matches: [] }, undefined],
    ['custom', 'No matches', () => [{ type: 'text', text: 'No matches' }]],
    ['empty custom', 'No matches', () => []],
    ['throwing custom', 'No matches', () => { throw new Error('formatter failed'); }],
    ['invalid custom', 'No matches', () => [{ type: 'unknown' }]]
  ]) {
    await t.test(name, async () => {
      const value = observation(output, { scope: partialScope, execution: { state: 'settled' } });
      const store = new ObservationStore({ maxPresentationBytes: 1024 });
      const committed = await store.commitToolObservation({
        turnIndex: 1, call, tool: formatter ? { ...tool, buildModelContent: formatter } : tool,
        observation: value
      });
      const delivered = (await store.projectToolObservation(committed)).modelText;
      assertPartialFacts(delivered);
      assert.equal(committed.modelContentRef, undefined);
      assert.equal(committed.durableStorageDegraded, undefined);
      assert.deepEqual((await resolveToolObservation(committed.original)).scope, partialScope);
      assert.deepEqual((await resolveToolObservation(committed.original)).output, output);
    });
  }
});

test('failure formatters and fallback cannot hide incomplete scope or invent settled execution', async (t) => {
  for (const [name, formatter] of [
    ['default', undefined],
    ['custom', () => [{ type: 'text', text: 'No matches' }]],
    ['fallback', () => { throw new Error('formatter failed'); }]
  ]) {
    await t.test(name, async () => {
      const value = parseToolObservation(tool, {
        kind: 'failure', summary: 'Search was interrupted', scope: partialScope,
        execution: { state: 'unknown' }, output: { reason: 'runtime_error', error: 'lost response' }
      });
      const committed = await new ObservationStore().commitToolObservation({
        turnIndex: 1, call, tool: formatter ? { ...tool, buildModelContent: formatter } : tool,
        observation: value
      });
      assertPartialFacts(serializeToolModelContent(committed.modelContent), { kind: 'failure', execution: 'unknown' });
      assert.equal((await resolveToolObservation(committed.original)).kind, 'failure');
    });
  }
});

test('partial coverage does not imply an execution state when none was established', async () => {
  const committed = await new ObservationStore().commitToolObservation({
    turnIndex: 1, call, tool, observation: observation('No matches', { scope: partialScope })
  });
  assertPartialFacts(serializeToolModelContent(committed.modelContent), { execution: 'not established' });
});

test('large originals and exact delivered content resolve independently without field guessing', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const store = new ObservationStore({ artifacts });
  const original = {
    unusualDomainField: 'original quotation\n'.repeat(24000),
    other: { detail: 'retained' }
  };
  const committed = await store.commitToolObservation({
    turnIndex: 1,
    call,
    tool,
    observation: observation(original)
  });
  assert.equal(committed.original.storage, 'artifact');
  assert.deepEqual((await resolveToolObservation(committed.original, artifacts)).output, original);
  const projected = await store.projectToolObservation(committed);
  assert.ok(
    projected.modelText.includes(original.unusualDomainField.slice(0, 40).replaceAll('\n', '\\n'))
  );
  assert.deepEqual(
    await resolveToolModelContent({ modelContentRef: committed.modelContentRef }, artifacts),
    committed.modelContent
  );
  await assert.rejects(resolveToolObservation(committed.original), /unavailable/);
  await assert.rejects(
    resolveToolObservation(
      {
        ...committed.original,
        artifact: { ...committed.original.artifact, sha256: 'a'.repeat(64) }
      },
      artifacts
    )
  );
});

test('content is selected once before settlement and reused even when formatter changes', async () => {
  let count = 0;
  const formatter = {
    ...tool,
    buildModelContent: ({ observation }) => [
      { type: 'text', text: `${++count}:${observation.output}` }
    ]
  };
  const store = new ObservationStore();
  const committed = await store.commitToolObservation({
    turnIndex: 1,
    call,
    tool: formatter,
    observation: observation('exact')
  });
  formatter.buildModelContent = () => {
    throw new Error('new formatter');
  };
  assert.equal((await store.projectToolObservation(committed)).modelText, '1:exact');
  assert.equal((await store.projectToolObservation(committed)).modelText, '1:exact');
  assert.equal(count, 1);
});

test('storage and formatter failures preserve the actual observation and known lifecycle', async () => {
  class Unavailable extends InMemoryArtifactRepository {
    async store() {
      throw new Error('disk unavailable');
    }
  }
  const value = observation(
    { diagnostic: 'x'.repeat(300000), outcome: 'uncertain' },
    { scope: partialScope, execution: { state: 'unknown' } }
  );
  const committed = await new ObservationStore({
    artifacts: new Unavailable()
  }).commitToolObservation({
    turnIndex: 1,
    call,
    tool: {
      ...tool,
      buildModelContent() {
        throw new Error('display');
      }
    },
    observation: value
  });
  assert.equal(committed.original.storage, 'unavailable');
  assert.equal(committed.original.execution.state, 'unknown');
  assert.equal(committed.durableObservation, undefined);
  assert.equal(committed.fullObservation, undefined);
  assert(committed.original.bytes > 300000);
  assert.match(committed.durableStorageDegraded.message, /disk unavailable/);
  const delivered = serializeToolModelContent(committed.modelContent);
  assertPartialFacts(delivered, { presentation: 'partial', execution: 'unknown' });
  assert.match(delivered, /Presentation omission causes: \["storage_failure"\]/);
  assert.ok(delivered.startsWith('Original source\nDetailed model content is unavailable'));
  assert.doesNotMatch(delivered, /Original result coverage is unavailable/);
});

test('obsolete observation and failure contracts are rejected without migration', () => {
  assert.throws(() => parseToolObservation(tool, { ...observation({}), ok: true }), /unsupported/);
  assert.throws(
    () =>
      decodeOwnedToolObservationForPersistence({
        kind: 'failure',
        summary: 'failed',
        scope: { resources: [], coverage: 'partial' },
        output: {
          reason: 'runtime_error',
          error: 'lost response',
          blocked: true,
          recovery: 'retry'
        }
      }),
    /unsupported/
  );
  assert.throws(
    () =>
      agentEventCodec.decode({
        type: 'tool.ended',
        turnIndex: 1,
        turnId: 't',
        requestAttempt: 1,
        toolBatchId: 'b',
        callIndex: 0,
        toolAttempt: 1,
        toolName: 'source',
        observation: {
          kind: 'result',
          summary: 'old',
          scope: { resources: [], coverage: 'complete' },
          output: {}
        }
      }),
    /Incompatible|identity/
  );
});

test('image selection discloses unavailable modality and retains original artifact access', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const artifact = await artifacts.store({
    label: 'image',
    content: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png'
  });
  const store = new ObservationStore({ artifacts });
  const committed = await store.commitToolObservation({
    turnIndex: 1,
    call,
    tool,
    modelInputModalities: ['text'],
    observation: observation(
      { description: 'image' },
      { content: [{ type: 'image', artifact, detail: 'original' }] }
    )
  });
  const record = await store.projectToolObservation(committed);
  assert.deepEqual(JSON.parse(record.modelText.split('\n\n', 1)[0]), { description: 'image' });
  assert.equal(record.modelImages.length, 0);
  assert.ok(record.modelContent.some((part) => part.type === 'artifact'));
  assert.match(record.modelText, /image|Image/);
  assert.match(record.modelText, /Original result coverage: complete/);
  assert.match(record.modelText, /Presentation coverage: partial/);
  assert.match(record.modelText, /Presentation omission causes: \["unsupported_modality"\]/);
});


test('bounded delivery preserves the complete selected presentation and authoritative observation', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const artifact = await artifacts.store({ label: 'image', content: new Uint8Array([1, 2, 3]), mediaType: 'image/png' });
  const full = 'Arabic العربية emoji 👩🏽‍💻\n'.repeat(2000);
  const payload = { processId: 'process-1', status: 'running' };
  const selected = [{ type: 'text', text: JSON.stringify(payload) }, { type: 'text', text: full }, { type: 'image', artifact, detail: 'original' }];
  const value = observation({ full }, { execution: { state: 'unknown' } });
  const committed = await new ObservationStore({ artifacts, maxPresentationBytes: 2048 }).commitToolObservation({
    turnIndex: 1, call, tool: { ...tool, buildModelContent: () => selected },
    observation: value, modelInputModalities: ['text', 'image']
  });
  const delivered = serializeToolModelContent(committed.modelContent);
  assert.ok(Buffer.byteLength(delivered) <= 2048);
  assert.equal(delivered.isWellFormed(), true);
  assert.deepEqual(JSON.parse(delivered.split('\n\n', 1)[0]), payload);
  assert.match(delivered, /Presentation coverage: partial/);
  assert.match(delivered, /Original result coverage: complete/);
  assert.match(delivered, /execution state: unknown/);
  assert.deepEqual(committed.modelContent.filter(part => part.type === 'image'), [selected[2]]);
  const presentation = committed.modelContent.find(part => part.type === 'artifact').artifact;
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await artifacts.readVerified(presentation))), selected);
  const original = await resolveToolObservation(committed.original, artifacts);
  assert.deepEqual(original.output, value.output);
  assert.equal(original.scope.coverage, 'complete');
  assert.equal(original.execution.state, 'unknown');
});

test('bounded partial results preserve original omissions separately from presentation omissions', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const selected = [{ type: 'text', text: 'No matches\n' + 'detail '.repeat(1000) }];
  const value = observation('No matches', { scope: partialScope, execution: { state: 'settled' } });
  const committed = await new ObservationStore({ artifacts, maxPresentationBytes: 2048 }).commitToolObservation({
    turnIndex: 1, call, tool: { ...tool, buildModelContent: () => selected }, observation: value
  });
  const delivered = serializeToolModelContent(committed.modelContent);
  assert.ok(Buffer.byteLength(delivered) <= 2048);
  assertPartialFacts(delivered, { presentation: 'partial' });
  assert.match(delivered, /Presentation omission causes: \["presentation_limit"\]/);
  const presentation = committed.modelContent.find(part => part.type === 'artifact').artifact;
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await artifacts.readVerified(presentation))), selected);
  assert.deepEqual((await resolveToolObservation(committed.original, artifacts)).scope, partialScope);
});

test('failed presentation preservation never silently discards original selected content', async () => {
  class Unavailable extends InMemoryArtifactRepository {
    async store() { throw new Error('presentation disk unavailable'); }
  }
  const full = 'original '.repeat(1000);
  const committed = await new ObservationStore({ artifacts: new Unavailable(), maxPresentationBytes: 1024 }).commitToolObservation({
    turnIndex: 1, call, tool: { ...tool, buildModelContent: () => [{ type: 'text', text: full }] },
    observation: observation(full)
  });
  assert.equal(serializeToolModelContent(committed.modelContent), full);
  assert.match(committed.durableStorageDegraded.message, /presentation disk unavailable/);
  assert.equal((await resolveToolObservation(committed.original)).output, full);
});

test('small selected content needs no projection artifact or replacement', async () => {
  const selected = [{ type: 'text', text: 'complete answer' }];
  const committed = await new ObservationStore({ maxPresentationBytes: 1024 }).commitToolObservation({
    turnIndex: 1, call, tool: { ...tool, buildModelContent: () => selected }, observation: observation('small')
  });
  assert.deepEqual(committed.modelContent, selected);
  assert.equal(committed.durableStorageDegraded, undefined);
});


test('partial presentation cannot conceal failed authoritative original storage', async () => {
  class PartialStorage extends InMemoryArtifactRepository {
    async store(input) {
      if (input.label.endsWith('-observation')) throw new Error('original disk unavailable');
      return super.store(input);
    }
  }
  const artifacts = new PartialStorage();
  const committed = await new ObservationStore({ artifacts, maxPresentationBytes: 2048 }).commitToolObservation({
    turnIndex: 1, call, tool, observation: observation('x'.repeat(300000))
  });
  assert.equal(committed.original.storage, 'unavailable');
  const delivered = serializeToolModelContent(committed.modelContent);
  assert.ok(Buffer.byteLength(delivered) <= 2048);
  assert.match(delivered, /Original observation storage is unavailable/);
  assert.match(delivered, /does not replace the original structured observation/);
  assert.match(committed.durableStorageDegraded.message, /original disk unavailable/);
});

for (const executionState of ['settled', 'active']) {
  test(`captured JSON-first requests and JSONL replay retain ${executionState} execution and coverage facts`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'observation-coverage-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binding = { schemaId: 'tests/observation-coverage', schemaVersion: 1, subject: {} };
    const sessions = new JsonlSessionRepository({ rootDir: root });
    const session = await sessions.create({ binding });
    const artifacts = new InMemoryArtifactRepository();
    const events = new InMemoryEventRepository(agentEventCodec);
    const requests = [];
    let formatCount = 0;
    let invocationCount = 0;
    const partialTool = defineTool({
      name: 'partial_search', implementationId: 'tests/partial-search@1', description: 'Search a bounded source',
      schema: z.strictObject({}), outputSchema: z.string(),
      effectEnvelope: { accesses: [{ mode: 'read', scope: 'source' }], lockScopes: [] },
      canonicalizeInput: input => input,
      deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'source' }], lockScopes: [], recovery: { kind: 'unknown' } }),
      invoke: async () => {
        invocationCount++;
        return { kind: 'result', summary: 'Search stopped at file limit', scope: partialScope,
          execution: { state: executionState }, output: 'No matches' };
      },
      buildModelContent: () => {
        assert.equal(++formatCount, 1, 'replay must not call the formatter again');
        return [{ type: 'text', text: JSON.stringify({ matches: [] }) }];
      }
    });
    const provider = {
      id: 'coverage-fixture', implementationId: 'tests/coverage-fixture@1',
      describe: () => ({ id: 'coverage-fixture', displayName: 'Coverage fixture', defaultModel: 'fixture' }),
      describeModel: async () => ({
        id: 'fixture', provider: 'coverage-fixture',
        modalities: { input: ['text'], output: ['text'] },
        capabilities: {
          streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }],
          jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false
        },
        limits: { contextTokens: 16000, outputTokens: 1000 }, supportedParameters: ['maxOutputTokens']
      }),
      complete: async request => {
        requests.push(request);
        return {
          provider: 'coverage-fixture', model: request.model,
          content: requests.length === 1 ? '' : 'Only the covered portion had no matches.',
          terminationReason: requests.length === 1 ? 'tool_calls' : 'stop',
          ...(requests.length === 1 ? { toolCalls: [{
            id: 'partial-1', name: 'partial_search', type: 'function', input: { kind: 'json', value: {} }
          }] } : {})
        };
      }
    };
    const createRuntime = (repository, descriptor) => new AgentRuntime({
      provider, model: 'fixture', maxOutputTokens: 64, tools: [partialTool],
      repositories: { events, artifacts, session: { repository, descriptor } },
      toolBoundary: { authorizationPolicyId: 'tests/coverage@1', executionTargetId: 'source' },
      toolPolicy: { allowedRisks: ['read'] }
    });
    const first = await createRuntime(sessions, session).run({ task: 'Search the source' }).result;
    assert.equal(first.state, 'ended', JSON.stringify(first));
    assert.equal(first.terminal.executionStatus, 'completed', JSON.stringify(first));
    const firstToolMessage = requests[1].messages.find(message => message.role === 'tool' && message.toolName === partialTool.name);
    assert.deepEqual(JSON.parse(firstToolMessage.content.split('\n\n', 1)[0]), { matches: [] });
    assertPartialFacts(firstToolMessage.content, { execution: executionState });
    const restartedSessions = new JsonlSessionRepository({ rootDir: root });
    const reopened = await restartedSessions.open(session.id, binding);
    const replay = await restartedSessions.loadReplayState(reopened);
    const recorded = replay.branch.find(entry => entry.type === 'observation' && entry.toolName === partialTool.name);
    assert.equal(serializeToolModelContent(await resolveToolModelContent(recorded, artifacts)), firstToolMessage.content);
    const second = await createRuntime(restartedSessions, reopened).run({ task: 'What portion was covered?' }).result;
    assert.equal(second.state, 'ended', JSON.stringify(second));
    assert.equal(second.terminal.executionStatus, 'completed', JSON.stringify(second));
    const replayedToolMessage = requests[2].messages.find(message => message.role === 'tool' && message.toolName === partialTool.name);
    for (const field of ['content', 'role', 'toolCallId', 'toolCallType', 'toolName'])
      assert.equal(replayedToolMessage[field], firstToolMessage[field], field);
    assert.equal(formatCount, 1);
    assert.equal(invocationCount, 1);
  });
}
