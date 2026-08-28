import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as z from 'zod';
import path from 'node:path';
import { AgentRuntime, agentEventCodec } from '@agent-core/runtime';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/evidence/node';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { adoptToolDefinition, ResourceLeaseCoordinator } from '@agent-core/tools';

const [mode, root, runId, approvalId, fingerprint] = process.argv.slice(2);
if (!mode || !root) throw new Error('mode and root are required');

const storedEvents = new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
const events = mode === 'crash_after_ended' || mode === 'crash_before_started' || mode === 'crash_before_projection' ? {
  async append(...args) {
    return storedEvents.append(...args);
  },
  async appendConditional(...args) {
    const phase = args[1]?.type === 'operation.transition' ? args[1].state.phase : undefined;
    if (mode === 'crash_before_started' && phase?.kind === 'tools' && phase.callStates.some((call) => call.stage === 'effect_pending')) process.exit(45);
    const result = await storedEvents.appendConditional(...args);
    if (mode === 'crash_after_ended' && phase?.kind === 'tools' && phase.callStates.some((call) => call.stage === 'settled')) process.exit(43);
    if (mode === 'crash_before_projection' && phase?.kind === 'tools' && phase.callStates.some((call) => call.stage === 'projecting')) process.exit(47);
    return result;
  },
  tail: (...args) => storedEvents.tail(...args),
  latestOfType: (...args) => storedEvents.latestOfType(...args),
  read: (...args) => storedEvents.read(...args),
  listRunIds: (...args) => storedEvents.listRunIds(...args),
  verifyIntegrity: (...args) => storedEvents.verifyIntegrity(...args)
} : storedEvents;
const sessions = new JsonlSessionRepository({ rootDir: path.join(root, 'sessions') });
const artifacts = new LocalArtifactRepository(path.join(root, 'artifacts'));
const sessionId = 'crash-recovery';
const recoveryKind = await readFile(path.join(root, 'recovery-kind.txt'), 'utf8').then((value) => value.trim(), () => 'unknown');
if (mode === 'suspend') await sessions.create({ id: sessionId, provider: 'fixture', model: 'fixture' });
else await sessions.open(sessionId);

const provider = {
  id: 'fixture',
  implementationId: 'agent-core.tests.approval-crash-provider@1',
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
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'fixture/source' }, { mode: 'write', scope: 'fixture/effect' }], lockScopes: ['fixture/effect'] },
  decodeInput() { return { ok: true, input: {} }; }, canonicalizeInput(input) { return input; }, snapshotInput(input) { return input; }, async deriveEffects() {
    if (recoveryKind === 'preconditioned') {
      return {
        accesses: [{ mode: 'read', scope: 'fixture/source' }], lockScopes: [],
        recovery: { kind: 'preconditioned_reexecution', preconditions: [{ resource: 'fixture/source', validatorId: 'tests/source-sha256@1', expectedVersion: await sourceVersion() }] }
      };
    }
    if (recoveryKind === 'buffered') {
      return {
        accesses: [{ mode: 'write', scope: 'fixture/effect' }], lockScopes: ['fixture/effect'],
        recovery: { kind: 'buffered_mutation', authority: 'tests/fixture-journal@1', reconcilerId: 'tests/fixture-reconciler@1', transactionId: 'effect-1' }
      };
    }
    return { accesses: [{ mode: 'write', scope: 'fixture/effect' }], lockScopes: ['fixture/effect'], recovery: { kind: 'unknown' } };
  },
  async recover(_input, effect) {
    if (effect.intent.recovery.kind === 'preconditioned_reexecution') {
      const preconditions = effect.intent.recovery.preconditions;
      return await sourceVersion() === preconditions[0]?.expectedVersion
        ? { status: 'reexecute', preconditions }
        : { status: 'unavailable', reason: 'The source changed after the interrupted read.' };
    }
    if (effect.intent.recovery.kind === 'buffered_mutation') {
      const receipt = await readFile(path.join(root, 'buffered-receipt.json'), 'utf8').then(JSON.parse, () => undefined);
      return receipt?.transactionId === effect.intent.recovery.transactionId
        ? { status: 'settled', observation: { kind: 'result', ok: true, output: {}, summary: 'reconciled buffered mutation', scope: { resources: ['fixture/effect'], coverage: 'complete' } } }
        : { status: 'not_found', reason: 'No committed mutation receipt exists.' };
    }
    return { status: 'unavailable', reason: 'Unknown effects cannot be reconciled.' };
  },
  async invoke(_input, context) {
    if (recoveryKind === 'buffered') await appendFile(path.join(root, 'buffered-receipt.json'), JSON.stringify({ transactionId: 'effect-1' }));
    if (recoveryKind === 'preconditioned') {
      const expected = context.invocation?.recovery?.preconditions[0]?.expectedVersion;
      if (context.invocation?.toolAttempt > 1 && await sourceVersion() !== expected) throw new Error('Recovered read precondition changed before invocation.');
      await readFile(path.join(root, 'source.txt'));
    }
    await appendFile(path.join(root, 'effect.txt'), 'effect\n');
    if (mode === 'crash') process.exit(42);
    return { kind: 'result', ok: true, output: {}, summary: 'effect happened again', scope: { resources: ['fixture/effect'], coverage: 'complete' } };
  }
};

async function sourceVersion() {
  return createHash('sha256').update(await readFile(path.join(root, 'source.txt'))).digest('hex');
}

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
  toolResourceLeases: resourceLeases,
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
  const result = mode === 'recover'
    ? await agent.resume(runId).result
    : await (await agent.resolveApproval({ runId, approvalId, fingerprint, decision: 'allow' })).result;
  process.stdout.write(JSON.stringify(result.state === 'ended' ? result.terminal : result));
}
