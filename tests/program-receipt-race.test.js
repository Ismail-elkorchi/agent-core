import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, InferenceService, InMemoryInferenceRepository, agentEventCodec } from '@agent-core/runtime';
import { defineTool } from '@agent-core/tools';
import { createProgrammaticTool } from '@agent-core/tools-programmatic';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a child settling during its stopped parent result commit still reaches the next model request', { timeout: 10000 }, async () => {
  const childEntered = deferred();
  const childRelease = deferred();
  const parentCommitting = deferred();
  const parentRelease = deferred();
  const wakeRelease = deferred();
  const childRecorded = deferred();
  let programInvocations = 0;
  let childInvocations = 0;
  class ObservedEvents extends InMemoryEventRepository {
    async appendConditional(runId, event, options) {
      const receipt = await super.appendConditional(runId, event, options);
      if ((receipt.kind === 'committed' || receipt.kind === 'already_committed') &&
          event.type === 'observation.record.created' && event.programId) childRecorded.resolve(event);
      return receipt;
    }
  }
  class DelayedParentArtifacts extends InMemoryArtifactRepository {
    async store(input) {
      if (input.label === 'run_program-model-content') {
        parentCommitting.resolve();
        await parentRelease.promise;
      }
      return super.store(input);
    }
  }
  const events = new ObservedEvents(agentEventCodec);
  const artifacts = new DelayedParentArtifacts();
  const read = defineTool({
    name: 'read_value', implementationId: 'receipt-race.read.v1', description: 'Read a value',
    schema: z.strictObject({ value: z.number() }),
    outputSchema: z.strictObject({ value: z.number(), hidden: z.string() }),
    invocationModes: ['direct', 'programmatic'],
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] },
    canonicalizeInput: value => value,
    deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [], recovery: { kind: 'unknown' } }),
    async invoke(input) {
      if (input.value === 99) await wakeRelease.promise;
      else { childInvocations++; childEntered.resolve(); await childRelease.promise; }
      return { kind: 'result', execution: { state: 'settled' }, summary: 'Value read',
        scope: { resources: ['memory'], coverage: 'complete' },
        output: { value: input.value, hidden: input.value === 7 ? 'private-child-output' : 'public' } };
    }
  });
  const requests = [];
  const provider = {
    id: 'receipt-race', implementationId: 'receipt-race.provider.v1',
    describe() { return { id: this.id, displayName: 'Receipt race test', defaultModel: 'test' }; },
    async describeModel(model) { return { id: model, provider: this.id,
      capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false,
        jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 32000, outputTokens: 2000 },
      supportedParameters: ['maxOutputTokens'] }; },
    async complete(request) {
      requests.push(request);
      return { model: request.model, provider: this.id, content: requests.length === 1 ? '' : 'done',
        terminationReason: requests.length === 1 ? 'tool_calls' : 'stop',
        ...(requests.length === 1 ? { toolCalls: [
          { type: 'function', id: 'program-call', name: 'run_program',
            input: { kind: 'json', value: { source: 'await call("read_value", {value:7});' } } },
          { type: 'function', id: 'wake-call', name: 'read_value', input: { kind: 'json', value: { value: 99 } } }
        ] } : {}) };
    }
  };
  const runtime = new AgentRuntime({ provider, model: 'test', maxOutputTokens: 500,
    tools: [createProgrammaticTool(), read],
    toolBoundary: { authorizationPolicyId: 'receipt-race', executionTargetId: 'receipt-race' },
    programRunner: { toolName: 'run_program', configurationRevision: 'receipt-race.runner.v1', async run({ call }) {
      programInvocations++;
      await call('read_value', { value: 7 });
      return { status: 'completed' };
    } },
    repositories: { events, artifacts },
    inferenceService: new InferenceService({ provider, repository: new InMemoryInferenceRepository(), artifacts }),
    limits: { maxConcurrentToolCalls: 2, totalToolCalls: 8, elapsedMs: 5000 }
  });
  const handle = runtime.run({ task: 'preserve the late child receipt', runId: 'program-receipt-race' });
  try {
    await childEntered.promise;
    handle.injectSteering({ instruction: 'Stop further child work.', deliveryId: 'receipt-race-stop' });
    await parentCommitting.promise;
    // The parent has already constructed an interrupted result but has not committed it.
    childRelease.resolve();
    // A parallel direct completion wakes the pump while that parent commit is blocked.
    wakeRelease.resolve();
    const child = await childRecorded.promise;
    parentRelease.resolve();
    const result = await handle.result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(requests.length, 2);
    assert.equal(programInvocations, 1);
    assert.equal(childInvocations, 1);
    const nextRequest = JSON.stringify(requests[1]);
    assert.match(nextRequest, /tool_outcome_unknown/);
    assert.ok(nextRequest.includes(`program-receipt:${child.id}`), 'the independently recorded child receipt was delivered');
    assert.match(nextRequest, /Program child settled after its program stopped/);
    assert.equal(nextRequest.includes('private-child-output'), false);
  } finally {
    childRelease.resolve();
    wakeRelease.resolve();
    parentRelease.resolve();
  }
});
