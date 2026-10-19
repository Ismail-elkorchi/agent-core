import { hashJson, PersistenceConflictError, type EventRepository, type ArtifactRepository } from '@agent-core/persistence';
import type { AgentEvent } from '../events.js';
import type { SessionDescriptor, SessionRepository, SessionPeerContributionEntry } from '../session/contracts.js';
import { peerContributionFingerprint, type PeerContributionInput } from '../session/peer-contribution.js';
import type { CollaborationCoordinator } from './coordinator.js';
import type { CollaborationGroupState, ParticipantView, ParticipantAssignment, CollaborationParticipant, ParticipantExecutionBinding } from './contracts.js';
import { PeerDeliveryService, type PeerDeliveryEvent } from './peer-delivery.js';
import { scopedShareSourceSchema, type PeerEndpoint, type ScopedShareSource, type ScopedShareGrant, type ScopedShareAuthorizationStage, type ScopedShareMaterial } from './share-contracts.js';
import { ScopedShareService } from './sharing.js';

const assignmentSourceContent = 'Selected source material for this assignment. Original attribution is retained.';

export interface CollaborationPeerDeliveryOptions {
  readonly coordinator: () => CollaborationCoordinator | Promise<CollaborationCoordinator>;
  readonly supervisorSession: () => SessionDescriptor;
  readonly supervisorRunId: () => string | undefined;
  readonly sessions: SessionRepository;
  readonly events: EventRepository<PeerDeliveryEvent>;
  readonly maxPendingDeliveries?: number;
  readonly historyEvents?: EventRepository<AgentEvent>;
  readonly artifacts?: ArtifactRepository;
  /** Additional host revocation/scope check; sender/session and recipient checks always apply. */
  readonly authorizeShare?: (grant: ScopedShareGrant, stage: ScopedShareAuthorizationStage) => Promise<void>;
  /** Public artifact visibility is host-wide, so explicit host scope is mandatory. */
  readonly authorizePublicArtifact?: (grant: ScopedShareGrant, stage: ScopedShareAuthorizationStage) => Promise<void>;
}
export interface CollaborationPeerSendInput {
  /** Host-bound actor identity. Never take this field from untrusted model arguments. */
  readonly actorParticipantId?: string;
  readonly actorAssignment?: Pick<ParticipantExecutionBinding, 'assignmentId' | 'assignmentRevision' | 'runId' | 'correctionEpoch' | 'capabilityRevision'> | undefined;
  readonly participantId: string;
  readonly content: string;
  readonly operationId: string;
  /** Captured by the host when the caller's canonical action is authorized. */
  readonly expectedEpoch?: number | undefined;
  readonly sourceRunId?: string | undefined;
  readonly sources?: readonly ScopedShareSource[];
}
/** Shared host adapter for explicit text and exact, host-authorized source exports. */
export function createCollaborationPeerDelivery(options: CollaborationPeerDeliveryOptions) {
  const supervisorId = () => `supervisor:${options.supervisorSession().id}`;
  const state = async () => (await options.coordinator()).authorizationState();
  const authorize = async (input: PeerContributionInput, stage: 'read' | 'admit' | 'publish', selectedSources?: readonly ScopedShareSource[]) => {
    const group = await state();
    if (group.groupId !== input.groupId || group.supervisorSessionId !== options.supervisorSession().id || input.correctionEpoch > group.epoch)
      throw new Error('Peer delivery group or captured correction epoch is unauthorized.');
    const publishing = stage === 'publish';
    if (publishing && group.epoch !== input.correctionEpoch) throw new Error('Peer publication correction epoch is stale.');
    const recipient = assertEndpoint(group, input.recipient, supervisorId(), !publishing);
    if (input.sender.participantId === supervisorId()) {
      if (input.sender.sessionId !== group.supervisorSessionId || input.assignmentId !== `${supervisorId()}:${input.senderRunId}` || input.assignmentRevision !== 1)
        throw new Error('Peer supervisor provenance is invalid.');
      if (publishing && options.supervisorRunId() !== input.senderRunId) {
        const sourceSender = recipient?.assignment.sourceSender;
        const initialSourceImport = recipient?.assignment.epoch === group.epoch &&
          input.deliveryId === assignmentSourceDeliveryId(recipient.participant, recipient.assignment) && input.content === assignmentSourceContent &&
          sourceSender?.participantId === input.sender.participantId && sourceSender.sessionId === input.sender.sessionId && sourceSender.runId === input.senderRunId &&
          hashJson(selectedSources ?? input.shares.map(share => share.grant.source)) === hashJson(recipient.assignment.initialSources);
        if (!initialSourceImport) throw new Error('Peer supervisor source run is no longer current.');
      }
    } else {
      const original = await (await options.coordinator()).findAssignment(input.sender.participantId, input.assignmentId, input.assignmentRevision, input.senderRunId);
      if (original?.participant.sessionId !== input.sender.sessionId || original.assignment.epoch !== input.correctionEpoch)
        throw new Error('Peer contribution does not match its original recorded sender assignment.');
      assertMessageAuthority(original.assignment, input.recipient.participantId);
      if (publishing) {
        const sender = requireParticipant(group, input.sender.participantId);
        if (sender.assignment.assignmentId !== input.assignmentId || sender.assignment.revision !== input.assignmentRevision ||
          sender.assignment.runId !== input.senderRunId || sender.assignment.epoch !== group.epoch)
          throw new Error('Peer sender assignment is no longer authorized to publish.');
      }
    }
  };
  const shares = new ScopedShareService({
    repository: options.sessions,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.historyEvents ? { events: options.historyEvents } : {}),
    resolveSession: sessionId => options.sessions.open(sessionId, options.supervisorSession().header.binding),
    authorize: async (grant, stage) => {
      const group = await state();
      const publishing = stage === 'materialize' || stage === 'publish';
      if (grant.groupId !== group.groupId || grant.correctionEpoch > group.epoch || grant.revision !== 1 || grant.grantId !== shareGrantId(grant))
        throw new Error('Peer share exact grant identity or captured correction epoch is unauthorized.');
      assertEndpoint(group, grant.recipient, supervisorId(), !publishing);
      if (publishing) {
        if (grant.correctionEpoch !== group.epoch) throw new Error('Peer share publication correction epoch is stale.');
        const sender = assertEndpoint(group, grant.sender, supervisorId());
        if (sender) {
          if (sender.assignment.epoch !== group.epoch) throw new Error('Peer source sender correction epoch is stale.');
          assertMessageAuthority(sender.assignment, grant.recipient.participantId);
        }
      }
      if (grant.source.kind === 'public_artifact') {
        if (!options.authorizePublicArtifact) throw new Error('Public artifacts require explicit host sharing scope.');
        await options.authorizePublicArtifact(grant, stage);
      } else if (grant.source.cut.sessionId !== grant.sender.sessionId ||
        (grant.source.kind === 'history' && grant.source.source.sessionId !== grant.sender.sessionId))
        throw new Error('Peer source is outside its sender-owned session.');
      await options.authorizeShare?.(grant, stage);
    }
  });
  const service = new PeerDeliveryService({
    events: options.events, sessions: options.sessions, shares,
    ...(options.maxPendingDeliveries === undefined ? {} : { maxPendingDeliveries: options.maxPendingDeliveries }),
    resolveSession: endpoint => options.sessions.open(endpoint.sessionId, options.supervisorSession().header.binding),
    authorize,
    authorizeAddress: async address => {
      const group = await state();
      if (group.groupId !== address.groupId || group.supervisorSessionId !== options.supervisorSession().id) throw new Error('Peer delivery recipient group is unauthorized.');
      assertEndpoint(group, address.recipient, supervisorId(), true);
    },
    withAuthorization: async (input, operation) => (await options.coordinator()).withCurrent(input.correctionEpoch, operation)
  });
  const prepareSelected = async (input: Omit<PeerContributionInput, 'fingerprint' | 'shares'>, sources: readonly ScopedShareSource[]) => {
    const material: ScopedShareMaterial[] = [];
    const body: Omit<PeerContributionInput, 'fingerprint'> = { ...input, shares: material };
    await authorize({ ...body, fingerprint: peerContributionFingerprint(body) }, 'publish', sources);
    let remaining = 1024 * 1024 - Buffer.byteLength(JSON.stringify(body)) - 128;
    for (const source of sources) {
      const scope = { groupId: body.groupId, sender: body.sender, recipient: body.recipient, correctionEpoch: body.correctionEpoch, source };
      const grant: ScopedShareGrant = { ...scope, grantId: shareGrantId(scope), revision: 1 };
      const exported = await shares.materialize(grant, { maxBytes: remaining, maxSourceBytes: Math.floor(8 * 1024 * 1024 / sources.length) });
      remaining -= Buffer.byteLength(JSON.stringify(exported)) + 1;
      material.push(exported);
    }
    return { ...body, fingerprint: peerContributionFingerprint(body) };
  };
  return Object.freeze({
    service,
    authorizeContribution: (entry: SessionPeerContributionEntry, stage: 'read' | 'admit') => service.authorizeContribution(entry, stage),
    importAssignmentSources(assignment: ParticipantAssignment, participant: CollaborationParticipant) {
      if (!assignment.initialSources.length) return Promise.resolve(undefined);
      return service.prepareAndDeliver(async () => {
        const deliveryId = assignmentSourceDeliveryId(participant, assignment);
        const address = { groupId: participant.groupId, recipient: { participantId: participant.participantId, sessionId: participant.sessionId }, deliveryId };
        const prior = await service.read(address, { maxBytes: 2 * 1024 * 1024 });
        if (prior) return prior.contribution;
        const group = await state();
        const recipient = requireParticipant(group, participant.participantId);
        if (group.groupId !== participant.groupId || recipient.participant.sessionId !== participant.sessionId ||
          recipient.assignment.assignmentId !== assignment.assignmentId || recipient.assignment.revision !== assignment.revision || recipient.assignment.runId !== assignment.runId || assignment.epoch !== group.epoch)
          throw new Error('Initial peer sources require the current exact recipient assignment.');
        const origin = assignment.sourceSender;
        if (!origin) throw new Error('Initial peer sources require persisted sender provenance.');
        const sender = assertEndpoint(group, origin, supervisorId());
        if (sender && (sender.assignment.runId !== origin.runId || sender.assignment.epoch !== group.epoch)) throw new Error('Initial source sender assignment is no longer current.');
        return prepareSelected({
          deliveryId,
          groupId: group.groupId, sender: { participantId: origin.participantId, sessionId: origin.sessionId },
          recipient: { participantId: participant.participantId, sessionId: participant.sessionId },
          assignmentId: sender?.assignment.assignmentId ?? `${supervisorId()}:${origin.runId}`,
          assignmentRevision: sender?.assignment.revision ?? 1,
          senderRunId: origin.runId, correctionEpoch: assignment.epoch,
          content: assignmentSourceContent
        }, ownSelectedSources(assignment.initialSources));
      });
    },
    send(request: CollaborationPeerSendInput) {
      return service.prepareAndDeliver(async () => {
        const supervisorRunId = request.sourceRunId ?? options.supervisorRunId();
        const sources = ownSelectedSources(request.sources ?? []);
        const group = await state();
        const actor = request.actorParticipantId ?? supervisorId();
        const captured = request.actorAssignment;
        // Authorize this actor's target before looking up any recipient journal body.
        let actorSessionId = group.supervisorSessionId;
        if (actor !== supervisorId()) {
          const authority = captured
            ? await (await options.coordinator()).findAssignment(actor, captured.assignmentId, captured.assignmentRevision, captured.runId)
            : requireParticipant(group, actor);
          if (!authority || (captured && (authority.assignment.epoch !== captured.correctionEpoch || authority.assignment.capabilityRevision !== captured.capabilityRevision)))
            throw new Error('Peer actor has no exact recorded assignment grant.');
          assertMessageAuthority(authority.assignment, request.participantId);
          actorSessionId = authority.participant.sessionId;
        } else if (captured) throw new Error('A supervisor peer call cannot carry a participant assignment.');
        const recipientView = request.participantId === supervisorId() ? undefined : requireParticipant(group, request.participantId, true);
        const recipient: PeerEndpoint = { participantId: recipientView?.participant.participantId ?? supervisorId(), sessionId: recipientView?.participant.sessionId ?? group.supervisorSessionId };
        const prior = await service.read({ groupId: group.groupId, recipient, deliveryId: request.operationId }, { maxBytes: 2 * 1024 * 1024 });
        if (prior) {
          const original = prior.contribution;
          const requestedRun = request.sourceRunId ?? captured?.runId ?? (actor === supervisorId() ? supervisorRunId : undefined);
          if (original.sender.participantId !== actor || original.sender.sessionId !== actorSessionId || original.content !== request.content ||
            hashJson(original.shares.map(share => share.grant.source)) !== hashJson(sources) ||
            (request.expectedEpoch !== undefined && original.correctionEpoch !== request.expectedEpoch) ||
            (requestedRun !== undefined && original.senderRunId !== requestedRun) ||
            (captured && (original.assignmentId !== captured.assignmentId || original.assignmentRevision !== captured.assignmentRevision || original.correctionEpoch !== captured.correctionEpoch)))
            throw new PersistenceConflictError(`Conflicting peer delivery ${request.operationId}.`);
          return original;
        }
        const expectedEpoch = request.expectedEpoch ?? group.epoch;
        if (expectedEpoch !== group.epoch) throw new Error('Peer publication correction epoch is stale.');
        const senderView = actor === supervisorId() ? undefined : requireParticipant(group, actor);
        if (captured && (senderView?.assignment.assignmentId !== captured.assignmentId ||
          senderView.assignment.revision !== captured.assignmentRevision || senderView.assignment.runId !== captured.runId ||
          senderView.assignment.epoch !== captured.correctionEpoch || senderView.assignment.capabilityRevision !== captured.capabilityRevision))
          throw new Error('Peer sender assignment binding is stale.');
        if (senderView && senderView.assignment.epoch !== group.epoch) throw new Error('Peer sender correction epoch is stale.');
        const sender = senderView?.participant ?? { participantId: supervisorId(), sessionId: group.supervisorSessionId };
        const senderRunId = captured?.runId ?? senderView?.assignment.runId ?? supervisorRunId;
        if (!senderRunId) throw new Error('A supervisor peer message requires its active run identity.');
        if (request.sourceRunId && request.sourceRunId !== senderRunId) throw new Error('Peer source invocation does not match its sender assignment.');
        return prepareSelected({
          deliveryId: request.operationId, groupId: group.groupId,
          sender: { participantId: sender.participantId, sessionId: sender.sessionId },
          recipient: { participantId: recipient.participantId, sessionId: recipient.sessionId },
          assignmentId: senderView?.assignment.assignmentId ?? `${supervisorId()}:${senderRunId}`,
          assignmentRevision: senderView?.assignment.revision ?? 1,
          senderRunId, correctionEpoch: expectedEpoch, content: request.content
        }, sources);
      });
    }
  });
}
function requireParticipant(group: CollaborationGroupState, participantId: string, allowInactive = false): ParticipantView {
  const value = group.participants.find(view => view.participant.participantId === participantId);
  if (!value || (!allowInactive && value.cancelled)) throw new Error('Peer participant is not a current collaboration member.');
  return value;
}
function assertEndpoint(group: CollaborationGroupState, endpoint: PeerEndpoint, supervisorId: string, allowInactive = false): ParticipantView | undefined {
  if (endpoint.participantId === supervisorId) {
    if (endpoint.sessionId !== group.supervisorSessionId) throw new Error('Peer supervisor session does not match.');
    return undefined;
  }
  const view = requireParticipant(group, endpoint.participantId, allowInactive);
  if (view.participant.sessionId !== endpoint.sessionId) throw new Error('Peer participant session does not match.');
  return view;
}

function shareGrantId(scope: Pick<ScopedShareGrant, 'groupId' | 'sender' | 'recipient' | 'correctionEpoch' | 'source'>): string {
  return `share-${hashJson({ groupId: scope.groupId, sender: scope.sender, recipient: scope.recipient, correctionEpoch: scope.correctionEpoch, source: scope.source })}`;
}

function assignmentSourceDeliveryId(participant: CollaborationParticipant, assignment: ParticipantAssignment): string {
  return `assignment-sources:${hashJson([participant.groupId, participant.participantId, assignment.assignmentId, assignment.revision, assignment.runId])}`;
}

function ownSelectedSources(values: readonly ScopedShareSource[]): readonly ScopedShareSource[] {
  if (values.length > 16) throw new RangeError('Peer delivery accepts at most 16 exact source scopes.');
  return values.map(source => scopedShareSourceSchema.parse(source));
}

function assertMessageAuthority(assignment: ParticipantAssignment, recipientId: string): void {
  const scope = assignment.capabilities.collaboration;
  if (!scope?.actions.includes('message') || !scope.participantIds.includes(recipientId))
    throw new Error('Peer sender assignment lacks explicit message authority for this recipient.');
}
