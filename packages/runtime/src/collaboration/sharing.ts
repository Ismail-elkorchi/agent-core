import { decodeUtf8, isTextMediaType, hashArtifactBytes, hashJson, type ArtifactRepository, type EventRepository } from '@agent-core/persistence';
import type { AgentEvent } from '../events.js';
import { HistoryReader } from '../history/reader.js';
import type { SessionDescriptor, SessionRepository, SessionPeerContributionEntry } from '../session/contracts.js';
import { sessionStateTextRange } from '../session/session-state.js';
import { scopedShareGrantSchema, scopedShareMaterialBodySchema, ownScopedShareMaterial, type ScopedShareGrant, type ScopedShareMaterial, type ScopedShareAuthorizationStage, type ScopedShareLimits } from './share-contracts.js';
export type {
  PeerEndpoint, ScopedShareSource, ScopedShareGrant, ScopedShareAuthorizationStage,
  ScopedShareMaterial, ScopedShareLimits
} from './share-contracts.js';

export interface ScopedShareServiceOptions {
  readonly repository: SessionRepository;
  readonly artifacts?: ArtifactRepository;
  readonly events?: EventRepository<AgentEvent>;
  /** Host resolves only identities it has already admitted to this collaboration. */
  readonly resolveSession: (sessionId: string) => Promise<SessionDescriptor>;
  /** Checks exact grant scope/revision and access; new publication also requires the current epoch. */
  readonly authorize: (grant: ScopedShareGrant, stage: ScopedShareAuthorizationStage) => Promise<void>;
  readonly authorizePeerContribution?: (entry: SessionPeerContributionEntry, stage: 'read' | 'admit') => Promise<void>;
}
/** Explicit export/import boundary. No cross-session search or provider-native state escapes it. */
export class ScopedShareService {
  constructor(private readonly options: ScopedShareServiceOptions) {}

