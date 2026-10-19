import {
  AgentRuntime, CollaborationCoordinator, InMemoryCollaborationRepository, EventCollaborationRepository,
  collaborationEventCodec, peerDeliveryEventCodec,
  InferenceService, InMemoryInferenceRepository, InMemorySessionRepository, ScopedShareService,
  peerContributionFingerprint, PeerDeliveryService,
  type AgentRuntimeOptions, type CollaborationCoordinatorOptions, type CollaborationGroupState,
  type ParticipantExecutionBinding, type ParticipantView, type ParticipantStartInput,
  type ParticipantResultRecord, type PeerContributionInput, type ScopedShareGrant,
  type ScopedShareMaterial, type PeerDeliveryServiceOptions, type InferenceBudgetScopeBinding,
  type CollaborationEvent, type PeerDeliveryEvent, type CollaborationRepository,
  type CollaborationHostRequest, type CollaborationHostOwnership, type CollaborationLifetimeLock
} from '@agent-core/runtime';
import * as runtimeExports from '@agent-core/runtime';
import { InMemoryEventRepository, type EventCodec } from '@agent-core/persistence';
import { JsonlCollaborationRepository, JsonlInferenceRepository } from '@agent-core/runtime/node';
import type { ToolPlanningContext } from '@agent-core/tools';

declare const host: CollaborationCoordinator;
declare const options: CollaborationCoordinatorOptions;
declare const group: CollaborationGroupState;
declare const participant: ParticipantView;
declare const binding: ParticipantExecutionBinding;
declare const start: ParticipantStartInput;
declare const result: ParticipantResultRecord;
declare const share: ScopedShareGrant;
declare const material: ScopedShareMaterial;
declare const contribution: PeerContributionInput;
declare const inference: InferenceService;
declare const shares: ScopedShareService;
declare const peerOptions: PeerDeliveryServiceOptions;
declare const planningBase: Omit<ToolPlanningContext, 'recordedCanonicalInput'>;
const reboundPlanning: ToolPlanningContext = { ...planningBase, recordedCanonicalInput: { expectedEpoch: 0 } };
const peerService = new PeerDeliveryService(peerOptions);
const delivered = peerService.deliver(contribution);
const runtimeOptions: Pick<AgentRuntimeOptions, 'participant'> = { participant: binding };
const budget: InferenceBudgetScopeBinding = { participantId: 'peer', scopeId: 'scope', budget: { maxInvocations: 2 } };
const registered = inference.registerBudgetScope({ ...budget, ownerId: 'owner' });
const allowance = inference.inspectBudgetScopeAllowance('owner', 'scope');
const fingerprint: string = peerContributionFingerprint(contribution);
const authorization: Promise<void> = shares.authorizeMaterial(material, 'admit');
const repository = new InMemoryCollaborationRepository();
const disk = new JsonlCollaborationRepository({ rootDir: '/explicit/collaboration' });
const journal = new JsonlInferenceRepository({ rootDir: '/explicit/inference' });
const sessions = new InMemorySessionRepository();
const collaborationCodec: EventCodec<CollaborationEvent> = collaborationEventCodec;
const peerCodec: EventCodec<PeerDeliveryEvent> = peerDeliveryEventCodec;
const eventRepository: CollaborationRepository = new EventCollaborationRepository(new InMemoryEventRepository(collaborationCodec));
declare const hostRequest: CollaborationHostRequest;
declare const lock: CollaborationLifetimeLock;
const ownership: Promise<CollaborationHostOwnership> = eventRepository.acquireHost(hostRequest);
// @ts-expect-error Model-facing participant views cannot expose runtime authority.
participant.runtime;
// @ts-expect-error Model-facing participant views cannot expose session execution authority.
participant.session;
// @ts-expect-error Participant result records cannot carry a tool execution handle.
result.executionHandle;
// @ts-expect-error Assignment identity is immutable.
participant.assignment.runId = 'changed';
// @ts-expect-error Peer source scope cannot be widened after admission.
share.recipient.sessionId = 'unrelated-session';
// @ts-expect-error Imported peer contribution attribution is immutable.
contribution.sender.participantId = 'user';
// @ts-expect-error Group identity is immutable.
group.groupId = 'changed';
// @ts-expect-error The host-owned recorded plan hint is immutable.
reboundPlanning.recordedCanonicalInput = { expectedEpoch: 1 };
// @ts-expect-error Explicit Node adapter remains outside portable root exports.
import { JsonlCollaborationRepository as wrongAdapter } from '@agent-core/runtime';
// @ts-expect-error Host-owned execution guards are not optional participant bindings.
const unguarded: ParticipantExecutionBinding = { groupId: 'group', participantId: 'peer', sessionId: 'session', assignmentId: 'assignment', assignmentRevision: 1, runId: 'run', hostGeneration: 1, correctionEpoch: 0, capabilityRevision: 'capability', capabilities: { toolNames: [] }, budgetOwnerId: 'owner', budgetScopeId: 'scope' };
// @ts-expect-error Peer entry decoding is a repository implementation detail.
runtimeExports.decodePeerContributionEntry;
// @ts-expect-error Peer retry comparison is a repository implementation detail.
runtimeExports.samePeerContribution;
// @ts-expect-error Peer ownership capture is internal to the boundary.
runtimeExports.ownPeerContributionInput;
// @ts-expect-error Peer capture schemas are not a public parallel validation API.
runtimeExports.peerContributionInputSchema;
// @ts-expect-error Peer prompt projection is owned by history and replay.
runtimeExports.peerContributionText;
// @ts-expect-error Endpoint schemas are internal to the boundary.
runtimeExports.peerEndpointSchema;
// @ts-expect-error Range capture schemas are internal to the boundary.
runtimeExports.scopedShareRangeSchema;
// @ts-expect-error Public artifact input schemas are internal to the boundary.
runtimeExports.publicShareArtifactInputSchema;
// @ts-expect-error Share input schemas are internal to the boundary.
runtimeExports.scopedShareSourceInputSchema;
// @ts-expect-error Share ownership schemas are internal to the boundary.
runtimeExports.scopedShareSourceSchema;
// @ts-expect-error Grant capture schemas are internal to the boundary.
runtimeExports.scopedShareGrantSchema;
// @ts-expect-error Material fingerprint body schemas are internal to the boundary.
runtimeExports.scopedShareMaterialBodySchema;
// @ts-expect-error Material capture schemas are internal to the boundary.
runtimeExports.scopedShareMaterialSchema;
// @ts-expect-error Material ownership capture is internal to the boundary.
runtimeExports.ownScopedShareMaterial;
// @ts-expect-error Repository indexing keys are internal.
runtimeExports.collaborationGroupKey;
// @ts-expect-error Artifact ownership index keys are internal.
runtimeExports.publicArtifactOwnershipKey;
// @ts-expect-error Lifecycle reducer helpers are internal.
runtimeExports.hasFinal;
void [AgentRuntime, CollaborationCoordinator, InferenceService, InMemoryInferenceRepository, host, options, start, runtimeOptions, registered, allowance, fingerprint, authorization, repository, disk, journal, sessions, unguarded, delivered, reboundPlanning, eventRepository, peerCodec, lock, ownership];
