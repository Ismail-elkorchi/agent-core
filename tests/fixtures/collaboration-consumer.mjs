import assert from 'node:assert/strict';
import * as runtime from '@agent-core/runtime';
import { JsonlCollaborationRepository } from '@agent-core/runtime/node';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { collaborationProvider } from './collaboration-provider.mjs';

for (const name of ['CollaborationCoordinator', 'InMemoryCollaborationRepository', 'EventCollaborationRepository', 'CollaborationConflictError', 'ScopedShareService', 'PeerDeliveryService', 'peerContributionFingerprint'])
  assert.equal(typeof runtime[name], 'function', `Missing public collaboration export ${name}.`);
for (const name of ['decodePeerContributionEntry', 'samePeerContribution', 'ownPeerContributionInput',
  'peerContributionInputSchema', 'peerContributionText', 'peerEndpointSchema', 'scopedShareRangeSchema',
  'publicShareArtifactInputSchema', 'scopedShareSourceInputSchema', 'scopedShareSourceSchema',
  'scopedShareGrantSchema', 'scopedShareMaterialBodySchema', 'scopedShareMaterialSchema',
  'ownScopedShareMaterial', 'collaborationGroupKey', 'publicArtifactOwnershipKey', 'hasFinal'])
  assert.equal(name in runtime, false, `Internal collaboration implementation leaked: ${name}.`);
for (const name of ['collaborationEventCodec', 'peerDeliveryEventCodec'])
  assert.equal(typeof runtime[name]?.decode, 'function', `Missing supported event codec ${name}.`);
assert.equal(runtime.JsonlCollaborationRepository, undefined);
assert.equal(typeof JsonlCollaborationRepository, 'function');
const fixture = collaborationProvider([{}]);
const repository = new runtime.InMemoryInferenceRepository();
const artifacts = new InMemoryArtifactRepository();
const service = new runtime.InferenceService({ provider: fixture.provider, repository, artifacts, budget: { maxInvocations: 1 } });
await service.registerBudgetScope({ ownerId: 'owner', participantId: 'peer', scopeId: 'scope', budget: { maxInvocations: 1 } });
const completed = await service.invoke({ ownerId: 'owner', participantId: 'peer', budgetScopeId: 'scope', invocationId: 'invocation', purpose: 'packed-collaboration', request: { model: fixture.profile.id, messages: [{ role: 'user', content: 'Complete.' }], maxOutputTokens: 64 } });
assert.equal(completed.status, 'settled');
const allowance = await service.inspectBudgetScopeAllowance('owner', 'scope');
assert.equal(allowance.participantId, 'peer');
const artifact = await artifacts.store({ label: 'evidence', mediaType: 'text/plain', content: Buffer.from('exact') });
const shares = new runtime.ScopedShareService({ repository: new runtime.InMemorySessionRepository(), artifacts,
  resolveSession: async () => { throw new Error('Artifact shares do not resolve sessions.'); }, authorize: async () => {} });
const material = await shares.materialize({ grantId: 'grant', revision: 1, groupId: 'group', correctionEpoch: 0,
  sender: { participantId: 'peer', sessionId: 'peer-session' }, recipient: { participantId: 'supervisor', sessionId: 'supervisor-session' },
  source: { kind: 'public_artifact', artifact, range: { offset: 0, bytes: 5 } } }, { maxBytes: 8192 });
assert.equal(material.text, 'exact');
await shares.authorizeMaterial(material, 'admit');
assert.equal(Object.isFrozen(material.grant.recipient), true);
const sessions = new runtime.InMemorySessionRepository();
const session = await sessions.create({ id: 'supervisor-session', binding: { schemaId: 'packed/collaboration', schemaVersion: 1, subject: {} } });
const body = { deliveryId: 'packed-delivery', groupId: 'group', sender: material.grant.sender, recipient: material.grant.recipient,
  assignmentId: 'assignment', assignmentRevision: 1, senderRunId: 'run', correctionEpoch: 0, content: 'Scoped finding.', shares: [material] };
const peer = new runtime.PeerDeliveryService({ sessions, events: new InMemoryEventRepository(runtime.peerDeliveryEventCodec), shares,
  authorizeAddress: async address => { assert.equal(address.recipient.sessionId, session.id); },
  authorize: async input => { assert.equal(input.recipient.sessionId, session.id); },
  withAuthorization: async (_input, operation) => operation(), resolveSession: async () => session });
