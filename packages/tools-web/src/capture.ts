import * as z from 'zod';
import { Parser } from 'htmlparser2';
import type { ArtifactRepository } from '@agent-core/persistence';
import { canonicalJsonString } from '@agent-core/json';
import type { WebLimits, WebResponse } from './contracts.js';
import { WebRequestError } from './contracts.js';
import { sourceCaptureSchema, type FetchSourceOutput, type SourceCapture } from './schemas.js';

const OMIT_TEXT = new Set(['script', 'style', 'noscript', 'template']);
const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'div', 'dl', 'dt', 'dd', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const SOURCE_HEADERS = new Set(['content-type', 'content-encoding', 'etag', 'last-modified', 'content-language']);

export async function captureWebSource(input: {
  readonly url: string; readonly response: WebResponse; readonly limits: WebLimits;
  readonly artifacts: ArtifactRepository; readonly signal: AbortSignal;
}): Promise<Extract<FetchSourceOutput, { status: 'available' }>> {
  const { url, limits, artifacts, signal } = input;
  const response = input.response;
  signal.throwIfAborted();
  const mediaType = response.headers['content-type'] ?? 'application/octet-stream';
  const original = await artifacts.store({ label: 'Web response entity', mediaType, content: response.body,
    description: 'Exact response entity bytes after HTTP content decoding; no charset decoding or text extraction.' });
  signal.throwIfAborted();
  const extraction = await extractText(response.body, mediaType, limits, signal);
  let retainedExtraction: SourceCapture['extraction'];
  if (extraction.status === 'unavailable') retainedExtraction = extraction;
  else {
    const artifact = await artifacts.store({ label: 'Derived web text', mediaType: 'text/plain; charset=utf-8', content: Buffer.from(extraction.text),
      description: 'Derived text. Ranges address this representation, not original HTML bytes.' });
    retainedExtraction = { status: 'available', artifact, extractor: extraction.extractor,
      coverage: extraction.causes.length ? 'partial' : 'complete', causes: extraction.causes, representation: 'derived_text' };
  }
  signal.throwIfAborted();
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => SOURCE_HEADERS.has(name)));
  const source = sourceCaptureSchema.parse({ format: 'agent-core-web-capture-v1', requestedUrl: url, responseUrl: url,
    retrievedAt: new Date().toISOString(), httpStatus: response.status, bodyEncoding: 'http-content-decoded',
    transferredBytes: response.transferredBytes, original, extraction: retainedExtraction, headers });
  const capture = await artifacts.store({ label: 'Web source capture', mediaType: 'application/json', content: Buffer.from(canonicalJsonString(source)) });
  signal.throwIfAborted();
  if (retainedExtraction.status === 'unavailable') return { status: 'available', capture, source };
  const bytes = extraction.status === 'available' ? Buffer.from(extraction.text) : Buffer.alloc(0);
  const selected = boundedUtf8(bytes, limits.maxExcerptBytes);
  return { status: 'available', capture, source, excerpt: { artifact: retainedExtraction.artifact, representation: 'derived_text',
    range: { start: 0, end: selected.length }, text: selected.toString('utf8'),
    coverage: selected.length === bytes.length ? 'complete' : 'partial',
    ...(selected.length < bytes.length ? { nextOffset: selected.length } : {}) } };
}

/** Validate the host adapter boundary before retaining bytes or relying on response metadata. */
const responseSchema = z.strictObject({ status: z.int().min(100).max(599), headers: z.record(z.string(), z.string()), body: z.instanceof(Uint8Array), transferredBytes: z.int().nonnegative() });
export function validateWebResponse(input: unknown, limits: WebLimits): WebResponse {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) throw new WebRequestError('invalid_response', 'The web transport returned an invalid response.');
  const value = parsed.data;
  if (value.body.byteLength > limits.maxResponseBytes || value.transferredBytes > limits.maxTransferBytes
    || value.body.byteLength > Math.max(1024, value.transferredBytes * limits.maxExpansionRatio))
    throw new WebRequestError('byte_limit', 'The response exceeded the configured byte or expansion limit.');
  let headerBytes = 0;
  const headers: Record<string, string> = {};
  for (const [name, text] of Object.entries(value.headers)) {
    if (!/^[a-z0-9-]+$/u.test(name) || typeof text !== 'string' || /[\r\n\0]/u.test(text))
      throw new WebRequestError('invalid_response', 'The transport returned invalid response headers.');
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(text) + 4;
    if (headerBytes > limits.maxHeaderBytes) throw new WebRequestError('header_limit', 'Response headers exceeded the configured limit.');
    headers[name] = text;
  }
  const contentType = headers['content-type'];
  if (contentType !== undefined && (contentType.length > 512 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/u.test(contentType)))
    throw new WebRequestError('invalid_response', 'The response Content-Type is invalid.');
  return Object.freeze({ status: value.status, headers: Object.freeze(headers), body: new Uint8Array(value.body), transferredBytes: value.transferredBytes });
}

type TextExtraction = { readonly status: 'unavailable'; readonly reason: 'unsupported_media_type' | 'unsupported_charset' | 'invalid_text' }
  | { readonly status: 'available'; readonly text: string; readonly extractor: string; readonly causes: ('output_limit' | 'parser_limit')[] };
