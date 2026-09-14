import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import {
  AgentRuntime,
  AgentSession,
  AgentRunCoordinator,
  agentEventCodec,
  ModelWindow,
  ModelRequestAssembler
} from '@agent-core/runtime';
import { LocalArtifactRepository } from '@agent-core/persistence/node';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = { schemaId: 'tests/native-input', schemaVersion: 1, subject: {} };
const imageBytes = new Uint8Array(2 * 1024 * 1024).fill(31);
const modelImage = {
  type: 'base64',
  mediaType: 'image/png',
  data: Buffer.from(imageBytes).toString('base64'),
  detail: 'original'
};
const profile = {
  id: 'fixture',
  provider: 'fixture',
  capabilities: {
    reasoning: { strategies: [], canDisable: false, separateOutput: true },
    streaming: false,
    toolCalling: false,
    supportedToolInputs: [],
    jsonMode: false,
    jsonSchema: false,
    logprobs: false,
    temperature: false,
    topP: false
  },
  modalities: { input: ['text', 'image'], output: ['text'] },
  limits: { contextTokens: 100000, outputTokens: 128 },
  supportedParameters: ['maxOutputTokens']
};

test('native images survive queued revision, restart, provider encoding material and later history replay', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-native-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = new LocalArtifactRepository({ rootDir: path.join(directory, 'artifacts') });
  const image = {
    artifact: await artifacts.store({
      label: 'image',
      content: imageBytes,
      mediaType: 'image/png'
    }),
    detail: 'original'
  };
  const sessions = new JsonlSessionRepository(path.join(directory, 'sessions'));
  const descriptor = await sessions.create({ binding });
  await sessions.enqueueSubmission(descriptor, {
    submissionId: 'submission',
    runId: 'run-image',
    input: { task: 'Inspect the attachment.', images: [image] },
    configuration: { provider: 'fixture', model: 'fixture' }
  });
  const requests = [];
  const provider = {
    id: 'fixture',
    implementationId: 'fixture/native-input',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'fixture' }),
    describeModel: async () => profile,
    complete: async (request) => {
      requests.push(request);
      return {
        provider: 'fixture',
        model: 'fixture',
        content: 'Observed.',
        reasoning: 'Visible reasoning.',
        reasoningSummary: 'Summary.',
        terminationReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
      };
    }
  };
  const repository = new JsonlSessionRepository(path.join(directory, 'sessions'));
  const reopened = await repository.open(descriptor.id, binding);
  const events = new InMemoryEventRepository(agentEventCodec);
  const runtime = new AgentRuntime({
    provider,
    model: 'fixture',
    maxOutputTokens: 64,
    toolBoundary: { authorizationPolicyId: 'tests/none', executionTargetId: 'tests/images' },
    repositories: { events, artifacts, session: { repository, descriptor: reopened } }
  });
  const session = new AgentSession({
    expectedBinding: binding,
    runs: new AgentRunCoordinator(events, artifacts),
    createRuntime: () => runtime,
    repository,
    descriptor: reopened,
    configuration: { provider: 'fixture', model: 'fixture' },
    scheduling: 'manual'
  });
  await session.restore();
  const pending = await repository.loadPendingSubmissions(reopened);
  assert.deepEqual(pending[0].input.images, [image]);
  const first = await session.startNextSubmission();
  const firstResult = await first.completion;
  assert.equal(firstResult.state, 'ended');
  assert.equal(
    firstResult.terminal.executionStatus,
    'completed',
    JSON.stringify(firstResult.terminal)
  );
  const second = await runtime.run({ task: 'What did you observe?' }).result;
  assert.equal(second.state, 'ended');
  assert.equal(second.terminal.executionStatus, 'completed', JSON.stringify(second.terminal));
  for (const request of requests) {
    const images = request.messages.flatMap((message) => message.images ?? []);
    assert.deepEqual(images, [modelImage]);
    assert.ok(!request.messages.some((message) => message.content?.includes(modelImage.data)));
  }
  const recorded = await new JsonlSessionRepository(
    path.join(directory, 'sessions')
  ).readConversation(reopened);
  assert.deepEqual(recorded.find((entry) => entry.type === 'input').images, [image]);
  assert.equal(
    recorded.find((entry) => entry.type === 'assistant').reasoning,
    'Visible reasoning.'
  );
});

test('one image budget covers current input and selected history, including native parts', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const image = {
    artifact: await artifacts.store({ label: 'image', content: imageBytes, mediaType: 'image/png' })
  };
  const window = new ModelWindow(undefined, {
    maxCount: 1,
    maxBytes: 10 * 1024 * 1024,
    maxEstimatedTokens: 10000
  });
  window.recordSourceItem('previous', {
    role: 'user',
    content: 'Previous image',
    parts: [{ type: 'image', image: modelImage }]
  });
  const assembler = new ModelRequestAssembler(undefined, artifacts);
  await assert.rejects(
    () =>
      assembler.assemble({
        window,
        task: 'Compare',
        images: [image],
        instructions: [],
        tools: [],
        modelProfile: profile
      }),
    /images exceed/
  );
  await assert.rejects(
    () =>
      assembler.assemble({
        window: new ModelWindow(),
        task: 'Inspect',
        images: [image],
        instructions: [],
        tools: [],
        modelProfile: { ...profile, modalities: { input: ['text'], output: ['text'] } }
      }),
    /image-capable model/
  );
});
