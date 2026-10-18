import type { ArtifactRepository } from '@agent-core/persistence';

export interface WebLimits {
  readonly maxTransferBytes: number;
  readonly maxResponseBytes: number;
  readonly maxExpansionRatio: number;
  readonly maxHeaderBytes: number;
  readonly requestTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxExtractionBytes: number;
  readonly maxParserNodes: number;
  readonly maxExcerptBytes: number;
  readonly maxSearchResults: number;
}
export interface WebPolicyInput {
  /** Change this identity when host authorization policy changes. Limits are also fingerprinted. */
  readonly id: string;
  /** Exact HTTPS origins; omitted means any public HTTPS origin. */
  readonly allowedOrigins?: readonly string[];
  readonly limits?: Partial<WebLimits>;
}
export interface WebPolicy {
  readonly id: string;
  readonly allowedOrigins?: readonly string[];
  readonly limits: WebLimits;
}
export interface WebResponse {
  readonly status: number;
  /** Lower-case header names. The caller validates and retains only source metadata. */
  readonly headers: Readonly<Record<string, string>>;
  /** Exact response entity bytes after HTTP content decoding, before charset decoding or extraction. */
  readonly body: Uint8Array;
  readonly transferredBytes: number;
}
export interface WebRequest {
  readonly url: string;
  readonly limits: WebLimits;
  readonly signal: AbortSignal;
  /** Host adapter credentials only. Never supplied by a model or persisted in a tool snapshot. */
  readonly headers?: Readonly<Record<string, string>>;
}
/** Host-owned authority. Must enforce public-address connection pinning and never follow redirects. */
export interface WebTransport {
  readonly id: string;
  get(request: WebRequest): Promise<WebResponse>;
}
export interface WebSearchRequest {
  readonly query: string;
  readonly count: number;
  readonly page: number;
  readonly limits: WebLimits;
  readonly signal: AbortSignal;
}
export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}
export interface WebSearchResponse {
  readonly results: readonly WebSearchHit[];
  readonly moreResults: boolean;
}
/** A bounded host adapter with one declared outbound origin, not an arbitrary fetch callback. */
export interface WebSearchAdapter {
  readonly id: string;
  readonly origin: string;
  readonly transportId: string;
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}
export interface WebToolOptions {
  readonly policy: WebPolicyInput;
  readonly transport: WebTransport;
  readonly artifacts: ArtifactRepository;
  readonly search?: WebSearchAdapter;
}
export type WebFailureCode = 'blocked' | 'timeout' | 'aborted' | 'byte_limit' | 'header_limit' | 'unsupported_encoding' | 'invalid_response' | 'network_error' | 'http_error';
export class WebRequestError extends Error {
  constructor(readonly code: WebFailureCode, message: string, readonly httpStatus?: number) {
    super(message);
    this.name = 'WebRequestError';
  }
}

/** Plain persisted application opt-in; credential values never belong here. */
export interface WebConfiguration {
  readonly policy: WebPolicyInput;
  readonly search?: { readonly provider: 'brave'; readonly credentialEnvironmentVariable: string };
}
