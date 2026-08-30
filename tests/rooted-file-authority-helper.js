import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { TextPatchJournal, RootedFileAuthority } from '@agent-core/tools-local';

const roots = new Map();
const journals = new Map();

export function testRootedFileAuthority(rootPath) {
  const absolute = path.resolve(rootPath);
  let root = roots.get(absolute);
  if (!root) { root = RootedFileAuthority.adopt(absolute); roots.set(absolute, root); }
  return root;
}

export function testPatchJournal(root) {
  let journal = journals.get(root.displayPath);
  if (!journal) {
    const identity = createHash('sha256').update(root.displayPath).digest('hex');
    const journalPath = path.join(tmpdir(), 'agent-core-test-journals', identity);
    mkdirSync(journalPath, { recursive: true, mode: 0o700 });
    journal = TextPatchJournal.adopt(journalPath);
    journals.set(root.displayPath, journal);
  }
  return journal;
}

process.once('exit', () => {
  for (const journal of journals.values()) journal.close();
  for (const root of roots.values()) root.close();
});
