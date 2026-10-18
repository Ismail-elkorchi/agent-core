# @agent-core/tools-web

Optional public-web acquisition tools. Applications choose whether to compose these
with their existing tools and grant the `network` risk. File edit/review modes do
not grant web access. No browser, shell, crawler, generic HTTP method/body tool,
source database, credential model argument, or automatic redirect following is
included.

## Composition

```ts
import { createWebTools } from '@agent-core/tools-web';
import {
  createNodeWebTransport,
  createBraveSearchAdapter
} from '@agent-core/tools-web/node';

const transport = createNodeWebTransport();
const tools = createWebTools({
  policy: {
    id: 'application-public-research-v1',
    // Optional exact-origin restriction. Omit to allow public HTTPS origins.
    allowedOrigins: ['https://api.search.brave.com', 'https://nodejs.org']
  },
  transport,
  artifacts, // the application's existing ArtifactRepository
  search: createBraveSearchAdapter({ apiKey, transport })
});
```

`fetch_source` is always supplied by this explicit factory. `search_web` is supplied
only when a search adapter exists. Missing search credentials should omit that
adapter, not create an advertised but nonfunctional tool. Both tools support direct
and programmatic invocation through the same Core execution and authorization
boundary. The caller must also compose the existing `read_artifact` when later
source windows are needed.

The root export contains contracts, schemas, policy validation and transport-injected
tools. The `/node` export supplies the actual public HTTPS transport and Brave Search
adapter. Transport and search adapter identities, effective limits, canonical URL or
query, provider origin, and policy are part of the authorization snapshot. Credentials
are captured only by the adapter closure. Applications must change policy/transport
identities when their authority changes. They must authorize outbound query content;
workspace access or existing model-provider access alone does not authorize sending
workspace contents to a search provider.

## Tool results and source identity

- `search_web({ query, count?, page? })` returns a bounded provider-results page.
  Query length is at most 600 UTF-16 code units and 75 whitespace-delimited words;
  pages are 0–9 and result count is at most 20, further restricted by host policy.
  Results are explicitly provider snippets, not page reads. Search coverage is
  always partial; `nextPage` is present only when the provider reports another page
  and the supported page bound permits it
- `fetch_source({ url })` returns `available`, `redirect`, or `unavailable`. An
  `available` capture means the complete bounded HTTP entity was retained. It does
  not assert that all its content reached the model or that its claims are correct
- A redirect returns its eligible HTTPS destination without connecting to it. A new
  tool call derives new effects and undergoes authorization. Only syntactically supported HTTPS targets are returned; the next call still
  enforces origin policy and public-address checks
- An immutable capture manifest names the requested/response URL, retrieval time,
  HTTP status, safe response metadata, original artifact and extraction artifact
- Original means exact entity bytes **after HTTP content decoding** (gzip/deflate/br),
  before charset decoding or extraction. It does not mean compressed wire bytes
- Derived text has its own representation and extractor identity. UTF-8 plain text,
  Markdown, JSON, HTML and XHTML are supported. HTML extraction is tokenized text
  with block separators and decoded entities; script, style, noscript and template
  text are omitted. It is not a rendered page or an article-relevance extraction
- Unsupported media, unsupported charset or invalid UTF-8 preserves the original
  artifact and explicitly reports unavailable extraction. PDF/OCR, JavaScript
  rendering, authenticated pages and subresource loading are not implemented
- Extraction bounds and returned-excerpt bounds are separate from complete original
  capture. Excerpt ranges are half-open UTF-8 byte offsets into the **derived text
  artifact**, never fabricated ranges into HTML/PDF originals. Use `read_artifact`
  with that exact artifact ID and `nextOffset` for further windows
- Equal byte representations may deduplicate in ArtifactRepository. Distinct capture
  manifests preserve URL and retrieval provenance. A URL is not an immutable revision
