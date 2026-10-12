import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonlEventRepository, LocalArtifactRepository, hashJson } from '@agent-core/persistence/node';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { AgentRuntime, ContextService, HistoryReader, agentEventCodec, createContextTools, createHistoryTools } from '@agent-core/runtime';

test('the first JSONL context-recovery boundary suspends for capacity without requiring index repair', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'first-context-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new JsonlSessionRepository(path.join(root, 'sessions'));
  const descriptor = await sessions.create({ binding: { schemaId: 'first-context-boundary', schemaVersion: 1, subject: {} } });
  const events = new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
  const artifacts = new LocalArtifactRepository(path.join(root, 'artifacts'));
  let requests = 0;
  const provider = {
    id: 'jsonl-capacity', implementationId: 'jsonl-capacity@1',
    describe: () => ({ id: 'jsonl-capacity', displayName: 'JSONL capacity fixture', defaultModel: 'small' }),
    describeModel: async () => ({ id: 'small', provider: 'jsonl-capacity',
      capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }],
        jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 64000, maxInputTokens: 500, outputTokens: 4000 },
      supportedParameters: ['tools', 'maxOutputTokens'] }),
    complete: async () => { requests++; throw new Error('No request fits this fixture.'); }
  };
  const task = 'Review the document. ' + 'source '.repeat(1000);
  const createRuntime = (repository, eventRepository) => {
    const history = new HistoryReader({ repository, session: descriptor, events: eventRepository, artifacts });
    const context = new ContextService({ repository, session: descriptor, history, artifacts,
      policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } } });
    return new AgentRuntime({ provider, model: 'small', context, contextRenewal: { automatic: true },
      maxOutputTokens: 512, tools: [...createContextTools({ context }), ...createHistoryTools({ history })],
      repositories: { events: eventRepository, artifacts, session: { repository, descriptor } },
      toolPolicy: { allowedRisks: ['read', 'write'] },
      toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' } });
  };
  const runtime = createRuntime(sessions, events);
  const result = await runtime.run({ runId: 'first-recovery', task }).result;
  assert.equal(result.state, 'suspended', JSON.stringify(result));
  assert.equal(result.reason, 'context_admission');
  assert.match(result.contextAdmission.message, /token limit exceeded/);
  assert.equal(requests, 0);
  const input = (await sessions.loadReplayState(descriptor)).branch.find(entry => entry.type === 'input');
  assert.equal(input.task, task);
  for (const missing of [false, true]) {
    const before = await readFile(events.location('first-recovery'));
    const tailPath = path.join(root, 'events', 'run-first-recovery.index', 'tail.json');
    if (missing) await rm(tailPath);
    else {
      const { routingRootHash: _root, contentHash: _hash, ...old } = JSON.parse(await readFile(tailPath, 'utf8'));
      old.version = 1;
      await writeFile(tailPath, JSON.stringify({ ...old, contentHash: hashJson(old) }));
    }
    const reopenedEvents = new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
    const resumed = await createRuntime(new JsonlSessionRepository(path.join(root, 'sessions')), reopenedEvents).resume('first-recovery').result;
    assert.equal(resumed.state, 'suspended', JSON.stringify({ missing, resumed }));
    assert.equal(resumed.reason, 'context_admission');
    assert.equal(requests, 0);
    assert.equal(reopenedEvents.indexMetrics().fullScans, 1, 'Normal run resumption owns derived-index recovery before metadata-only reads.');
    const tail = JSON.parse(await readFile(tailPath, 'utf8'));
    assert.equal(tail.version, 2);
    assert.match(tail.routingRootHash, /^[a-f0-9]{64}$/);
    assert.ok((await readFile(events.location('first-recovery'))).subarray(0, before.length).equals(before),
      'Automatic derived recovery never rewrites original event records.');
  }

});
