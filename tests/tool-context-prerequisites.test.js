import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { AgentRuntime, agentEventCodec } from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { defineTool } from '@agent-core/tools';

test('host guidance is presented before a mutation without using its tool output schema or presenter', async () => {
  let mutations = 0,
    preparations = 0,
    needsGuidance = true,
    requests = 0;
  const events = new InMemoryEventRepository(agentEventCodec);
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
          return { kind: 'result', ok: true, summary: 'Written.', scope: { resources: ['value'], coverage: 'complete' }, output: { written: input.value } };
        }
      };
    },
    presentObservation({ observation }) {
      assert.equal(observation.output.written, 'new');
      return {
        ok: true,
        title: 'Written value',
        summary: 'Written.',
        results: { written: observation.output.written }
      };
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
      return { provider: 'fixture', model: 'fixture', content: 'Done.', terminationReason: 'stop' };
    }
  };
  const runtime = new AgentRuntime({
    provider,
    model: 'fixture',
    tools: [tool],
    toolPolicy: { allowedRisks: ['write'] },
    toolBoundary: { authorizationPolicyId: 'allow-write', executionTargetId: 'value' },
    repositories: { events, artifacts: new InMemoryArtifactRepository() },
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
  });
  const result = await runtime.run({ runId: 'guidance-run', task: 'Update the value.' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'completed', JSON.stringify(result.terminal));
  assert.equal(mutations, 1);
  assert.equal(preparations, 1);
  const starts = [];
  for await (const record of events.read('guidance-run'))
    if (record.event.type === 'tool.started') starts.push(record.event.callId);
  assert.deepEqual(starts, ['reconsidered-call']);
});