- Use existing history and context selection to retain observations, capture manifests
  and exact artifact windows. The package has no independent source registry or
  history. Citation formatting and assessing whether a claim is supported remain
  application responsibilities

Domain-unavailable outcomes are typed tool results, with failed/absent observed
facts and partial scope. `kind: result` is invocation disposition, not proof of
successful domain work. Search facts never claim destination-page inspection.
Capture facts distinguish complete retained originals from inspected derived ranges.

## Transport limits and egress

Default limits (all explicitly configurable within hard schema bounds):

| Resource | Default |
| --- | ---: |
| Transferred response bytes | 1 MiB |
| Content-decoded response bytes | 2 MiB |
| Decompression expansion | 100×, with 1 KiB startup allowance |
| Request/response header bytes | 16 KiB each |
| Whole network request deadline, including DNS | 30 seconds |
| Connection/response idle timeout | 10 seconds |
| Derived text | 1 MiB |
| HTML parser callbacks | 50,000 |
| Initial derived-text excerpt | 16 KiB |
| Search results | 10 |

The Node transport resolves A/AAAA records without ambient proxy configuration,
rejects any non-public answer, selects one allowed address, and pins it into a
dedicated TLS connection while keeping certificate hostname validation. It checks
the actual connected address too. Non-public IPv4, IPv4-mapped IPv6, transition IPv6,
local/reserved destinations and non-global-unicast IPv6 are rejected conservatively.
HTTPS on port 443 without URL credentials is the only supported protocol. Redirects
are never followed. Cookies, browser state, ambient credentials, automatic retries
and arbitrary model-selected headers are absent.

Transfer, decompression and output limits are enforced while streaming. Unsupported
content encodings, malformed metadata, excess bytes, cancellation and deadlines
cannot become complete captures. Cancellation closes active requests/streams and
cancels the default DNS resolver. The HTML tokenizer processes bounded chunks with
cancellation checkpoints and explicit parser/output limits. Search adapters and
custom transports are host-owned capabilities, not a sandbox for untrusted code;
they must obey the interface's declared egress, cancellation and bounds contracts.

The `NodeWebTransportOptions` resolver/request injection points allow deterministic
qualification of DNS and TLS connection behavior without weakening the production
public-address policy. Replacing those functions transfers connection responsibility
to that host implementation; the defaults use Node HTTPS and cancellable DNS.

No crash retry proof is claimed. Unknown durable-effect outcomes use Core's existing
reconciliation behavior; fetching a changing URL again is not recovery of an old
observation.

## Qualification

Tests cover source/derived identity, UTF-8 ranges, capture manifests, original byte
recovery, typed conflicts, disabled-network behavior, provider credential isolation,
query bounds, pinned DNS and actual connection addresses, redirect isolation,
compression limits, cancellation and timeouts. Tests use the public exports.
Deterministic fixtures establish contracts, not successful live-provider behavior.

Brave adapter protocol reference:
https://api-dashboard.search.brave.com/app/documentation/web-search/codes

Node HTTPS reference:
https://nodejs.org/api/https.html

## Plain application configuration

Applications can forward explicit JSON to the `/node` helpers without duplicating
provider or credential parsing:

```ts
import { parseWebConfiguration, createConfiguredWebTools } from '@agent-core/tools-web/node';
const configuration = parseWebConfiguration({
  policy: { id: 'application-public-research-v1' },
  search: { provider: 'brave', credentialEnvironmentVariable: 'BRAVE_SEARCH_API_KEY' }
});
const tools = createConfiguredWebTools(configuration, { artifacts, environment: process.env });
```

Omit `search` for retrieval only. A requested but missing/empty credential environment
variable fails construction with a precise error, rather than advertising a dead
search tool. The optional `environment` defaults to the host process environment;
only the explicitly named variable is read. Actual credential values are not valid
configuration fields. Persist this plain configuration when admitted work needs to
retain its exact web capability across restart; do not persist the environment.
