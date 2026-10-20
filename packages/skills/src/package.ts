import { parseDocument } from 'yaml';
import { parseJsonObject } from '@agent-core/json';
import { hashArtifactBytes, hashJson } from '@agent-core/persistence';
import { SKILL_LIMITS, SkillPackageError, parseSkillReference, skillIdentifier, skillResourcePath, skillResourceRangeSchema,
  type SkillFileInput, type SkillManifest, type SkillMetadata, type SkillPackage, type SkillReference,
  type SkillResource, type SkillResourceRead } from './contracts.js';

const ownedPackages = new WeakMap<object, SkillPackage>();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const typedArrayByteLengthDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object, 'byteLength');
export interface CapturedSkill { readonly value: SkillPackage; readonly files: ReadonlyMap<string, Uint8Array> }

/** Captures independent immutable content. No resource is imported, installed, or executed. */
export function captureSkill(input: { readonly scopeId: string; readonly bindingRevision: string;
  readonly packageId: string; readonly files: readonly SkillFileInput[] }): CapturedSkill {
  const scopeId = skillIdentifier(input.scopeId, 'scopeId');
  const bindingRevision = skillIdentifier(input.bindingRevision, 'bindingRevision');
  const packageId = skillIdentifier(input.packageId, 'packageId');
  const inputs: readonly SkillFileInput[] = input.files;
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > SKILL_LIMITS.files)
    throw new SkillPackageError('resource_limit', 'Skill package exceeds its file-count bound or has no SKILL.md.');
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const file of inputs) {
    const path = skillResourcePath(file.path);
    if (files.has(path)) throw new SkillPackageError('invalid_package', 'Duplicate skill resource path.');
    if (typeof file.content !== 'string' && !(file.content instanceof Uint8Array))
      throw new SkillPackageError('invalid_package', 'Skill resource content must be text or bytes.');
    const maximum = path === 'SKILL.md' ? SKILL_LIMITS.instructionBytes : SKILL_LIMITS.fileBytes;
    if (file.content.length > maximum) throw new SkillPackageError('resource_limit', 'Skill resource exceeds its byte bound.');
    const bytes = typeof file.content === 'string' ? encoder.encode(file.content) : new Uint8Array(file.content);
    if (bytes.length > maximum || totalBytes + bytes.length > SKILL_LIMITS.packageBytes)
      throw new SkillPackageError('resource_limit', 'Skill package or resource exceeds its byte bound.');
    totalBytes += bytes.length;
    files.set(path, bytes);
  }
  const skill = files.get('SKILL.md');
  if (!skill) throw new SkillPackageError('invalid_package', 'Skill package requires SKILL.md.');
  const parsed = parseSkillMarkdown(decode(skill));
  const resources = Object.freeze([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, bytes]) => Object.freeze({ path, sha256: hashArtifactBytes(bytes), size: bytes.length })));
  const manifest: SkillManifest = Object.freeze({ format: 'agent-core.skill.v1', metadata: parsed.metadata, resources, totalBytes,
    instructionsSha256: hashArtifactBytes(encoder.encode(parsed.instructions)), instructionsBytes: encoder.encode(parsed.instructions).length });
  const reference = parseSkillReference({ scopeId, packageId, bindingRevision,
    revision: hashJson(parseJsonObject(manifest, { maxTotalBytes: 256 * 1024, maxStringBytes: 16 * 1024, maxCollectionEntries: 4096 })) });
  const value = Object.freeze({ reference, manifest, instructions: parsed.instructions });
  ownedPackages.set(value, value);
  return { value, files };
}

