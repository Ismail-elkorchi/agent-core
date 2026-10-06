import * as z from 'zod';
import { redactTextPreservingLength, type ArtifactRepository } from '@agent-core/persistence';
import { createCommandOutputView, type CommandOutputView } from '@agent-core/tools';
import { commandOwnerSchema, type ProcessTerminalRecord } from './process-records.js';

export type LocalOutputStream = 'stdout' | 'stderr';
export interface CapturedChunk {
  readonly sequence: number;
  readonly stream: LocalOutputStream;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly bytes: number;
  readonly streamStart: number;
}

// Bounds decoding work independently of the returned log's much smaller byte allowance.
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const outputSchema = z
  .strictObject({
    format: z.literal('agent-core.process-output/1'),
    processId: z.string().min(1),
    owner: commandOwnerSchema.readonly(),
    status: z.enum(['exited', 'stopped', 'timed_out', 'failed']),
    startedAt: z.iso.datetime(),
    observedBytes: z.int().nonnegative(),
    retainedBytes: z.int().nonnegative(),
    omittedBytes: z.int().nonnegative(),
    chunks: z
      .array(
        z
          .strictObject({
            sequence: z.int().nonnegative(),
            stream: z.enum(['stdout', 'stderr']),
            streamStart: z.int().nonnegative(),
            start: z.int().nonnegative(),
            end: z.int().nonnegative(),
            text: z.string()
          })
          .readonly()
      )
      .readonly()
  })
  .readonly();
type ProcessOutputArtifact = z.output<typeof outputSchema>;

export function encodeProcessOutputArtifact(output: ProcessOutputArtifact): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(output) + '\n', 'utf8');
  if (bytes.byteLength > MAX_ARTIFACT_BYTES)
    throw new Error('Serialized process output exceeds its storage allowance.');
  return bytes;
}

export async function decodeProcessOutput(
  artifacts: ArtifactRepository,
  terminal: ProcessTerminalRecord
): Promise<ProcessOutputArtifact> {
  const ref = terminal.protectedArtifact;
  if (!ref) throw new Error('Protected process output was not retained.');
  if (ref.size > MAX_ARTIFACT_BYTES)
    throw new Error('Serialized process output exceeds its read allowance.');
  const output = outputSchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.readVerified(ref))
    )
  );
  if (
    output.processId !== terminal.processId ||
    output.status !== terminal.status ||
    output.observedBytes !== terminal.cursorEnd ||
    output.retainedBytes !== terminal.combined.capturedBytes ||
    output.omittedBytes !== output.observedBytes - output.retainedBytes ||
    Object.keys(terminal.owner).some(
      (key) => Reflect.get(output.owner, key) !== Reflect.get(terminal.owner, key)
    )
  )
    throw new Error('Retained output does not match its authoritative terminal record.');
  let end = 0,
    sequence = -1,
    retainedBytes = 0;
  const streams = { stdout: { end: 0, bytes: 0 }, stderr: { end: 0, bytes: 0 } };
  for (const chunk of output.chunks) {
    const bytes = Buffer.byteLength(chunk.text);
    const stream = streams[chunk.stream];
    if (
      !bytes ||
      chunk.start < end ||
      chunk.end !== chunk.start + bytes ||
      chunk.end > output.observedBytes ||
      chunk.sequence < sequence ||
      chunk.streamStart < stream.end ||
      chunk.streamStart + bytes > terminal[chunk.stream].observedBytes
    )
      throw new Error('Retained output has invalid source ranges.');
    end = chunk.end;
    sequence = chunk.sequence;
    retainedBytes += bytes;
    stream.end = chunk.streamStart + bytes;
    stream.bytes += bytes;
  }
  if (
    retainedBytes !== output.retainedBytes ||
    streams.stdout.bytes !== terminal.stdout.capturedBytes ||
    streams.stderr.bytes !== terminal.stderr.capturedBytes
  )
    throw new Error('Retained output does not cover its recorded capture.');
  return output;
}

