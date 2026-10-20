import * as z from 'zod';
import { parseJsonValue, parseJsonObject, type JsonValue } from '@agent-core/json';
import { decodeOwnedArtifactRef, validateArtifactRef, type ArtifactRef } from '@agent-core/persistence';
import type { SessionStateItemRef, SessionStateItemRevision, SessionStatePageRequest, SessionStateBatchCommit, SessionStateBatchReceipt } from '../session/session-state.js';

const id = z.string().min(1).max(512);
/** Ownership and audience are host facts. Subjects never determine access. */
export type MaterialOwner =
  | { readonly kind: 'session'; readonly sessionId: string; readonly branchId: string }
  | { readonly kind: 'scope'; readonly scopeId: string };
export const materialOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: id, branchId: id }).readonly(),
  z.strictObject({ kind: z.literal('scope'), scopeId: id }).readonly()
]);
export interface QualifiedMaterialRef extends SessionStateItemRef { readonly owner: MaterialOwner }
export const qualifiedMaterialRefSchema = z.strictObject({ owner: materialOwnerSchema, itemId: id, revisionId: id,
  range: z.strictObject({ offset: z.int().nonnegative(), bytes: z.int().positive() }).readonly().optional() }).readonly();
export const materialArtifactSourceInputSchema = z.strictObject({ artifactId:id,sha256:z.string().regex(/^[a-f0-9]{64}$/u),size:z.int().nonnegative(),mediaType:z.string().min(1),visibility:z.enum(['public','protected']),label:z.string().optional(),description:z.string().optional() }).refine(value=>{try{validateArtifactRef(value);return true;}catch{return false;}},'Invalid artifact reference.').readonly();
export const materialArtifactSourceSchema = materialArtifactSourceInputSchema.transform(value=>decodeOwnedArtifactRef(parseJsonObject(value)));
export const materialSubjectInputSchema = z.json();
export const materialSubjectSchema = materialSubjectInputSchema.transform(value=>parseJsonValue(value,{maxTotalBytes:16384,maxDepth:32}));
export interface MaterialProvenance {
  readonly subject?: JsonValue | undefined;
  /** Declared derivation only; absence does not prove semantic independence. */
  readonly dependencies?: readonly QualifiedMaterialRef[] | undefined;
  readonly artifactSources?: readonly ArtifactRef[] | undefined;
}
export interface MaterialGrant {
  readonly owner: MaterialOwner;
  readonly revision: string;
  readonly read: boolean;
  readonly write: boolean;
}
export const materialGrantSchema = z.strictObject({ owner: materialOwnerSchema, revision: id, read: z.boolean(), write: z.boolean() }).readonly();
export interface MaterialGrantPage { readonly items: readonly MaterialGrant[]; readonly coverage: 'complete'|'partial'; readonly cursor?: string | undefined }
export interface MaterialGrantProvider {
  get(owner: MaterialOwner): Promise<MaterialGrant | undefined>;
  list(request?: SessionStatePageRequest): Promise<MaterialGrantPage>;
  /** Host changes to this grant must use the same guard. get() must remain read-only and usable inside the guard. */
  withGrant<T>(owner: MaterialOwner, expectedRevision: string, access: 'read'|'write', operation: () => Promise<T>): Promise<T>;
}
export interface MaterialArtifactUseDependency {readonly ref:ArtifactRef;readonly revision:string;readonly access:'read'|'transfer'}
export interface MaterialArtifactAuthority {
  /** Return a non-reusable current authority revision, or reject unavailable exact provenance. */
  capture(ref:ArtifactRef,access:'read'|'transfer'):Promise<string>;
  /** Acquired after session and material scope locks. Changes use the same fence; no inference or network work inside. */
  withAuthority<T>(dependencies:readonly MaterialArtifactUseDependency[],operation:()=>Promise<T>):Promise<T>;
}
export const materialArtifactUseDependencySchema=z.strictObject({ref:materialArtifactSourceSchema,revision:id,access:z.enum(['read','transfer'])}).readonly();
export interface MaterialUseDependency {
  readonly ref: QualifiedMaterialRef;
  readonly grantRevision: string;
  readonly revocationRevision: number;
  readonly artifacts?:readonly MaterialArtifactUseDependency[]|undefined;
}
/** A host repository checks this immutable owner epoch under its publication lock. */
export interface MaterialAuthorityBoundary {readonly owner:MaterialOwner;readonly revocationRevision:number}
/** Captured outside the session lock; repositories validate local boundaries before entering shared authority. */
export interface MaterialPublicationGuard {
  readonly boundaries: readonly MaterialAuthorityBoundary[];
  withAuthority<T>(operation:()=>Promise<T>):Promise<T>;
}
export const materialUseDependencySchema = z.strictObject({ ref: qualifiedMaterialRefSchema, grantRevision: id,
  revocationRevision: z.int().nonnegative(),artifacts:z.array(materialArtifactUseDependencySchema).max(256).readonly().optional() }).readonly();
