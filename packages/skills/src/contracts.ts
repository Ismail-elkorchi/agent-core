import * as z from 'zod';

export const SKILL_LIMITS = Object.freeze({ packages: 2_048, sources: 64, files: 256, depth: 8,
  pathBytes: 1_024, fileBytes: 2 * 1024 * 1024, packageBytes: 8 * 1024 * 1024,
  instructionBytes: 128 * 1024, frontmatterBytes: 16 * 1024, selection: 64, dependencies: 256,
  discoveryItems: 64, discoveryBytes: 128 * 1024, scanPackages: 32, scanBytes: 16 * 1024 * 1024,
  readBytes: 128 * 1024, selectionBytes: 1024 * 1024 });
const identifier = z.string().min(1).max(256).refine(value => !hasControl(value));
export const skillReferenceSchema = z.strictObject({ scopeId: identifier, packageId: identifier,
  revision: z.string().regex(/^[a-f0-9]{64}$/u), bindingRevision: identifier });
export const skillSelectionReferencesSchema = z.array(skillReferenceSchema).max(SKILL_LIMITS.selection).readonly();
export const skillSelectionBudgetSchema = z.int().positive().max(SKILL_LIMITS.selectionBytes);
export const skillDiscoveryRequestSchema = z.strictObject({ scopeId: identifier,
  query: z.string().max(1024).optional(), offset: z.int().nonnegative().max(SKILL_LIMITS.packages).optional(),
  limit: z.int().positive().max(SKILL_LIMITS.discoveryItems).optional(),
  maxBytes: z.int().positive().max(SKILL_LIMITS.discoveryBytes).optional(),
  maxScanned: z.int().positive().max(SKILL_LIMITS.scanPackages).optional(),
  maxScanBytes: z.int().positive().max(SKILL_LIMITS.scanBytes).optional(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional() });
export const skillScopeDiscoveryRequestSchema = z.strictObject({
  offset: z.int().nonnegative().max(SKILL_LIMITS.sources).optional(),
  limit: z.int().positive().max(SKILL_LIMITS.sources).optional(),
  maxBytes: z.int().positive().max(SKILL_LIMITS.discoveryBytes).optional(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional()
});
export const skillResourcePathSchema = z.string().min(1).max(SKILL_LIMITS.pathBytes)
  .regex(/^(?![\s\S]*\p{Cc})(?!\/)(?!.*\\)(?!.*:)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)(?:[^/]+\/){0,7}[^/]+$/u);
export const skillResourceRangeSchema = z.strictObject({ offset: z.int().nonnegative().max(SKILL_LIMITS.fileBytes),
  length: z.int().positive().max(SKILL_LIMITS.readBytes) });
export const skillResourceReadRequestSchema = z.strictObject({ ref: skillReferenceSchema, path: skillResourcePathSchema,
  ...skillResourceRangeSchema.shape });
export const skillLoadRequestSchema = z.strictObject({ ref: skillReferenceSchema, maxBytes: skillSelectionBudgetSchema.optional() });
export type SkillReference = Readonly<z.infer<typeof skillReferenceSchema>>;
export function parseSkillReference(value: unknown): SkillReference { return Object.freeze(skillReferenceSchema.parse(value)); }
export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  /** Untrusted requests, never tool definitions, grants, or approval. */
  readonly requestedTools: readonly string[];
}
export interface SkillResource { readonly path: string; readonly sha256: string; readonly size: number }
export interface SkillManifest {
  readonly format: 'agent-core.skill.v1';
  readonly metadata: SkillMetadata;
  readonly resources: readonly SkillResource[];
  readonly totalBytes: number;
  readonly instructionsSha256: string;
  readonly instructionsBytes: number;
}
export interface SkillPackage { readonly reference: SkillReference; readonly manifest: SkillManifest; readonly instructions: string }
export interface SkillPackageInput { readonly packageId: string; readonly files: readonly SkillFileInput[] }
export interface SkillFileInput { readonly path: string; readonly content: string | Uint8Array }
export interface SkillDescriptor { readonly reference: SkillReference; readonly name: string; readonly description: string }
export interface SkillScopeDescriptor { readonly scopeId: string; readonly bindingRevision: string }
export type SkillScopeDiscoveryRequest = Readonly<z.infer<typeof skillScopeDiscoveryRequestSchema>>;
export interface SkillScopeDiscoveryPage {
  /** Only currently readable source descriptors contribute to this revision. */
  readonly revision: string;
  readonly items: readonly SkillScopeDescriptor[];
  readonly coverage: 'complete' | 'partial';
  readonly nextOffset?: number;
}
export interface SkillDiscoveryRequest {
  readonly scopeId: string;
  readonly query?: string | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxScanned?: number | undefined;
  readonly maxScanBytes?: number | undefined;
  readonly expectedRevision?: string | undefined;
}
export interface SkillDiscoveryPage {
  readonly scopeId: string;
  /** Exact configured inventory and authority binding; package content is bound by each reference. */
  readonly revision: string;
  readonly items: readonly SkillDescriptor[];
  readonly diagnostics: readonly { readonly packageId: string; readonly code: string; readonly message: string }[];
  readonly scanned: number;
  readonly scannedBytes: number;
  readonly coverage: 'complete' | 'partial';
  readonly nextOffset?: number;
}
export interface SkillResourceRead {
  readonly reference: SkillReference; readonly resource: SkillResource;
  readonly offset: number; readonly end: number; readonly bytes: Uint8Array;
}
export interface SkillAccessRequest {
  readonly scopeId: string;
  readonly bindingRevision: string;
  readonly action: 'discover' | 'read' | 'dispatch';
  /** Package identities are available before any mutable-directory bytes are read. */
  readonly packageIds: readonly string[];
  readonly references: readonly SkillReference[];
}
export type SkillAccessCheck = (request: SkillAccessRequest, signal?: AbortSignal) => Promise<void>;
/** Host-owned fence. Revocation must serialize against this callback; a check alone is insufficient. */
export type SkillAccessFence = <T>(request: SkillAccessRequest, operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
export interface SkillSourceOptions {
  readonly scopeId: string;
  readonly bindingRevision: string;
  readonly access?: SkillAccessCheck;
  readonly withAccess?: SkillAccessFence;
}
export interface SkillPackageSource {
  readonly scopeId: string;
  /** Read only granted scope identity; undefined exposes no information about a denied source. */
  describeScope(signal?: AbortSignal): Promise<SkillScopeDescriptor | undefined>;
  discover(request: SkillDiscoveryRequest, signal?: AbortSignal): Promise<SkillDiscoveryPage>;
  load(reference: SkillReference, signal?: AbortSignal): Promise<SkillPackage>;
  /** Return bytes from verified immutable content. A partial range has no standalone proof from the whole-resource digest. */
  readResource(reference: SkillReference, path: string, range: { readonly offset: number; readonly length: number }, signal?: AbortSignal): Promise<SkillResourceRead>;
  assertAvailable(references: readonly SkillReference[], signal?: AbortSignal): Promise<void>;
  withAvailable<T>(references: readonly SkillReference[], operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export class SkillPackageError extends Error {
  constructor(readonly code: 'invalid_package' | 'resource_limit' | 'revision_unavailable' | 'access_denied' | 'unsafe_path' | 'unsupported_source' | 'invalid_range', message: string, readonly scannedBytes = 0) {
    super(message); this.name = 'SkillPackageError';
  }
}
export function skillIdentifier(value: unknown, label: string): string {
  const parsed = identifier.safeParse(value);
  if (!parsed.success) throw new SkillPackageError('invalid_package', `Invalid skill ${label}.`);
  return parsed.data;
}
export function skillResourcePath(value: unknown): string {
  if (!skillResourcePathSchema.safeParse(value).success) throw new SkillPackageError('unsafe_path', 'Skill resources require a bounded, relative path without aliases or traversal.');
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > SKILL_LIMITS.pathBytes ||
    value.length === 0 || (/[\\:]/u.test(value) || hasControl(value)) ||
    value.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
    value.split('/').length > SKILL_LIMITS.depth)
    throw new SkillPackageError('unsafe_path', 'Skill resources require a bounded, relative path without aliases or traversal.');
  return value;
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) return true;
  return false;
}
