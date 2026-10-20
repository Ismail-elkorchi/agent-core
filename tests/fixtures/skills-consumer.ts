import { SkillCatalog, InMemorySkillSource, type SkillReference, type SkillPackageSource,
  type SkillAccessFence, skillDiscoveryRequestSchema, skillResourceReadRequestSchema,
  skillSelectionReferencesSchema, skillLoadRequestSchema, skillScopeDiscoveryRequestSchema } from '@agent-core/skills';
import { FileSystemSkillSource, type FileSystemSkillSourceOptions } from '@agent-core/skills/node';
const fence: SkillAccessFence = async (_request, operation) => operation();
const source: SkillPackageSource = new InMemorySkillSource({ scopeId: 'packed', bindingRevision: 'one',
  packages: [], access: async () => {}, withAccess: fence });
const catalog = new SkillCatalog({ sources: [source] });
const options: FileSystemSkillSourceOptions = { scopeId: 'files', bindingRevision: 'one', roots: [] };
declare const reference: SkillReference;
const scopes = catalog.discoverScopes({ limit: 1, maxBytes: 4096 });
const selection = catalog.loadSelection([reference], { maxBytes: 8192 });
const read = catalog.readResource(reference, 'references/example.txt', { offset: 0, length: 512 });
const dispatch = catalog.withAvailable([reference], async () => ({ started: true }));
// @ts-expect-error exact skill identities are immutable
reference.revision = 'changed';
// @ts-expect-error directory sources require the explicit node export
import { FileSystemSkillSource as wrongEntry } from '@agent-core/skills';
// @ts-expect-error a skill catalog supplies no execution engine
catalog.execute(reference);
void [scopes, skillScopeDiscoveryRequestSchema, selection, read, dispatch, options, FileSystemSkillSource, skillDiscoveryRequestSchema, skillResourceReadRequestSchema, skillSelectionReferencesSchema, skillLoadRequestSchema, skillScopeDiscoveryRequestSchema];
