import { parseJsonObject } from '@agent-core/json';
import { ArtifactIntegrityError, decodeOwnedArtifactRef, validatePublicArtifactRef,
  type ArtifactRef, type ArtifactRepository, type PublicArtifactRef } from '@agent-core/persistence';
import type { CollaborationCoordinator } from './coordinator.js';

export interface ParticipantArtifactRepositoryOptions {
  readonly artifacts: ArtifactRepository;
  readonly participantId: string;
  readonly coordinator: () => CollaborationCoordinator | Promise<CollaborationCoordinator>;
}
export interface ParticipantArtifactRepository extends ArtifactRepository {
  /** Host-only attribution for outputs produced by a shared command/resource owner. */
  recordProducedArtifact(artifact: PublicArtifactRef): Promise<void>;
}
export class ParticipantArtifactAccessError extends Error {
  readonly code = 'participant_artifact_denied';
  constructor(readonly artifactId: string) {
    super(`Participant artifact access is not granted: ${artifactId}.`);
    this.name = 'ParticipantArtifactAccessError';
  }
}

/** The same body store, with durable participant ownership at every public read boundary. */
export function createParticipantArtifactRepository(options: ParticipantArtifactRepositoryOptions): ParticipantArtifactRepository {
  if (!options.participantId.length || options.participantId.length > 1024) throw new TypeError('Invalid artifact participant identity.');
  const participantId = options.participantId;
  const canRead = async (artifact: PublicArtifactRef | string) => (await options.coordinator()).canReadPublicArtifact(participantId, artifact);
  const authorize = async (artifact: PublicArtifactRef) => {
    if (!await canRead(artifact)) throw new ParticipantArtifactAccessError(artifact.artifactId);
  };
  const recordProducedArtifact = async (value: PublicArtifactRef) => {
    const artifact = ownArtifact(value);
    validatePublicArtifactRef(artifact);
    await (await options.coordinator()).recordPublicArtifact(participantId, artifact);
  };
  return Object.freeze<ParticipantArtifactRepository>({
    recordProducedArtifact,
    async store(input) {
      const artifact = await options.artifacts.store(input);
      await recordProducedArtifact(artifact);
      return artifact;
    },
    // Protected inference state remains inside the host's canonical execution ownership.
    // It never becomes resolvable by the model-facing public artifact tool.
    storeProtected: input => options.artifacts.storeProtected(input),
    async resolve(artifactId) {
      if (artifactId.startsWith('protected-')) return undefined;
      if (!await canRead(artifactId)) return undefined;
      const value = await options.artifacts.resolve(artifactId);
      if (!value) return undefined;
      const artifact = ownArtifact(value);
      validatePublicArtifactRef(artifact);
      if (artifact.artifactId !== artifactId) throw new ArtifactIntegrityError(artifactId, 'Artifact resolution changed the requested identity.');
      await authorize(artifact);
      return artifact;
    },
    async readVerified(value) {
      const artifact = ownArtifact(value);
      if (artifact.visibility === 'protected') return options.artifacts.readVerified(artifact);
      await authorize(artifact);
      const bytes = await options.artifacts.readVerified(artifact);
      await authorize(artifact);
      return bytes;
    },
    async readVerifiedRange(value, request) {
      const artifact = ownArtifact(value);
      const range = Object.freeze({ offset: request.offset, length: request.length });
      if (artifact.visibility === 'protected') return options.artifacts.readVerifiedRange(artifact, range);
      await authorize(artifact);
      const bytes = await options.artifacts.readVerifiedRange(artifact, range);
      await authorize(artifact);
      return bytes;
    }
  });
}

function ownArtifact(value: ArtifactRef): ArtifactRef {
  return Object.freeze(decodeOwnedArtifactRef(parseJsonObject(value)));
}
