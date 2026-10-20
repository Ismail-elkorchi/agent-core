# @agent-core/skills

A narrow adapter for [Agent Skills](https://agentskills.io/specification), separate
from domain prompts, callable tools, repository `AGENTS.md`, and material storage.
The root export requires no workspace, filesystem source, shell, or executor.

```ts
import { InMemorySkillSource, SkillCatalog } from '@agent-core/skills';

const skills = new SkillCatalog({ sources: [new InMemorySkillSource({
  scopeId: 'private-user', bindingRevision: 'host-read-grant-7',
  packages: [{ packageId: 'review-method', files: [{ path: 'SKILL.md', content:
    '---\nname: review-method\ndescription: Review a draft when requested\n---\nCheck claims against the cited sources.' }] }]
})] });
const scopes = await skills.discoverScopes({ limit: 5 });
const scope = scopes.items[0];
if (scope) {
  const page = await skills.discover({ scopeId: scope.scopeId, limit: 5 });
  const reference = page.items[0]?.reference;
  if (reference) {
    const loaded = await skills.loadSelection([reference], { maxBytes: 32_768 });
    // Pass reference through ContextSourceSelection.skills. ContextService owns
    // activation/admission; loading alone does not alter the active context.
    console.log(loaded[0]?.instructions);
  }
}
```

## Identity, discovery and exact content

`SkillReference` contains `scopeId`, `packageId`, manifest-content `revision`, and
host `bindingRevision`. Names are descriptions, never lookup keys. Two scopes may
contain the same name. Only an explicitly configured scope can be discovered.

`discoverScopes` provides the cold-start entry point: bounded, authorized
`scopeId`/`bindingRevision` descriptors from the existing configured sources. It
never scans packages or reads bodies. At most two metadata inspections per source
are performed, with a hard ceiling of 64 configured sources. IDs, counts,
diagnostics, positions, and revision inputs from access-denied sources are omitted.
Offsets and revisions refer only to readable descriptors. A typed
`SkillPackageError('access_denied', ...)` means denial; other inspection failures
produce aggregate partial coverage without revealing source IDs or error text.
Cancellation stops outstanding discovery. The model-facing `context_skill_scopes`
operation makes these IDs available before `context_skill_discover` is used.

A manifest includes strict YAML metadata, resource paths/sizes/SHA-256 digests,
exact instruction digest/byte length, and total resource bytes. All content is
captured independently of caller-owned buffers. Metadata version, compatibility,
applicability, and outcome-reference strings remain attributable package content;
they do not establish verification or permission. Extensions belong in the
standard string-to-string `metadata` field.

Discovery returns bounded descriptions only. Item/output bounds and independent
package-scan/byte bounds are exposed in `SKILL_LIMITS`; pages state inspected work,
diagnostics, partial coverage, and continuation offsets. `expectedRevision` binds
pagination to the configured source inventory and authority binding. Each result
separately pins exact package content. There is no hidden whole-account scan.

`readResource(reference, path, {offset, length})` returns copied, bounded exact byte
ranges. The catalog validates every source response against the selected manifest,
exact requested reference/path/range and byte bounds, then copies its bytes before
return. Complete-resource responses additionally have their SHA-256 checked.
Partial ranges depend on the source's verified immutable-content guarantee; a
whole-resource digest alone cannot prove an arbitrary partial range. Built-in
sources read from previously digest-verified immutable captures. The catalog does
not silently fetch a whole resource to verify a small range. `decodeSkillResourceText` rejects invalid UTF-8 or a split code point; it
does not silently expand a range. Assets may be binary. Reading is never execution.

`loadSelection` checks the complete set and byte bound before returning any
selection. It publishes no context state. Saving and admitting references uses the
existing Core context view, including current source/grant checks. An empty load
result does not clear an active selection. Clearing is an explicit context change.

## Explicit filesystem adapter

```ts
import { FileSystemSkillSource } from '@agent-core/skills/node';

const source = new FileSystemSkillSource({
  scopeId: 'team-methods', bindingRevision: 'read-grant-3',
  roots: [{ packageId: 'review-method', path: '/opt/methods/review-method' }]
});
// Supply source to SkillCatalog. Close it when the host withdraws this source.
await source.close();
```

The filesystem adapter is currently **Linux-only**. It reuses
`@agent-core/tools-local`'s existing descriptor-rooted file authority, rejecting
symlinks, multiply linked files, mount escapes, traversal, special files, excessive
depth/count/bytes, and roots without supported confinement. Other platforms fail
explicitly rather than downgrade to a `realpath` check. In-memory sources work
without this adapter and do not initialize it when importing the root package.

To bind discovery to an exact full-package digest, filesystem intake must read and
hash bounded package bytes, including resource bytes. It does so only for the
bounded inspected packages, not every registered root. The model receives only
descriptions. Errors conservatively charge the remaining scan-byte allowance.
Hosts with large packages should supply a pre-captured immutable source rather
than repeatedly discovering mutable directories.

First load re-captures the selected package and rejects changes since discovery.
After a successful load, the source retains exact immutable bytes (64 MiB maximum)
so repeated preparation does not reread resource bodies. New versions require new
explicit selection. This cache is not durable storage: after restart, an old
filesystem revision that is no longer present fails with `revision_unavailable`;
it is never replaced by the latest directory content. Hosts may retain old versions
in their immutable source or persist exact material through existing protected
artifact/context capabilities. Closing the source withdraws all cached access. Its asynchronous acknowledgement waits for an already-entered dispatch boundary.

## Authority and execution

Registration is an explicit host read grant. For dynamic authorization, `access`
is checked before and after discovery/load/resource reads, including cached
versions. `assertAvailable` checks selected and native-prefix dependencies again.
`withAvailable(references, operation)` obtains deterministic source-order fences
for request dispatch. Hosts with dynamic access must supply `withAccess` that
serializes revocation with the callback; a check-only configuration explicitly
rejects dispatch. Native continuation may depend on several exact revisions of one
package even though a newly selected view permits only one revision per package.

The `allowed-tools` field is parsed as `metadata.requestedTools`, preserving its
requested spelling. It never becomes a permission grant, callable definition,
execution capability, or wildcard interpretation. The host may intersect requests
with already granted tools; authorization still occurs in the ordinary tool path.
Skill instructions are external/reference material, never system/developer
instructions or a source of approval.

There is no skill executor, installer, subprocess launcher, or inferred runtime.
Portable JavaScript uses the existing programmatic tool. Bash/Python resources
require an existing authorized command/environment capability or governed tool.
Unavailable languages, missing dependencies, approvals, cancellation, accounting,
and uncertain effects remain that tool's ordinary explicit outcomes. Reading or
selecting a poisoned script cannot invoke it.

## Validation

`tests/skill-packages.test.js` covers immutable identity, scope collisions,
metadata-only output, independent scan/output bounds, malformed YAML, mutation
between discovery and load, exact old versions, UTF-8 ranges, revocation/fences,
resource confinement, and unsupported filesystem platforms. The packed consumer
imports only documented root and `/node` exports and checks JS/TS consumers.
