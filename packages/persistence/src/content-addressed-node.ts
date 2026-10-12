import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { hashJson } from './ledger.js';
import { atomicWritePrivateJson } from './repositories.js';

/** Read at most the owner's declared limit, including files that grow during the read. */
export async function readBoundedJsonFile(file: string, maximumBytes: number): Promise<{readonly value: JsonObject; readonly bytes: number}> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError('JSON file byte limit must be positive.');
  const handle = await fs.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (!Number.isSafeInteger(size) || size < 1 || size > maximumBytes) throw new TypeError(`JSON metadata exceeds its ${String(maximumBytes)} byte limit or is empty.`);
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== size) throw new TypeError('JSON metadata changed while being read.');
    const value = parseJsonObject(JSON.parse(buffer.subarray(0,length).toString('utf8')), {
      maxDepth: 64, maxCollectionEntries: 50_000, maxStringBytes: maximumBytes, maxTotalBytes: maximumBytes
    });
    return {value, bytes: length};
  } finally {await handle.close();}
}

/** Checks derived-node consistency; a checksum is not authentication of external data. */
export async function readContentAddressedJsonNode(directory: string, hash: string, maximumBytes: number): Promise<{ readonly value: JsonObject; readonly bytes: number }> {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new TypeError('Invalid content-addressed node hash.');
  const node = await readBoundedJsonFile(path.join(directory, `${hash}.json`), maximumBytes);
  if (hashJson(node.value) !== hash) throw new TypeError('Content-addressed node checksum does not match.');
  return node;
}
export async function writeContentAddressedJsonNode(directory: string, value: JsonObject): Promise<string> {
  const hash = hashJson(value);
  await atomicWritePrivateJson(path.join(directory, `${hash}.json`), value);
  return hash;
}