export interface MaterialRevocation {
  readonly owner: MaterialOwner;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly refs: readonly SessionStateItemRef[];
}
export interface MaterialRevocationReceipt { readonly owner: MaterialOwner; readonly operationId: string; readonly revision: number; readonly refs: readonly SessionStateItemRef[] }
export interface MaterialPage {
  readonly revocationRevision: number;
  readonly items: readonly (QualifiedMaterialRef & Pick<SessionStateItemRevision,'contentBytes'|'contentSha256'|'preview'>)[];
  readonly coverage: 'complete'|'partial';
  readonly cursor?: string | undefined;
}
export interface MaterialRepository {
  /** All owner publication locks are acquired in canonical order; reads remain available inside. */
  withOwners<T>(owners: readonly MaterialOwner[], operation: () => Promise<T>): Promise<T>;
  findBatch(owner: MaterialOwner, idempotencyKey: string): Promise<SessionStateBatchReceipt | undefined>;
  save(batch: SessionStateBatchCommit): Promise<SessionStateBatchReceipt>;
  current(owner: MaterialOwner, itemId: string): Promise<SessionStateItemRevision | undefined>;
  read(ref: QualifiedMaterialRef): Promise<SessionStateItemRevision>;
  list(owner: MaterialOwner, request?: SessionStatePageRequest): Promise<MaterialPage>;
  retainedBytes(owner: MaterialOwner): Promise<number>;
  revocationRevision(owner: MaterialOwner): Promise<number>;
  assertUsable(ref: QualifiedMaterialRef): Promise<void>;
  isRevoked(ref: QualifiedMaterialRef): Promise<boolean>;
  revoke(input: MaterialRevocation): Promise<MaterialRevocationReceipt>;
}
/** Physical erasure is an optional host operation, never a synonym for removal or revocation. */
export type MaterialErasureCoverage = 'removed'|'retained'|'unsupported';
export interface MaterialErasureReceipt {
  readonly targets: readonly QualifiedMaterialRef[];
  readonly coverage: readonly {
    readonly target: QualifiedMaterialRef;
    readonly bodies: MaterialErasureCoverage;
    readonly previews: MaterialErasureCoverage;
    readonly indexes: MaterialErasureCoverage;
    readonly caches: MaterialErasureCoverage;
    readonly retainedSharedBytes: number;
    readonly detail?: string | undefined;
  }[];
  readonly originalHistory: 'separately_governed';
  readonly requestSnapshots: 'separately_governed';
  readonly priorRemoteDelivery: 'not_erased';
  readonly semanticDerivation: 'unknown';
}
export interface MaterialErasureCapability {
  erase(targets: readonly QualifiedMaterialRef[]): Promise<MaterialErasureReceipt>;
}
export class MaterialAccessError extends Error {
  constructor(message = 'Material is unavailable under the current grant or revocation boundary.') { super(message); this.name = 'MaterialAccessError'; }
}
