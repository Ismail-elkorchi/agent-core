import { ToolInputError } from '@agent-core/tools';
import type { LocalToolConfiguration } from './configuration.js';
import { rootedFileIdentitiesEqual, type RootedFileAuthority } from './rooted-file-authority.js';

export async function readRootedImage(
  root: RootedFileAuthority,
  filePath: string,
  limits: LocalToolConfiguration['artifact'],
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly onReading?: () => void | Promise<void>;
  } = {}
) {
  options.signal?.throwIfAborted();
  const handle = await root.openFile(filePath);
  try {
    if (handle.size > limits.maxImageEncodedBytes)
      throw new ToolInputError(
        `Image exceeds the encoded-byte host limit (${String(handle.size)} bytes, max ${String(limits.maxImageEncodedBytes)}).`
      );
    await options.onReading?.();
    const bytes = await handle.readAll(limits.maxImageEncodedBytes);
    options.signal?.throwIfAborted();
    let pathIdentity;
    try {
      pathIdentity = await root.fileIdentity(filePath);
    } catch {
      throw new ToolInputError(`Image file changed or was replaced while it was being read: ${filePath}`);
    }
    if (
      bytes.byteLength !== handle.size ||
      !rootedFileIdentitiesEqual(await handle.identityNow(), handle.identity) ||
      !rootedFileIdentitiesEqual(pathIdentity, handle.identity)
    )
      throw new ToolInputError(`Image file changed or was replaced while it was being read: ${filePath}`);
    const image = inspectImage(bytes, filePath);
    validateDimensions(image, limits, filePath);
    return { ...image, bytes };
  } finally {
    await handle.close();
  }
}

function inspectImage(
  bytes: Uint8Array,
  filePath: string
): { mediaType: `image/${string}`; width?: number; height?: number } {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (
      buffer.length < 33 ||
      buffer.readUInt32BE(8) !== 13 ||
      buffer.subarray(12, 16).toString('ascii') !== 'IHDR'
    )
      throw invalidImage(filePath, 'truncated or invalid PNG header');
    return dimensions('image/png', buffer.readUInt32BE(16), buffer.readUInt32BE(20), filePath);
  }
  if (
    buffer.length >= 10 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return dimensions('image/gif', buffer.readUInt16LE(6), buffer.readUInt16LE(8), filePath);
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return inspectWebp(buffer, filePath);
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return inspectJpeg(buffer, filePath);
  }
  throw new ToolInputError(`Unsupported or invalid image file: ${filePath}`);
}

function inspectJpeg(
  buffer: Buffer,
  filePath: string
): { mediaType: `image/${string}`; width: number; height: number } {
  let offset = 2;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ]);
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) throw invalidImage(filePath, 'truncated JPEG segment');
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length)
      throw invalidImage(filePath, 'invalid JPEG segment length');
    if (startOfFrame.has(marker)) {
      if (length < 7) throw invalidImage(filePath, 'truncated JPEG frame header');
      return dimensions(
        'image/jpeg',
        buffer.readUInt16BE(offset + 5),
        buffer.readUInt16BE(offset + 3),
        filePath
      );
    }
    offset += length;
  }
  throw invalidImage(filePath, 'JPEG dimensions are unavailable');
}

function inspectWebp(
  buffer: Buffer,
  filePath: string
): { mediaType: `image/${string}`; width: number; height: number } {
  if (buffer.length < 30 || buffer.readUInt32LE(4) + 8 > buffer.length)
    throw invalidImage(filePath, 'truncated WebP container');
  const kind = buffer.subarray(12, 16).toString('ascii');
  const chunkLength = buffer.readUInt32LE(16);
  if (20 + chunkLength > buffer.length) throw invalidImage(filePath, 'truncated WebP image chunk');
  if (kind === 'VP8X' && chunkLength >= 10)
    return dimensions('image/webp', readUInt24LE(buffer, 24) + 1, readUInt24LE(buffer, 27) + 1, filePath);
  if (
    kind === 'VP8 ' &&
    chunkLength >= 10 &&
    buffer[23] === 0x9d &&
    buffer[24] === 0x01 &&
    buffer[25] === 0x2a
  ) {
    return dimensions(
      'image/webp',
      buffer.readUInt16LE(26) & 0x3fff,
      buffer.readUInt16LE(28) & 0x3fff,
      filePath
    );
  }
  if (kind === 'VP8L' && chunkLength >= 5 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return dimensions('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, filePath);
  }
  throw invalidImage(filePath, 'unsupported or invalid WebP image chunk');
}

function dimensions(
  mediaType: `image/${string}`,
  width: number,
  height: number,
  filePath: string
): { mediaType: `image/${string}`; width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw invalidImage(filePath, 'invalid image dimensions');
  return { mediaType, width, height };
}
function validateDimensions(
  image: { width?: number; height?: number },
  limits: LocalToolConfiguration['artifact'],
  filePath: string
): void {
  if (image.width === undefined || image.height === undefined)
    throw invalidImage(filePath, 'image dimensions are unavailable');
  if (
    image.width > limits.maxImageWidth ||
    image.height > limits.maxImageHeight ||
    BigInt(image.width) * BigInt(image.height) > BigInt(limits.maxImagePixels)
  ) {
    throw new ToolInputError(
      `Image dimensions exceed host limits: ${String(image.width)}x${String(image.height)} (${filePath}).`
    );
  }
}
function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer.readUIntLE(offset, 3);
}
function invalidImage(filePath: string, reason: string): ToolInputError {
  return new ToolInputError(`Unsupported or invalid image file (${reason}): ${filePath}`);
}
