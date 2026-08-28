import { appendFile } from 'node:fs/promises';
import * as z from 'zod';
import path from 'node:path';
import { AgentRuntime, agentEventCodec } from '@agent-core/runtime';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/evidence/node';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { adoptToolDefinition, ResourceLeaseCoordinator } from '@agent-core/tools';

const [mode, root, runId, approvalId, fingerprint] = process.argv.slice(2);
if (!mode || !root) throw new Error('mode and root are required');

const storedEvents = new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
const events = mode === 'crash_after_ended' || mode === 'crash_before_started' ? {
  async append(...args) {
    if (mode === 'crash_before_started' && args[1]?.type === 'tool.started') process.exit(45);
    const record = await storedEvents.append(...args);
    if (args[1]?.type === 'tool.ended') process.exit(43);
    return record;
  },
  read: (...args) => storedEvents.read(...args),
  listRunIds: (...args) => storedEvents.listRunIds(...args),
  verifyIntegrity: (...args) => storedEvents.verifyIntegrity(...args)
} : storedEvents;
const sessions = new JsonlSessionRepository({ rootDir: path.join(root, 'sessions') });
const artifacts = new LocalArtifactRepository(path.join(root, 'artifacts'));
const sessionId = 'crash-recovery';
if (mode === 'suspend') await sessions.create({ id: sessionId, provider: 'fixture', model: 'fixture' });
else await sessions.open(sessionId);

const provider = {
  id: 'fixture',
  describe() { return { id: 'fixture', displayName: 'Fixture', defaultModel: 'fixture' }; },
  async describeModel() {
    return {
      id: 'fixture', provider: 'fixture', modalities: { input: ['text'], output: ['text'] },
      capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false },
      limits: { contextTokens: 8_000, outputTokens: 1_000 }, supportedParameters: ['maxOutputTokens']
    };
  },
  async complete() {
    if (mode === 'suspend') return { content: '', model: 'fixture', provider: 'fixture', terminationReason: 'tool_calls', toolCalls: [{ id: 'effect-1', type: 'function', name: 'effect', input: { kind: 'json', value: {} } }] };
    return { content: 'unexpected replay completed', model: 'fixture', provider: 'fixture', terminationReason: 'stop' };
  }
};

const tool = {
  name: 'effect', implementationId: 'tests/crash-effect@1', description: 'writes one externally visible marker', jsonSchema: { type: 'object' }, outputSchema: z.strictObject({}),
  effectEnvelope: { accesses: [{ mode: 'write', scope: 'fixture/effect' }], lockScopes: ['fixture/effect'] },
  decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, deriveEffects() { return { accesses: [{ mode: 'write', scope: 'fixture/effect' }], lockScopes: ['fixture/effect'], recovery: { kind: 'unknown' } }; },
  async invoke() {
    await appendFile(path.join(root, 'effect.txt'), 'effect\n');
    if (mode === 'crash') process.exit(42);
    return { kind: 'result', ok: true, output: {}, summary: 'effect happened again', scope: { resources: ['fixture/effect'], coverage: 'complete' } };
  }
};

const resourceLeases = new ResourceLeaseCoordinator();
if (mode === 'crash_waiting_for_lease') {
  await resourceLeases.acquire({ accesses: [{ mode: 'write', scope: 'fixture/effect' }], lockScopes: ['fixture/effect'], recovery: { kind: 'unknown' } }, 'fixture-blocker');
}

const agent = new AgentRuntime({
  provider,
  model: 'fixture',
  toolBoundary: { authorizationPolicyId: 'tests/crash-policy@1', executionTargetId: root },
  repositories: { events, session: { repository: sessions, sessionId }, artifacts },
  tools: [adoptToolDefinition(tool)],
  toolPolicy: { allowedRisks: ['read', 'write'] },
  toolAuthorizer: () => ({ decision: 'require_approval', reason: 'confirm crash fixture' }),
  toolContext: { services: { processManager: { resourceLeases } } },
  onProgress(event) {
    if (mode === 'crash_waiting_for_lease' && event.type === 'tool.updated' && event.progress.stage === 'resource_lease_waiting') process.exit(44);
  }
});

if (mode === 'suspend') {
  const result = await agent.run({ task: 'crash after approved effect with unknown recovery' }).result;
  const approval = result.pendingApprovals[0];
  process.stdout.write(JSON.stringify({ runId: result.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint }));
} else {
  if (!runId || !approvalId || !fingerprint) throw new Error('resume identity is required');
  const result = await (await agent.resumeApproval({ runId, approvalId, fingerprint, decision: 'allow' })).result;
  process.stdout.write(JSON.stringify(result.state === 'ended' ? result.terminal : result));
}