/** Redact before selection so slicing cannot detach a credential from its identifying prefix. */
function redactChunks(chunks: readonly CapturedChunk[]): readonly CapturedChunk[] {
  const source = Buffer.from(chunks.map((chunk) => chunk.text).join(''), 'utf8');
  const redacted = Buffer.from(
    redactTextPreservingLength(source.toString('latin1')).text,
    'latin1'
  );
  let offset = 0;
  return chunks.map((chunk) => {
    const end = offset + chunk.bytes;
    const selected = redacted.subarray(offset, end).toString('utf8');
    offset = end;
    return { ...chunk, text: selected };
  });
}

export function processOutputView(
  chunks: readonly CapturedChunk[],
  maxBytes: number,
  afterCursor: number,
  observedBytes: number,
  stream?: LocalOutputStream
): CommandOutputView {
  const passages: string[] = [];
  let end: number | undefined;
  let start: number | undefined;
  for (const chunk of redactChunks(chunks)) {
    if (chunk.end <= afterCursor || (stream !== undefined && chunk.stream !== stream)) continue;
    const text = dropUtf8Bytes(chunk.text, Math.max(0, afterCursor - chunk.start));
    const bytes = Buffer.byteLength(text, 'utf8');
    const chunkStart =
      (stream === undefined ? chunk.start : chunk.streamStart) + chunk.bytes - bytes;
    start ??= chunkStart;
    if (end !== chunkStart || passages.length === 0) passages.push('');
    end = chunkStart + bytes;
    passages[passages.length - 1] = (passages[passages.length - 1] ?? '') + text;
  }
  let segments = passages.filter((text) => text.length > 0);
  const retained = segments.reduce((bytes, text) => bytes + Buffer.byteLength(text, 'utf8'), 0);
  let startsAtOutputStart = observedBytes === 0 || start === 0;
  let endsAtOutputEnd = observedBytes === 0 || end === observedBytes;
  if (retained > maxBytes) {
    const head: string[] = [];
    const tail: string[] = [];
    let remaining = maxBytes - Math.floor(maxBytes / 3);
    for (const text of segments) {
      const selected = takeUtf8Start(text, remaining);
      if (selected) head.push(selected);
      remaining -= Buffer.byteLength(selected, 'utf8');
      if (selected.length !== text.length) break;
    }
    remaining =
      maxBytes - head.reduce((bytes, text) => bytes + Buffer.byteLength(text, 'utf8'), 0);
    for (const text of [...segments].reverse()) {
      const selected = takeUtf8End(text, remaining);
      if (selected) tail.unshift(selected);
      remaining -= Buffer.byteLength(selected, 'utf8');
      if (selected.length !== text.length) break;
    }
    startsAtOutputStart &&= head.length > 0;
    endsAtOutputEnd &&= tail.length > 0;
    segments = [...head, ...tail];
  }
  return createCommandOutputView({
    segments,
    observedBytes,
    capturedBytes: segments.reduce((bytes, text) => bytes + Buffer.byteLength(text, 'utf8'), 0),
    startsAtOutputStart,
    endsAtOutputEnd
  });
}

export function takeUtf8Start(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1] ?? '')) low -= 1;
  return value.slice(0, low);
}
export function takeUtf8End(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(middle), 'utf8') <= maxBytes) high = middle;
    else low = middle + 1;
  }
  if (/[\uDC00-\uDFFF]/u.test(value[low] ?? '')) low += 1;
  return value.slice(low);
}
function dropUtf8Bytes(value: string, bytes: number): string {
  if (bytes <= 0) return value;
  let consumed = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.codePointAt(index);
    if (code === undefined) return '';
    const character = String.fromCodePoint(code);
    const size = Buffer.byteLength(character, 'utf8');
    if (consumed + size > bytes) return value.slice(index);
    consumed += size;
    index += character.length;
    if (consumed === bytes) return value.slice(index);
  }
  return '';
}
