import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conservativeProtocolCapabilities } from '@agent-core/model';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { AgentRuntime, ContextService, HistoryReader, agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { admitContext } from './context-admission-fixtures.js';

test('stateless archived runs replay exact notices around corrections and respect a historical fork', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'state-notice-chronology-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new InMemoryArtifactRepository();
  const events = new InMemoryEventRepository(agentEventCodec);
  let repository = new JsonlSessionRepository(root);
  const session = await repository.create({ binding: { schemaId: 'notice-chronology', schemaVersion: 1, subject: {} } });
  const requests = [];
  const provider = {
    id: 'fixture', implementationId: 'fixture@1',
    describe: () => ({ id: 'fixture', displayName: 'Fixture', defaultModel: 'context' }),
    describeModel: async () => ({ id: 'context', provider: 'fixture', capabilities: {
      streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }],
      jsonMode: false, jsonSchema: false, logprobs: false, temperature: true, topP: false,
      protocol: conservativeProtocolCapabilities('fixture://context', {
        roles: ['system', 'developer', 'user', 'assistant'], contextReset: 'fresh_request'
      })
    }, modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 60000, outputTokens: 256 }, supportedParameters: ['maxOutputTokens', 'tools', 'temperature'] }),
    complete: async request => {
      requests.push(request);
      return { provider: 'fixture', model: 'context', content: 'Recorded answer.', terminationReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } };
    }
  };
  let history;
  let context;
  const connect = () => {
    history = new HistoryReader({ repository, session, events, artifacts });
    context = new ContextService({ repository, session, events, artifacts, history,
      policy: { maxSourceBytes: 1024 * 1024, historyRead: { history, isAvailable: () => true } } });
  };
  connect();
  const run = async (runId, task) => {
    const result = await new AgentRuntime({ provider, model: 'context', context, maxOutputTokens: 128,
      toolBoundary: { authorizationPolicyId: 'test', executionTargetId: 'test' },
      toolPolicy: { allowedRisks: ['read', 'write'] },
      repositories: { events, artifacts, session: { repository, descriptor: session } }
    }).run({ runId, task }).result;
    assert.equal(result.terminal?.executionStatus, 'completed', JSON.stringify(result));
    return requests.at(-1).messages;
  };
  const requestRef = await artifacts.storeProtected({ label: 'state-inference', mediaType: 'application/json',
    content: new TextEncoder().encode('{}') });
  const update = async (id, previousRevisionId, text) => {
    const cut = await history.capture();
    const result = await context.transition({ expectedWindowId: (await history.selectedContext(cut))?.windowId ?? null,
      idempotencyKey: id, reason: 'Update interpretation', selection: await context.selectSources(cut, {}),
      sessionState: { id, previousRevisionId, content: { blocks: [{ text }] }, capturedHistoryCut: cut,
        inference: { ownerId: 'owner', invocationId: id, requestRef } }
    }, { admit: admitContext });
    assert.equal(result.transition.strategy, 'append');
    return result;
  };
  await run('run-original', 'Original requirement');
  const first = await update('state-a', null, 'Original interpretation');
  await run('run-correction', 'Correction: use the revised requirement');
  const second = await update('state-b', 'state-a', 'Revised interpretation');
  repository = new JsonlSessionRepository(root);
  connect();
  const messages = await run('run-inspect', 'Inspect reconstructed context');
  const contents = messages.map(message => message.content);
  const firstNotice = first.window.stateSequence.notice.message;
  const secondNotice = second.window.stateSequence.notice.message;
  assert.deepEqual(messages.filter(message => message.content === firstNotice.content), [firstNotice]);
  assert.deepEqual(messages.filter(message => message.content === secondNotice.content), [secondNotice]);
  const positions = ['Original requirement', firstNotice.content, 'Correction: use the revised requirement',
    secondNotice.content, 'Inspect reconstructed context'].map(content => contents.indexOf(content));
  assert.ok(positions.every(index => index >= 0), JSON.stringify(contents));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  await repository.branchFrom(session, first.id, 'Before correction');
  repository = new JsonlSessionRepository(root);
  connect();
  const fork = await run('run-fork', 'Inspect historical fork');
  assert.deepEqual(fork.filter(message => message.content === firstNotice.content), [firstNotice]);
  assert.ok(!fork.some(message => message.content === secondNotice.content));
  assert.ok(!fork.some(message => message.content === 'Correction: use the revised requirement'));
  assert.ok(fork.findIndex(message => message.content === firstNotice.content) <
    fork.findIndex(message => message.content === 'Inspect historical fork'));
});