const input = { ...body, fingerprint: runtime.peerContributionFingerprint(body) };
const receipt = await peer.deliver(input);
assert.deepEqual(await peer.deliver(input), receipt);
const imported = (await sessions.loadReplayState(session)).branch;
assert.equal(imported.length, 1);
assert.equal(imported[0].type, 'peer_contribution');
assert.equal(imported[0].authorship, 'model');

// The installed package must compose its ordinary session/runtime pipeline, not just expose names.
const participantFixture = collaborationProvider([{}, {}]);
const runEvents = new InMemoryEventRepository(runtime.agentEventCodec);
const runs = new runtime.AgentRunCoordinator(runEvents, artifacts);
const participantSessions = new runtime.InMemorySessionRepository();
const participantDescriptors = new Map();
const participantBinding = { schemaId: 'packed/participant', schemaVersion: 1, subject: {} };
const participantInference = new runtime.InferenceService({ provider: participantFixture.provider,
  repository: new runtime.InMemoryInferenceRepository(), artifacts, budget: { maxInvocations: 2 } });
const host = await runtime.CollaborationCoordinator.open({ groupId: 'packed-group', hostId: 'packed-host',
  supervisorSessionId: 'packed-supervisor', budgetOwnerId: 'packed-owner',
  repository: new runtime.EventCollaborationRepository(new InMemoryEventRepository(runtime.collaborationEventCodec)), runs, maxWaitMs: 5000,
  async createSession({ participant, binding }) {
    let descriptor = participantDescriptors.get(participant.sessionId);
    if (!descriptor) {
      descriptor = await participantSessions.create({ id: participant.sessionId, binding: participantBinding });
      participantDescriptors.set(participant.sessionId, descriptor);
    }
    await participantInference.registerBudgetScope({ ownerId: binding.budgetOwnerId,
      participantId: binding.participantId, scopeId: binding.budgetScopeId, budget: { maxInvocations: 2 } });
    return new runtime.AgentSession({ descriptor, expectedBinding: participantBinding, repository: participantSessions,
      configuration: { provider: participantFixture.provider.id, model: participantFixture.profile.id }, runs,
      createRuntime(_configuration, onProgress) {
        return new runtime.AgentRuntime({ provider: participantFixture.provider, model: participantFixture.profile.id,
          maxOutputTokens: 64, inferenceService: participantInference, participant: binding, onProgress,
          toolBoundary: { authorizationPolicyId: 'packed-policy', executionTargetId: 'packed-target' },
          repositories: { artifacts, events: runEvents, session: { repository: participantSessions, descriptor } } });
      }
    });
  }
});
try {
  const first = await host.start({ operationId: 'start', participantId: 'packed-participant',
    assignmentId: 'packed-assignment', sessionId: 'packed-participant-session', task: 'Complete the packed assignment.',
    expectedEpoch: 0, capabilityRevision: 'packed-capability', capabilities: { toolNames: [] }, budgetScopeId: 'packed-scope' });
  let settled = await host.wait({ participantIds: ['packed-participant'], timeoutMs: 5000 });
  assert.equal(settled.reason, 'settled');
  assert.equal('runtime' in first, false);
  assert.equal('session' in first, false);
  const continued = await host.continue({ operationId: 'continue', participantId: 'packed-participant',
    assignmentId: first.assignment.assignmentId, task: 'Continue the packed assignment.', expectedEpoch: 0,
    capabilityRevision: first.assignment.capabilityRevision, capabilities: first.assignment.capabilities,
    budgetScopeId: first.assignment.budgetScopeId });
  assert.notEqual(continued.assignment.runId, first.assignment.runId);
  assert.equal(continued.assignment.revision, first.assignment.revision + 1);
  settled = await host.wait({ participantIds: ['packed-participant'], timeoutMs: 5000 });
  assert.equal(settled.reason, 'settled');
  const result = settled.participants[0].results.find(item => item.runId === continued.assignment.runId && item.kind === 'final');
  assert.ok(result);
  const output = await host.readResult({ resultId: result.resultId, maxBytes: 8192 });
  assert.equal(output.text, 'Complete.');
  assert.equal(output.classification, 'model_authored');
  assert.equal(output.executionStatus, 'completed');
  assert.equal(participantFixture.requests.length, 2);
} finally { await host.close(); }
console.log('Packed collaboration runtime contracts passed.');
