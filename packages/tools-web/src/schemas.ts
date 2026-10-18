import * as z from 'zod';
import { artifactRefSchema } from '@agent-core/tools';

export const fetchSourceInputSchema = z.strictObject({ url: z.string().min(1).max(4096) });
export const searchWebInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(600),
  count: z.int().min(1).max(20).default(10),
  page: z.int().min(0).max(9).default(0)
});
export const webFailureSchema = z.enum(['blocked', 'timeout', 'aborted', 'byte_limit', 'header_limit', 'unsupported_encoding', 'invalid_response', 'network_error', 'http_error']);
const byteRange = z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative() });
const extraction = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), artifact: artifactRefSchema, extractor: z.string(), coverage: z.enum(['complete', 'partial']), causes: z.array(z.enum(['output_limit', 'parser_limit'])), representation: z.literal('derived_text') }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['unsupported_media_type', 'unsupported_charset', 'invalid_text']) })
]);
export const sourceCaptureSchema = z.strictObject({
  format: z.literal('agent-core-web-capture-v1'),
  requestedUrl: z.string(),
  responseUrl: z.string(),
  retrievedAt: z.iso.datetime(),
  httpStatus: z.int().min(200).max(299),
  bodyEncoding: z.literal('http-content-decoded'),
  transferredBytes: z.int().nonnegative(),
  original: artifactRefSchema,
  extraction,
  headers: z.record(z.string(), z.string())
});
export const fetchSourceOutputSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), capture: artifactRefSchema, source: sourceCaptureSchema,
    excerpt: z.strictObject({ artifact: artifactRefSchema, representation: z.literal('derived_text'), range: byteRange,
      text: z.string(), coverage: z.enum(['complete', 'partial']), nextOffset: z.int().nonnegative().optional() }).optional() }),
  z.strictObject({ status: z.literal('redirect'), url: z.string(), httpStatus: z.int(), location: z.string().optional(), message: z.string() }),
  z.strictObject({ status: z.literal('unavailable'), url: z.string(), reason: webFailureSchema, httpStatus: z.int().optional(), message: z.string() })
]);
export const searchHitSchema = z.strictObject({ title: z.string().max(1000), url: z.string().max(4096), snippet: z.string().max(4000) });
export const searchWebOutputSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), provider: z.string(), query: z.string(), page: z.int(), count: z.int(),
    results: z.array(searchHitSchema).max(20), coverage: z.literal('partial'),
    resultsAre: z.literal('provider_snippets_not_page_reads'), nextPage: z.int().optional() }),
  z.strictObject({ status: z.literal('unavailable'), provider: z.string(), reason: webFailureSchema, httpStatus: z.int().optional(), message: z.string() })
]);
export type SourceCapture = z.infer<typeof sourceCaptureSchema>;
export type FetchSourceOutput = z.infer<typeof fetchSourceOutputSchema>;
export type SearchWebOutput = z.infer<typeof searchWebOutputSchema>;