export function parseSkillMarkdown(markdown: string): { readonly metadata: SkillMetadata; readonly instructions: string } {
  if (encoder.encode(markdown).length > SKILL_LIMITS.instructionBytes)
    throw new SkillPackageError('resource_limit', 'SKILL.md exceeds the instruction byte bound.');
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match?.[1] || encoder.encode(match[1]).length > SKILL_LIMITS.frontmatterBytes)
    throw new SkillPackageError('invalid_package', 'SKILL.md requires bounded YAML frontmatter delimited by ---.');
  let value: unknown;
  try {
    const document = parseDocument(match[1], { schema: 'core', uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0) throw new Error('Invalid YAML');
    value = document.toJS({ maxAliasCount: 0 });
  } catch { throw new SkillPackageError('invalid_package', 'Invalid skill YAML; custom tags, aliases, and duplicate keys are unsupported.'); }
  const data = parseJsonObject(value, { maxDepth: 3, maxTotalBytes: SKILL_LIMITS.frontmatterBytes,
    maxStringBytes: SKILL_LIMITS.frontmatterBytes, maxCollectionEntries: 256 });
  if (Object.keys(data).some(key => !['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(key)))
    throw new SkillPackageError('invalid_package', 'Unknown Agent Skills frontmatter field. Put extensions in metadata.');
  if (typeof data.name !== 'string' || data.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(data.name))
    throw new SkillPackageError('invalid_package', 'Skill name must be 1–64 lowercase letters, digits, and nonconsecutive hyphens.');
  const description = textField(data.description, 1024, 'description');
  const extra = data.metadata === undefined ? {} : parseJsonObject(data.metadata, { maxDepth: 1, maxTotalBytes: SKILL_LIMITS.frontmatterBytes });
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== 'string') throw new SkillPackageError('invalid_package', 'Skill metadata values must be strings.');
    Object.defineProperty(metadata, key, { value, enumerable: true });
  }
  const requestedTools = data['allowed-tools'] === undefined ? [] :
    textField(data['allowed-tools'], 4096, 'allowed-tools').split(/\s+/u);
  if (requestedTools.length > 128) throw new SkillPackageError('resource_limit', 'Too many requested tool names.');
  return Object.freeze({ metadata: Object.freeze({ name: data.name, description,
    ...(data.license !== undefined ? { license: textField(data.license, 4096, 'license') } : {}),
    ...(data.compatibility !== undefined ? { compatibility: textField(data.compatibility, 500, 'compatibility') } : {}),
    metadata: Object.freeze(metadata), requestedTools: Object.freeze([...new Set(requestedTools)]) }),
    instructions: markdown.slice(match[0].length) });
}

export function readCapturedResource(captured: CapturedSkill, reference: SkillReference, path: string,
  range: { readonly offset: number; readonly length: number }): SkillResourceRead {
  skillResourcePath(path);
  const resource = captured.value.manifest.resources.find(item => item.path === path);
  const content = captured.files.get(path);
  if (!resource || !content) throw new SkillPackageError('revision_unavailable', 'Resource is absent from this exact skill revision.');
  if (!skillResourceRangeSchema.safeParse(range).success) throw new SkillPackageError('invalid_range', 'Skill resource range is invalid or exceeds its byte bound.');
  if (range.offset > content.length)
    throw new SkillPackageError('invalid_range', 'Skill resource range is invalid or exceeds its byte bound.');
  const end = Math.min(range.offset + range.length, content.length);
  return captureSkillResourceRead({ reference, resource, offset: range.offset, end, bytes: content.subarray(range.offset, end) },
    { reference, resource, ...range });
}
/** The one source-result boundary for both built-in and external resource reads. */
export function captureSkillResourceRead(input: unknown, expected: {
  readonly reference: SkillReference; readonly resource: SkillResource; readonly offset: number; readonly length: number;
}): SkillResourceRead {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new SkillPackageError('invalid_package', 'Skill source returned an invalid resource read.');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 5 || keys.some(key => typeof key !== 'string' || !['reference', 'resource', 'offset', 'end', 'bytes'].includes(key)))
    throw new SkillPackageError('invalid_package', 'Skill source returned unknown or missing resource-read fields.');
  const field = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor))
      throw new SkillPackageError('invalid_package', 'Skill resource reads cannot contain accessors.');
    return descriptor.value;
  };
  const data = parseJsonObject({ reference: field('reference'), resource: field('resource'), offset: field('offset'), end: field('end') },
    { maxDepth: 3, maxTotalBytes: 8192, maxStringBytes: SKILL_LIMITS.pathBytes, maxCollectionEntries: 16 });
  const reference = parseSkillReference(data.reference);
  const resource = parseJsonObject(data.resource);
  const end = Math.min(expected.offset + expected.length, expected.resource.size);
  if (reference.scopeId !== expected.reference.scopeId || reference.packageId !== expected.reference.packageId ||
    reference.revision !== expected.reference.revision || reference.bindingRevision !== expected.reference.bindingRevision ||
    Object.keys(resource).length !== 3 || resource.path !== expected.resource.path ||
    resource.sha256 !== expected.resource.sha256 || resource.size !== expected.resource.size)
    throw new SkillPackageError('revision_unavailable', 'Skill source returned a resource outside the exact requested revision or manifest.');
  if (expected.offset > expected.resource.size || data.offset !== expected.offset || data.end !== end)
    throw new SkillPackageError('invalid_range', 'Skill source returned a resource range different from the requested exact range.');
  const value = field('bytes');
  if (!(value instanceof Uint8Array)) throw new SkillPackageError('invalid_package', 'Skill resource bytes must be a Uint8Array.');
  // Use the intrinsic byte length, so a source cannot shadow length properties
  // and induce an oversized allocation. Uint8Array copies native storage.
  const size: unknown = typedArrayByteLengthDescriptor?.get?.call(value);
  if (size !== end - expected.offset || typeof size !== 'number' || size > SKILL_LIMITS.readBytes)
    throw new SkillPackageError('invalid_range', 'Skill resource byte length differs from the exact bounded range.');
  const bytes = new Uint8Array(value);
  if (expected.offset === 0 && end === expected.resource.size && hashArtifactBytes(bytes) !== expected.resource.sha256)
    throw new SkillPackageError('revision_unavailable', 'Skill resource content digest differs from the selected manifest.');
  return Object.freeze({ reference: expected.reference, resource: expected.resource, offset: expected.offset, end, bytes });
}
export function decodeSkillResourceText(read: SkillResourceRead): string { return decode(read.bytes); }
function decode(bytes: Uint8Array): string {
  try { return decoder.decode(bytes); }
  catch { throw new SkillPackageError('invalid_range', 'Resource is not valid UTF-8 or the exact range splits a UTF-8 character.'); }
}
function textField(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum)
    throw new SkillPackageError('invalid_package', `Skill ${label} must be a nonempty string of at most ${String(maximum)} characters.`);
  return value;
}

