# @agent-core/tools-mcp

Optional MCP tools for the existing Agent Core catalog and governed tool executor.
The adapter uses the official `@modelcontextprotocol/client` 2.3.1 SDK, pinned to
MCP **2026-07-28**. It sends `server/discover`, then per-request protocol/capability
metadata. It never sends `initialize`, negotiates an older revision, or uses the
removed standalone HTTP GET subscription channel.

## Host-supplied transport

The package root accepts a host `createTransport()` factory returning an official
SDK `Transport`; it does not spawn processes,
construct HTTP clients, read environment credentials, or initiate OAuth consent.
Hosts must bound their transport's raw message framing. The adapter additionally
bounds parsed messages, inventory pages, schema/result bytes, content blocks,
binary bytes, notifications, request time, and subscription lifetime.

```ts
import { McpToolSource } from '@agent-core/tools-mcp';
import { createMcpHttpTransport } from '@agent-core/tools-mcp/node';

const source = new McpToolSource({
  id: 'inventory',
  binding: {
    endpointId: 'production-inventory',
    accountId: 'operator-17',
    policyRevision: 'read-policy-1'
  },
  createTransport: () => createMcpHttpTransport({
    endpoint: 'https://inventory.example/mcp',
    headers: () => ({ authorization: `Bearer ${hostToken}` })
  }),
  artifacts: hostArtifactRepository,
  tools: {
    lookup: {
      invocationModes: ['direct', 'programmatic'],
      effectEnvelope: {
        accesses: [{ mode: 'read', scope: 'inventory/items' }],
        lockScopes: []
      },
      deriveEffects(input) {
        return {
          accesses: [{ mode: 'read', scope: 'inventory/items' }],
          lockScopes: []
        };
      }
    }
  }
});

const snapshot = await source.snapshot();
const descriptor = snapshot.tools[0];
const compiledTool = await source.load(descriptor.reference);
// Supply source to the host ToolCatalog, or use compiledTool in a
// ToolRegistry and the normal plan/authorization/invocation executor.
// Loading a tool is never invocation authority.
await source.close();
```

Every exposed remote tool requires an exact host effect mapping. Unmapped tools
are absent. Server annotations (`readOnlyHint`, `idempotentHint`, and similar)
never grant authority or authorize retries. Invocation modes default to `direct`;
program composition requires an explicit host `invocationModes` opt-in. Remote
metadata cannot enable it, and child calls still use canonical authorization. The adapter adds a network effect
bound to the source/account/endpoint policy revision. Host-derived effects must
fit the host envelope. Recovery stays `unknown`: remote execution is never
implicitly repeated after a timeout, cancellation, dropped response, or restart.

Source references bind `sourceId`, exact remote `toolId`, tool contract revision,
and host `bindingRevision`. Tool names are deterministic and server-qualified.
The host must use distinct endpoint/account identifiers and change
`policyRevision` when its mapping behavior changes. Credentials are held in
transport closures; they are not included in model descriptions, authorization
snapshots, catalog records, errors, or result origins.

## Explicit Node construction and configuration

The `/node` subpath provides bounded `createMcpHttpTransport` and
`createMcpStdioTransport`. HTTP requires HTTPS (explicitly allowed loopback HTTP
is supported), refuses redirects, does not refresh credentials or create OAuth
grants, and does not reconnect/retry a dispatched call. Stdio starts only a
host-specified executable without a shell, with a required absolute working
directory and explicit environment. SDK-inherited environment values are
cleared unless the host supplies them. Remote tools cannot select executables.

`parseMcpConfiguration(parsedJson)` validates a serializable, HTTP-only host
configuration. `createConfiguredMcpSources(config, { artifacts, environment, allowedRisks })`
returns `{ sources, close }` without connecting. An omitted environment uses
`process.env`. Bearer values are captured only from the named host variable.

