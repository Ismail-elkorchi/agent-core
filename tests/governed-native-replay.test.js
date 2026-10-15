import { recordInferenceEvents } from './inference-audit-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderContextState } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  InferenceService,
  InMemoryInferenceRepository,
  InMemorySessionRepository,
  HistoryReader,
  ContextService,
  agentEventCodec
} from '@agent-core/runtime';

const profile = {
  id: 'native',
  provider: 'fixture',
  capabilities: {
    streaming: false,
    toolCalling: false,
    supportedToolInputs: [],
    jsonMode: false,
    jsonSchema: false,
    logprobs: false,
    temperature: false,
    topP: false,
    protocol: {
      version: 1,
      revision: 'replay1',
      endpoint: 'fixture',
      roles: ['system', 'developer', 'user', 'assistant'],
      inputKinds: ['text', 'protocol'],
      outputKinds: ['text', 'protocol'],
      state: 'exact',
      continuation: 'replay',
      asyncTools: false,
      steering: 'next_request',
      contextReset: 'fresh_request',
      toolChoice: ['auto'],
      counting: 'estimate'
    }
  },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 20000, outputTokens: 256 },
  supportedParameters: ['maxOutputTokens'],
  pricing: { currency: 'USD', rates: { input: 1, output: 2 } }
};
async function fixture({ budget, admitRequest } = {}) {
  const artifacts = new InMemoryArtifactRepository();
  const repository = new InMemoryInferenceRepository();
  const inferenceAudit = recordInferenceEvents(repository);
  const requests = [];
  const provider = {
    id: 'fixture',
    implementationId: 'fixture-replay@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'native' }),
    describeModel: async () => profile,
    async complete(request) {
      requests.push(request);
      return {
        provider: 'fixture',
        model: 'native',
        content: 'Original complete answer.',
        terminationReason: 'stop',
        usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 }
      };
    }
  };
  const inference = new InferenceService({
    provider,
    repository,
    artifacts,
    ...(admitRequest ? { admitRequest } : {}),
    ...(budget ? { budget } : {})
  });
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'test/native-context', schemaVersion: 1, subject: {} }
  });
  const events = new InMemoryEventRepository(agentEventCodec);
  const history = new HistoryReader({ repository: sessions, session, events, artifacts });
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    policy: { maxSourceBytes: 1000000, selfContained: true }
  });
  const options = {
    provider,
    model: 'native',
    maxOutputTokens: 64,
    inferenceService: inference,
    context,
    contextItems: [{
      id: 'environment', sourceUri: 'application://environment', sourceKind: 'external',
      representation: 'full', mediaType: 'text/plain', title: 'Environment',
      content: 'Unchanged environment.', purpose: 'Execution context.'
    }],
    repositories: { events, artifacts, session: { repository: sessions, descriptor: session } },
    toolBoundary: { authorizationPolicyId: 'none', executionTargetId: 'none' }
  };
  return {
    artifacts,
    repository,
    inference,
    sessions,
    session,
    events,
    history,
    context,
    options,
    inferenceAudit,
    requests
  };
}
test('ordinary runtime output replays typed provider protocol unchanged into the next run', async () => {
  const state = await fixture();
  const originalComplete = state.options.provider.complete;
  let protocol;
  state.options.provider.complete = async (request) => {
    const response = await originalComplete(request);
    if (!protocol) {
      protocol = await createProviderContextState({
        protocolRevision: 'replay1',
        provider: 'fixture',
        endpoint: 'fixture',
        request,
        requestId: 'response-origin',
        kind: 'fixture.reasoning',
        requiresExactPrefix: false,
        data: { opaque: 'original-provider-payload' },
        tokenCount: 16
      });
      return {
        ...response,
        output: [
          { type: 'protocol', state: protocol },
          { type: 'text', text: response.content }
        ]
      };
    }
    return response;
  };
  assert.equal(
    (await new AgentRuntime(state.options).run({ task: 'First full source.' }).result).terminal
      .executionStatus,
    'completed'
  );
  assert.equal(
    (
      await new AgentRuntime(state.options).run({ task: 'Continue the same original source.' })
        .result
    ).terminal.executionStatus,
    'completed'
  );
  assert.deepEqual(
    state.requests
      .at(-1)
      .messages.filter((item) => item.role === 'protocol')
      .map((item) => item.state),
    [protocol]
  );
});