/** Validates a remote/persisted package presentation against its exact content identity. */
export function parseSkillPackage(input: unknown, expected?: SkillReference): SkillPackage {
  const existing = input !== null && typeof input === 'object' ? ownedPackages.get(input) : undefined;
  if (existing) {
    if (expected && JSON.stringify(existing.reference) !== JSON.stringify(parseSkillReference(expected)))
      throw new SkillPackageError('revision_unavailable', 'Loaded skill reference differs from the exact requested revision.');
    return existing;
  }
  const data = parseJsonObject(input, { maxDepth: 8, maxTotalBytes: 512 * 1024,
    maxStringBytes: SKILL_LIMITS.instructionBytes, maxCollectionEntries: 4096 });
  if (Object.keys(data).some(key => !['reference', 'manifest', 'instructions'].includes(key)))
    throw new SkillPackageError('invalid_package', 'Unknown skill package presentation field.');
  const reference = parseSkillReference(data.reference);
  if (expected && JSON.stringify(reference) !== JSON.stringify(parseSkillReference(expected)))
    throw new SkillPackageError('revision_unavailable', 'Loaded skill reference differs from the exact requested revision.');
  const manifest = parseJsonObject(data.manifest);
  if (Object.keys(manifest).some(key => !['format', 'metadata', 'resources', 'totalBytes', 'instructionsSha256', 'instructionsBytes'].includes(key)) ||
    manifest.format !== 'agent-core.skill.v1' || typeof data.instructions !== 'string' ||
    !Array.isArray(manifest.resources) || manifest.resources.length < 1 || manifest.resources.length > SKILL_LIMITS.files)
    throw new SkillPackageError('invalid_package', 'Malformed immutable skill manifest.');
  const metadata = parseJsonObject(manifest.metadata);
  if (Object.keys(metadata).some(key => !['name', 'description', 'license', 'compatibility', 'metadata', 'requestedTools'].includes(key)) ||
    typeof metadata.name !== 'string' || metadata.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(metadata.name) ||
    !Array.isArray(metadata.requestedTools) || metadata.requestedTools.length > 128 || metadata.requestedTools.some(value => typeof value !== 'string' || value.length > 4096))
    throw new SkillPackageError('invalid_package', 'Malformed skill metadata.');
  const extra = parseJsonObject(metadata.metadata);
  if (Object.values(extra).some(value => typeof value !== 'string')) throw new SkillPackageError('invalid_package', 'Skill metadata values must be strings.');
  const ownedExtra: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== 'string') throw new SkillPackageError('invalid_package', 'Invalid metadata value.');
    Object.defineProperty(ownedExtra, key, { value, enumerable: true });
  }
  const ownedMetadata: SkillMetadata = Object.freeze({ name: metadata.name,
    description: textField(metadata.description, 1024, 'description'),
    ...(metadata.license === undefined ? {} : { license: textField(metadata.license, 4096, 'license') }),
    ...(metadata.compatibility === undefined ? {} : { compatibility: textField(metadata.compatibility, 500, 'compatibility') }),
    metadata: Object.freeze(ownedExtra), requestedTools: Object.freeze(metadata.requestedTools.map(value => textField(value, 4096, 'requested tool'))) });
  const resources = Object.freeze(manifest.resources.map(value => {
    const resource = parseJsonObject(value);
    if (Object.keys(resource).some(key => !['path', 'sha256', 'size'].includes(key)) ||
      typeof resource.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(resource.sha256) ||
      typeof resource.size !== 'number' || !Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > SKILL_LIMITS.fileBytes)
      throw new SkillPackageError('invalid_package', 'Invalid skill resource manifest entry.');
    return Object.freeze({ path: skillResourcePath(resource.path), sha256: resource.sha256, size: resource.size });
  }));
  const content = encoder.encode(data.instructions);
  if (resources.every(resource => resource.path !== 'SKILL.md') || new Set(resources.map(resource => resource.path)).size !== resources.length ||
    resources.reduce((total, resource) => total + resource.size, 0) !== manifest.totalBytes ||
    typeof manifest.totalBytes !== 'number' || manifest.totalBytes > SKILL_LIMITS.packageBytes ||
    content.length !== manifest.instructionsBytes || hashArtifactBytes(content) !== manifest.instructionsSha256 ||
    hashJson(manifest) !== reference.revision)
    throw new SkillPackageError('revision_unavailable', 'Skill manifest, instruction digest, or resource inventory differs from the selected revision.');
  const result = Object.freeze({ reference, instructions: data.instructions, manifest: Object.freeze({ format: 'agent-core.skill.v1' as const,
    metadata: ownedMetadata, resources, totalBytes: manifest.totalBytes, instructionsSha256: hashArtifactBytes(content), instructionsBytes: content.length }) });
  ownedPackages.set(result, result);
  return result;
}