```json
{
  "servers": [{
    "id": "inventory",
    "endpoint": "https://inventory.example/mcp",
    "accountId": "operator-17",
    "policyRevision": "read-policy-1",
    "bearerTokenEnv": "INVENTORY_MCP_TOKEN",
    "tools": {
      "lookup": {
        "accesses": [{ "mode": "read", "scope": "inventory/items" }],
        "lockScopes": [],
        "invocationModes": ["direct", "programmatic"]
      }
    }
  }]
}
```

This configuration contains explicit static host scopes. For argument-derived
scopes, supply `McpToolSource` programmatically. Configured endpoint URLs cannot
contain credentials, query parameters, or fragments; bearer credentials use
environment references. The factory hashes the exact endpoint into its binding.
An optional host `allowedRisks` ceiling removes mappings with disallowed declared
accesses before discovery (delete maps to destructive); every MCP tool also needs
network authority. Wholly ineligible servers are skipped before credential lookup
or transport construction. The ceiling is part of the binding revision. Its static effect
mapping does not bypass the runtime's policy or approval.

## Schemas, results, and failures

Inputs are object-shaped JSON Schema 2020-12. Each original schema is captured
once, compiled by Ajv 2020 with schema validation and own-property checks, and
published unchanged through Core's owned JSON Schema contract. The validator
never coerces input, inserts defaults, or removes properties. Unicode lengths,
object/array enum and const values, conditionals, and composition retain their
JSON Schema meaning instead of being lowered through another schema language.

Schemas have bounded depth, entries, and bytes. Declared-schema validation also
has a fixed work ceiling of 1,024 collection entries, 1 MB, and depth 32 per value,
before synchronous assertions run; model-supplied schema maxima cannot raise it. References, schema resource IDs,
custom vocabularies, async validation, and schema-defined regular expressions
(`pattern`/`patternProperties`) are unavailable. Compilation never fetches remote
schemas. `format` follows the default 2020-12 annotation vocabulary rather than
executing format assertions. Unknown assertion keywords and malformed schemas
are rejected by the compiler.

Results use `{ content, structuredContent? }`. Structured content preserves JSON
primitives, arrays, objects, and null. A declared remote output schema is enforced;
without one, the contract permits JSON values. Text, images, audio, embedded
resources, and resource-link descriptors remain separate. Binary data is stored
in the host artifact repository with source/tool/binding/content-index origins;
embedded resource URIs remain origin metadata. A remote resource link grants no
local-file or artifact authority and is never fetched automatically.

`isError` produces a settled tool failure. Protocol rejection, unusable results,
and uncertain transport outcomes are distinct. A server internal error or
post-dispatch cancellation/disconnection retains unknown execution status.
Transport error messages are sanitized so credentials and headers cannot enter
model-visible observations. Configured bearer credentials have an exact private
matcher: credential-bearing inventory is unavailable, and text or binary result
echoes are refused before any public or protected artifact write. Only the raw
result digest, size, and refusal reason are retained; its original is unavailable.
Programmatic hosts can supply `containsCredential` for their own transport secrets.

Advertised list changes use bounded `subscriptions/listen`; notifications and
stream closure invalidate cached inventory. The default catalog cache age is
zero, so each boundary rechecks the list. A host can explicitly choose a finite
cache age. Expired subscriptions are not automatically reopened; subsequent
inventory reads remain available. Failed inventory refreshes have a 30-second
source-owned backoff (`failureBackoffMs`) with no retry timer; cancellation is
propagated and never recorded as an outage. Failed initial connections are
eligible for metadata-only reconnection after the same backoff. Each new
connection changes the binding revision and revokes prior references. The host
factory must return a fresh transport, or `undefined` when its one-shot authority
is exhausted. It must recreate the same endpoint/account authority; changing
that authority requires a new source. No tool invocation is replayed.
No callbacks, sampling, roots, elicitation,
input-required continuations, task execution, or task recovery are advertised
or silently fulfilled. All source lifetimes must be explicitly closed.

Official references:
- https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html
