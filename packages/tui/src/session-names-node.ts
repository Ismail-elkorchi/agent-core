import { parseJsonObject } from '@agent-core/json';
import { atomicWritePrivateJson } from '@agent-core/persistence/node';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSessionName, type SessionNames } from './session-name.js';

/** Display metadata is separate from accepted conversation history. */
export class FileSessionNames implements SessionNames {
  constructor(private readonly directory: string) {}

  async read(sessionId: string): Promise<string | undefined> {
    let source: string;
    try {
      source = await readFile(this.file(sessionId), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    const value = parseJsonObject(JSON.parse(source));
    if (Object.keys(value).some((key) => key !== 'name'))
      throw new Error('Unsupported session display metadata.');
    return parseSessionName(value.name) || undefined;
  }

  write(sessionId: string, name: string): Promise<void> {
    return atomicWritePrivateJson(this.file(sessionId), { name: parseSessionName(name) });
  }

  private file(sessionId: string): string {
    return path.join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  }
}
