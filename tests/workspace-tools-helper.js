import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { adoptWorkspaceFiles } from '@agent-core/tools';
import { createWorkspaceToolHost } from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from './tool-call-helpers.js';

export function workspaceTools(
  initial,
  enabledTools = [
    'read_files',
    'edit_text',
    'apply_patch',
    'find_files',
    'search_text',
    'view_image'
  ],
  configuration
) {
  const content = new Map(
    Object.entries(initial).map(([name, value]) => [
      name,
      { bytes: Buffer.from(value), mode: 0o755 }
    ])
  );
  let transactions = 0;
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const revision = (bytes) => ({ size: bytes.length, digest: digest(bytes) });
  const files = adoptWorkspaceFiles({
    descriptor: Object.freeze({
      implementationId: 'tests.workspace@1',
      workspaceId: 'workspace',
      displayRoot: '/',
      capabilities: Object.freeze(['read', 'write', 'transaction'])
    }),
    normalize(value) {
      return path.posix.normalize(value);
    },
    async stat(name) {
      const file = content.get(name);
      return file
        ? { kind: 'file', path: name, mode: file.mode, revision: revision(file.bytes) }
        : name === '.'
          ? { kind: 'directory', path: '.', mode: 0o755 }
          : { kind: 'absent', path: name };
    },
    async *list() {
      for (const name of [...content.keys()].sort()) yield { name, type: 'file' };
    },
    async readRange(name, { offset, length }) {
      const file = content.get(name);
      if (!file) throw new Error('unreadable');
      return { bytes: file.bytes.subarray(offset, offset + length), revision: revision(file.bytes) };
    },
    async readFile(name, { maximumBytes = Infinity } = {}) {
      const file = content.get(name);
      if (!file) throw new Error('unreadable');
      if (file.bytes.length > maximumBytes) throw new Error('read limit');
      return { bytes: file.bytes, revision: revision(file.bytes) };
    },
    async transaction(mutations) {
      for (const mutation of mutations) {
        const file = content.get(mutation.path);
        if (mutation.expected.kind === 'absent') assert.equal(file, undefined);
        if (mutation.expected.kind === 'matches')
          assert.equal(digest(file.bytes), mutation.expected.digest);
      }
      transactions++;
      for (const mutation of mutations) {
        if (mutation.kind === 'remove') content.delete(mutation.path);
        else content.set(mutation.path, { bytes: mutation.bytes, mode: mutation.mode });
      }
    },
    async mkdir() {},
    async remove() {},
    close() {}
  });
  const host = createWorkspaceToolHost({
    files,
    artifacts: new InMemoryArtifactRepository(),
    enabledTools,
    ...(configuration ? { configuration } : {})
  });
  return {
    files,
    host,
    content,
    digest,
    get transactions() {
      return transactions;
    },
    invoke(name, input, risks = ['read', 'write', 'destructive']) {
      return invokeToolCall(jsonToolCall(name, input), host.tools, {
        policy: { allowedRisks: risks },
        services: host.services
      });
    }
  };
}