async function extractText(bytes: Uint8Array, mediaType: string, limits: WebLimits, signal: AbortSignal): Promise<TextExtraction> {
  const [type] = mediaType.toLowerCase().split(';');
  const html = type?.trim() === 'text/html' || type?.trim() === 'application/xhtml+xml';
  if (!html && !['text/plain', 'text/markdown', 'application/json'].includes(type?.trim() ?? ''))
    return { status: 'unavailable', reason: 'unsupported_media_type' };
  const charset = declaredCharset(mediaType);
  if (charset === null) return { status: 'unavailable', reason: 'unsupported_charset' };
  if (charset === 'us-ascii' && bytes.some(byte => byte > 0x7f)) return { status: 'unavailable', reason: 'invalid_text' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { status: 'unavailable', reason: 'invalid_text' }; }
  if (!html) {
    const selected = boundedUtf8(Buffer.from(text), limits.maxExtractionBytes);
    return { status: 'available', text: selected.toString('utf8'), extractor: 'agent-core.utf8-text.v1',
      causes: selected.length < Buffer.byteLength(text) ? ['output_limit'] : [] };
  }
  // HTTP metadata owns decoding when present. Without it, inspect actual HTML metadata
  // in a bounded prefix; comments, raw script text and unrelated attributes are not declarations.
  if (charset === undefined) {
    const metadataCharset = htmlCharset(text.slice(0, 4096));
    if (metadataCharset === null) return { status: 'unavailable', reason: 'unsupported_charset' };
    if (metadataCharset === 'us-ascii' && bytes.some(byte => byte > 0x7f)) return { status: 'unavailable', reason: 'invalid_text' };
  }
  const chunks: string[] = [];
  const causes: ('output_limit' | 'parser_limit')[] = [];
  let remaining = limits.maxExtractionBytes;
  let nodes = 0;
  let hidden = 0;
  const parserState = { stopped: false };
  const append = (value: string) => {
    if (parserState.stopped || hidden) return;
    const encoded = Buffer.from(value);
    const selected = boundedUtf8(encoded, remaining);
    chunks.push(selected.toString('utf8'));
    remaining -= selected.length;
    if (selected.length < encoded.length) { causes.push('output_limit'); parserState.stopped = true; parser.pause(); }
  };
  const node = () => {
    nodes++;
    if (nodes > limits.maxParserNodes && !parserState.stopped) { causes.push('parser_limit'); parserState.stopped = true; parser.pause(); }
  };
  const parser = new Parser({
    onopentag(name) { node(); if (OMIT_TEXT.has(name)) hidden++; else if (BLOCKS.has(name)) append('\n'); },
    onclosetag(name) { node(); if (OMIT_TEXT.has(name)) hidden = Math.max(0, hidden - 1); else if (BLOCKS.has(name)) append('\n'); },
    ontext(value) { node(); append(value); },
    oncomment() { node(); },
    onprocessinginstruction() { node(); }
  }, { decodeEntities: true });
  for (let offset = 0, chunksRead = 0; offset < text.length && !parserState.stopped; chunksRead++) {
    signal.throwIfAborted();
    let end = Math.min(text.length, offset + 16_384);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
    parser.write(text.slice(offset, end));
    offset = end;
    if (chunksRead % 4 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (!parserState.stopped) parser.end();
  signal.throwIfAborted();
  return { status: 'available', text: chunks.join(''), extractor: 'agent-core.html-text.v1', causes };
}

type SupportedCharset = 'utf-8' | 'us-ascii';
function supportedCharset(label: string): SupportedCharset | null {
  const normalized = label.toLowerCase();
  return normalized === 'utf-8' || normalized === 'utf8' ? 'utf-8' : normalized === 'us-ascii' ? 'us-ascii' : null;
}

/** Undefined means absent, null means unsupported or ambiguous; neither permits encoding inference. */
function declaredCharset(mediaType: string): SupportedCharset | null | undefined {
  const essence = /^[ \t]*[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+[ \t]*/iu.exec(mediaType);
  if (!essence) return null;
  const parameter = /;[ \t]*([!#$%&'*+.^_`|~0-9a-z-]+)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([!#$%&'*+.^_`|~0-9a-z-]+))[ \t]*/iy;
  let position = essence[0].length;
  let charset: SupportedCharset | undefined;
  while (position < mediaType.length) {
    parameter.lastIndex = position;
    const match = parameter.exec(mediaType);
    if (!match) return null;
    position = parameter.lastIndex;
    if (match[1]?.toLowerCase() !== 'charset') continue;
    if (charset !== undefined) return null;
    const parsed = supportedCharset(match[2]?.replace(/\\(.)/gu, '$1') ?? match[3] ?? '');
    if (parsed === null) return null;
    charset = parsed;
  }
  return charset;
}

function htmlCharset(prefix: string): SupportedCharset | null | undefined {
  let charset: SupportedCharset | null | undefined;
  let hidden = 0;
  let tag = '';
  const attributes = new Set<string>();
  const accept = (value: SupportedCharset | null | undefined) => {
    if (value === undefined || charset === null) return;
    charset = value === null || (charset !== undefined && charset !== value) ? null : value;
  };
  const parser = new Parser({
    onopentagname(name) { tag = name; attributes.clear(); },
    onattribute(name) {
      if (tag !== 'meta' || hidden || !['charset', 'http-equiv', 'content'].includes(name)) return;
      if (attributes.has(name)) charset = null;
      attributes.add(name);
    },
    onopentag(name, values) {
      if (OMIT_TEXT.has(name)) hidden++;
      if (name !== 'meta' || hidden) return;
      if (values.charset !== undefined) accept(supportedCharset(values.charset.trim()));
      if (values['http-equiv']?.trim().toLowerCase() === 'content-type' && values.content !== undefined)
        accept(declaredCharset(values.content));
    },
    onclosetag(name) { if (OMIT_TEXT.has(name)) hidden = Math.max(0, hidden - 1); }
  }, { decodeEntities: true });
  parser.end(prefix);
  return charset;
}

function boundedUtf8(bytes: Buffer, maximum: number): Buffer {
  let end = Math.min(bytes.length, maximum);
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}
