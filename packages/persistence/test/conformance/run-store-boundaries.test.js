import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashJson, InMemoryEventRepository } from '@agent-core/persistence';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { AgentRunCoordinator, AgentRuntime, agentEventCodec } from '@agent-core/runtime';

const stores = [
  ['memory', async () => ({ repository: new InMemoryEventRepository(agentEventCodec), dispose: async () => undefined })],
  ['jsonl', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'agent-run-boundaries-'));
    return {
      repository: new JsonlEventRepository({ rootDir: directory, codec: agentEventCodec }),
      dispose: () => rm(directory, { recursive: true, force: true })
    };
  }]
];

for (const [storeName, createStore] of stores) {
  for (const timing of ['before', 'after']) {
    test(`${storeName} run acceptance has one explicit recovery state after a ${timing}-commit fault`, async () => {
      const { repository, dispose } = await createStore();
      const runId = `${storeName}-accept-${timing}`;
      try {
        const faulted = new OneShotConditionalFault(repository, timing);
        await assert.rejects(new AgentRunCoordinator(faulted).accept(acceptance(runId)), /injected conditional append fault/u);
        const runs = new AgentRunCoordinator(repository);
        if (timing === 'before') {
          await assert.rejects(runs.inspect(runId), /no durable run/u);
          assert.deepEqual(await runs.listUnfinished(), []);
        } else {
          const recovered = await runs.inspect(runId);
          assert.equal(recovered.state.phase.kind, 'accepted');
          assert.deepEqual(recovered.instruction, { kind: 'wait', reason: 'driver' });
        }
      } finally {
        await dispose();
      }
    });

    test(`${storeName} driver claim has one fenced generation after a ${timing}-commit fault`, async () => {
      const { repository, dispose } = await createStore();
      const runId = `${storeName}-claim-${timing}`;
      try {
        const runs = new AgentRunCoordinator(repository);
        await runs.accept(acceptance(runId));
        const faulted = new AgentRunCoordinator(new OneShotConditionalFault(repository, timing));
        await assert.rejects(faulted.attach(runId, 'uncertain-driver'), /injected conditional append fault/u);
        const afterFault = await runs.inspect(runId);
        assert.equal(afterFault.state.driverGeneration, timing === 'before' ? 0 : 1);
        assert.equal(afterFault.state.control.status, timing === 'before' ? 'detached' : 'owned');
        const replacement = await runs.attach(runId, 'replacement-driver');
        assert.equal(replacement.state().driverGeneration, timing === 'before' ? 1 : 2);
        assert.equal(replacement.state().control.status, 'owned');
        assert.equal(replacement.state().control.driverId, 'replacement-driver');
      } finally {
        await dispose();
      }
    });
  }
}

test('an integrity-audited corrupt JSONL run is quarantined before provider execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-run-quarantine-'));
  const runId = 'quarantined-run';
  try {
    const repository = new JsonlEventRepository({ rootDir: directory, codec: agentEventCodec });
    const runs = new AgentRunCoordinator(repository);
    await runs.accept(acceptance(runId, {
      providerId: 'quarantine-provider',
      providerImplementationId: 'agent-core.tests.quarantine-provider@1',
      runtimeImplementationId: 'agent-core.runtime.run-v1',
      disposition: {
        implementationId: 'agent-core.disposition.accept-v1',
        policyIdentity: { strategy: 'accept' },
        policyHash: hashJson({ strategy: 'accept' })
      },
      policyHash: hashJson({ allowedRisks: ['read'] })
    }));
    await runs.attach(runId, 'original-driver');

    const ledger = repository.location(runId);
    const lines = (await readFile(ledger, 'utf8')).split('\n');
    lines[1] = lines[1].replace('Perform one durable run.', 'Corrupt one durable run.');
    await writeFile(ledger, lines.join('\n'));

    const reopened = new JsonlEventRepository({ rootDir: directory, codec: agentEventCodec });
    const integrity = await reopened.verifyIntegrity(runId);
    assert.equal(integrity.ok, false);
    let providerCalls = 0;
    const provider = {
      id: 'quarantine-provider',
      implementationId: 'agent-core.tests.quarantine-provider@1',
      describe() { return { id: this.id, displayName: 'Quarantine provider', defaultModel: 'fixture' }; },
      async describeModel() {
        providerCalls += 1;
        return {
          id: 'fixture', provider: this.id, modalities: { input: ['text'], output: ['text'] },
          capabilities: { streaming: false, toolCalling: false, supportedToolInputs: [], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
          limits: { contextTokens: 1_000, outputTokens: 100 }, supportedParameters: ['maxOutputTokens']
        };
      },
      async complete() {
        providerCalls += 1;
        return { content: 'must not execute', model: 'fixture', provider: this.id, terminationReason: 'stop' };
      }
    };
    const runtime = new AgentRuntime({
      provider,
      model: 'fixture',
      toolBoundary: { authorizationPolicyId: 'test-policy', executionTargetId: 'test-target' },
      repositories: { events: new JsonlEventRepository({ rootDir: directory, codec: agentEventCodec }) }
    });
    await assert.rejects(runtime.resume(runId).result, /quarant|integrity|hash mismatch/iu);
    assert.equal(providerCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class OneShotConditionalFault {
  fired = false;
  constructor(repository, timing) {
    this.repository = repository;
    this.timing = timing;
  }
  append(runId, event, options) { return this.repository.append(runId, event, options); }
  async appendConditional(runId, event, options) {
    if (!this.fired && this.timing === 'before') {
      this.fired = true;
      throw new Error('injected conditional append fault before commit');
    }
    const result = await this.repository.appendConditional(runId, event, options);
    if (!this.fired && this.timing === 'after') {
      this.fired = true;
      throw new Error('injected conditional append fault after commit');
    }
    return result;
  }
  tail(runId) { return this.repository.tail(runId); }
  latest(runId) { return this.repository.latest(runId); }
  latestOfType(runId, type) { return this.repository.latestOfType(runId, type); }
  read(runId) { return this.repository.read(runId); }
  listRunIds() { return this.repository.listRunIds(); }
  verifyIntegrity(runId) { return this.repository.verifyIntegrity(runId); }
}

function acceptance(runId, configuration = {}) {
  return {
    runId,
    finalizationId: `${runId}:final`,
    input: { task: 'Perform one durable run.', instructions: [], contextItems: [] },
    configuration: {
      providerId: 'fixture',
      providerImplementationId: 'agent-core.tests.run-boundary-provider@1',
      model: 'fixture',
      runtimeImplementationId: 'agent-core.tests.run-boundary-runtime@1',
      toolImplementationIds: [],
      checks: [],
      disposition: {
        implementationId: 'agent-core.tests.accept-disposition@1',
        policyIdentity: { strategy: 'accept' },
        policyHash: hashJson({ strategy: 'accept' })
      },
      policyHash: 'run-boundary-policy',
      ...configuration
    }
  };
}
