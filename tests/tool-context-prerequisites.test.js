import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { AgentRuntime, HistoryReader, InMemorySessionRepository, assertHistoryModelCompatibility, agentEventCodec } from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { defineTool } from '@agent-core/tools';

test('host guidance is presented before a mutation without using its tool output schema or presenter', async () => {
  let mutations = 0,
    preparations = 0,
    needsGuidance = true,
    requests = 0;
  const events = new InMemoryEventRepository(agentEventCodec);
  const artifacts = new InMemoryArtifactRepository();
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding: { schemaId: 'test/guidance', schemaVersion: 1, subject: {} } });
  const tool = defineTool({
    name: 'edit_value',
    implementationId: 'edit-value@1',
    description: 'Writes the admitted value.',
    schema: z.strictObject({ value: z.string() }),
    outputSchema: z.strictObject({ written: z.string() }),
    canonicalizeInput: (input) => input,
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'value' }], lockScopes: ['value'] },
    deriveEffects: () => ({
      accesses: [{ mode: 'write', scope: 'value' }],
      lockScopes: ['value'],
      recovery: { kind: 'unknown' }
    }),
    async bindExecution(input, context) {
      preparations++;
      await context.lifetime.own({ release() {} });
      return {
        snapshot: { ...input, authorization: 'exact-prepared-authority' },
        async invoke() {
          mutations++;
          return {
            kind: 'result',
            execution: { state: 'settled' },
            summary: 'Written.',
            scope: { resources: ['value'], coverage: 'complete' },
            output: { written: input.value }
          };
        }
      };
    },
    buildModelContent({ observation }) {
      assert.equal(observation.output.written, 'new');
      return [{ type: 'text', text: observation.summary }];
    }
  });
  const call = (id) => ({
    provider: 'fixture',
    model: 'fixture',
    content: '',
    terminationReason: 'tool_calls',
    toolCalls: [
      { id, type: 'function', name: 'edit_value', input: { kind: 'json', value: { value: 'new' } } }
    ]
  });
  const provider = {
    id: 'fixture',
    implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'fixture' }),
    async describeModel() {
      return {
        id: 'fixture',
        provider: 'fixture',
        capabilities: {
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
        limits: { contextTokens: 16000, outputTokens: 1000 },
        supportedParameters: ['tools', 'maxOutputTokens']
      };
    },
    async complete(request) {
      requests++;
      if (requests === 1) return call('original-call');
      if (requests === 2) {
        assert.equal(mutations, 0);
        assert.equal(preparations, 0);
        assert.ok(
          request.messages.some(
            (item) =>
              item.role === 'tool' &&
              item.content.includes('context_required') &&
              item.content.includes('GUIDANCE-82')
          )
        );
        needsGuidance = false;
        return call('reconsidered-call');
      }
      if (requests === 4) {
        assert.deepEqual(request.messages.flatMap(item => item.toolCalls ?? []).map(call => call.id),
          ['original-call', 'reconsidered-call']);
        assert.equal(request.messages.filter(item => item.role === 'tool').length, 2);
        assert.ok(request.messages.some(item => item.role === 'tool' && item.content.includes('context_required')));
      }
      return { provider: 'fixture', model: 'fixture', content: 'Done.', terminationReason: 'stop' };
    }
  };
  const progress = [];
  const options = { maxOutputTokens: 64,
    onProgress: event => progress.push(event),
    provider,
    model: 'fixture',
    tools: [tool],
    toolPolicy: { allowedRisks: ['write'] },
    toolBoundary: { authorizationPolicyId: 'allow-write', executionTargetId: 'value' },
    repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
    toolContextPrerequisite: async () =>
      needsGuidance
        ? {
            summary: 'Consider the applicable guidance before choosing an action.',
            context: [
              {
                sourceUri: 'guidance://value',
                sourceKind: 'external',
                representation: 'full',
                mediaType: 'text/plain',
                content: 'GUIDANCE-82: preserve other values.'
              }
            ]
          }
        : undefined
  };
  const runtime = new AgentRuntime(options);
  const result = await runtime.run({ runId: 'guidance-run', task: 'Update the value.' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result.terminal));
  assert.equal(mutations, 1);
  assert.equal(preparations, 1);
  const starts = [];
  for await (const record of events.read('guidance-run'))
    if (record.event.type === 'tool.started') starts.push(record.event.callId);
  assert.deepEqual(starts, ['reconsidered-call']);
  assert.deepEqual(progress.filter(event => event.type === 'tool.call.received').map(event => event.callId),
    ['original-call', 'reconsidered-call']);
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const page = await history.page({ limit: 100 });
  const calls = page.entries.filter(entry => entry.type === 'tool_call');
  assert.deepEqual(calls.map(entry => entry.callId), ['original-call', 'reconsidered-call']);
  for (const call of calls) {
    assert.equal((await events.readReference(call.source)).event.type, 'tool.call.received');
  }
  await assertHistoryModelCompatibility({ history, artifacts,
    profile: await provider.describeModel(), representation: 'portable' });
  const reopened = new AgentRuntime(options);
  const followup = await reopened.run({ runId: 'guidance-followup', task: 'Explain the result.' }).result;
  assert.equal(followup.terminal.executionStatus, 'completed', JSON.stringify(followup));
  assert.equal(requests, 4);
  assert.equal(mutations, 1);
});