  async read(value: ScopedShareGrant, limits: ScopedShareLimits): Promise<ScopedShareMaterial> {
    const grant = scopedShareGrantSchema.parse(value);
    const maxBytes = bounded(limits.maxBytes, 1024 * 1024, 'maxBytes');
    const maxSourceBytes = bounded(limits.maxSourceBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024, 'maxSourceBytes');
    if (grant.source.range.bytes > maxBytes || Buffer.byteLength(JSON.stringify(grant)) + grant.source.range.bytes > maxBytes)
      throw new Error('Shared material envelope exceeds its result byte allowance.');
    await this.options.authorize(grant, 'read');
    let content: string, sourceType: ScopedShareMaterial['sourceType'], sourceRole: ScopedShareMaterial['sourceRole'];
    let mediaType = 'text/plain';
    const source = grant.source;
    if (source.kind === 'public_artifact') {
      if (!this.options.artifacts) throw new Error('Shared artifacts require an artifact repository.');
      if (!isTextMediaType(source.artifact.mediaType))
        throw new Error('Shared artifact materialization requires a textual public representation.');
      if (source.artifact.size > maxSourceBytes) throw new Error('Shared artifact exceeds its source byte allowance.');
      const range = await this.options.artifacts.readVerifiedRange(source.artifact, { offset: source.range.offset, length: source.range.bytes });
      if (range.offset !== source.range.offset || range.end !== source.range.offset + source.range.bytes)
        throw new Error('Shared artifact range must be exact and aligned to UTF-8 boundaries.');
      content = decodeUtf8(range.bytes); mediaType = source.artifact.mediaType;
      sourceType = 'public_artifact'; sourceRole = 'tool';
    } else {
      if (source.cut.sessionId !== grant.sender.sessionId || (source.kind === 'history' && source.source.sessionId !== grant.sender.sessionId))
        throw new Error('Shared source is outside the exact sender session.');
      const session = await this.options.resolveSession(grant.sender.sessionId);
      if (session.id !== grant.sender.sessionId) throw new Error('Resolved shared session identity changed.');
      const history = new HistoryReader({ repository: this.options.repository, session,
        ...(this.options.events ? { events: this.options.events } : {}),
        ...(this.options.artifacts ? { artifacts: this.options.artifacts } : {}),
        ...(this.options.authorizePeerContribution ? { authorizePeerContribution: this.options.authorizePeerContribution } : {}) });
      await history.validateCut(source.cut);
      if (source.kind === 'history') {
        const metadata = await history.metadata(source.source, source.cut);
        if (metadata?.type === 'peer_contribution') throw new Error('Imported peer contributions cannot be transitively reshared. Request a distinct original-source grant for the new recipient.');
        const excerpts = await history.readExcerpts([{ source: source.source, ...source.range }], source.cut, maxSourceBytes);
        const excerpt = excerpts[0];
        if (!excerpt || excerpts.length !== 1) throw new Error('Shared history source is unavailable.');
        if (!['input', 'steering', 'assistant', 'tool_call', 'observation'].includes(excerpt.type))
          throw new Error('Shared history requires a public textual contribution.');
        content = excerpt.text;
        sourceType = excerpt.type as ScopedShareMaterial['sourceType']; sourceRole = excerpt.role;
      } else {
        if (!this.options.artifacts) throw new Error('Shared session-state requires an artifact repository.');
        const revision = await this.options.repository.readSessionStateItem(session, { itemId: source.itemId, revisionId: source.revisionId }, source.cut.throughEntryId);
        if (revision.deleted || revision.contentSha256 !== source.contentSha256)
          throw new Error('Shared session-state revision identity changed.');
        if (revision.contentBytes > maxSourceBytes) throw new Error('Shared session-state exceeds its source byte allowance.');
        const original = await this.options.artifacts.readVerified(revision.contentRef);
        if (original.byteLength !== revision.contentBytes || hashArtifactBytes(original) !== source.contentSha256)
          throw new Error('Shared session-state content identity changed.');
        content = sessionStateTextRange(decodeUtf8(original), source.range.offset, source.range.bytes);
        sourceType = 'session_state'; sourceRole = 'assistant';
      }
    }
    // Revalidate after asynchronous reads: revocation during materialization cannot publish data.
    await this.options.authorize(grant, 'read');
    const body = scopedShareMaterialBodySchema.parse({ grant, text: content, mediaType, sourceType, sourceRole, contentSha256: hashArtifactBytes(Buffer.from(content)) });
    const material = ownScopedShareMaterial({ ...body, fingerprint: hashJson(body) });
    if (Buffer.byteLength(JSON.stringify(material)) > maxBytes) throw new Error('Shared material envelope exceeds its result byte allowance.');
    return material;
  }

  async materialize(grant: ScopedShareGrant, limits: ScopedShareLimits): Promise<ScopedShareMaterial> {
    await this.options.authorize(scopedShareGrantSchema.parse(grant), 'materialize');
    const material = await this.read(grant, limits);
    await this.options.authorize(material.grant, 'materialize');
    return material;
  }

  /** Host authority-only fence, safe when the source material was already verified. */
  async authorizeGrant(value: ScopedShareGrant, stage: ScopedShareAuthorizationStage): Promise<void> {
    await this.options.authorize(scopedShareGrantSchema.parse(value), stage);
  }

  async authorizeMaterial(value: ScopedShareMaterial, stage: ScopedShareAuthorizationStage, limits: { readonly maxSourceBytes?: number } = {}): Promise<void> {
    const material = ownScopedShareMaterial(value);
    const exact = await this.read(material.grant, { maxBytes: 1024 * 1024, ...(limits.maxSourceBytes === undefined ? {} : { maxSourceBytes: limits.maxSourceBytes }) });
    if (exact.fingerprint !== material.fingerprint) throw new Error('Shared material does not match its authorized original source.');
    await this.options.authorize(material.grant, stage);
  }
}
function bounded(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`Invalid shared material ${name}.`);
  return value;
}
