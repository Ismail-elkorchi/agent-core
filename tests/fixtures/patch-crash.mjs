import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const transactionId = 'crash-fixture';
const token = createHash('sha256').update(transactionId).digest('hex').slice(0, 20);
const backupName = `.agent-core-patch-${token}-0-backup-write`;
const stageName = `.agent-core-patch-${token}-0-stage`;
const journalDirectory = path.join(root, '.agent-core', 'transactions', 'patch');
const transactionDirectory = path.join(journalDirectory, transactionId);
const sourceStat = await stat(path.join(root, 'note.txt'), { bigint: true });
const expectedCurrentIdentity = {
  device: String(sourceStat.dev), inode: String(sourceStat.ino), mode: String(sourceStat.mode), links: String(sourceStat.nlink), size: String(sourceStat.size),
  modifiedNanoseconds: String(sourceStat.mtimeNs), changedNanoseconds: String(sourceStat.ctimeNs)
};
await mkdir(transactionDirectory, { recursive: true, mode: 0o700 });
await writeFile(path.join(root, stageName), 'after\n', { mode: 0o600 });
const manifest = {
  version: 1,
  transactionId,
  phase: 'prepared',
  createdDirectories: [],
  writes: [{
    path: 'note.txt', stageName, backupName,
    newSha256: createHash('sha256').update('after\n').digest('hex'),
    mode: 0o600, overwrite: true,
    expectedCurrentSha256: createHash('sha256').update('before\n').digest('hex'),
    expectedCurrentIdentity
  }],
  removes: []
};
const payload = JSON.stringify(manifest);
await writeFile(path.join(transactionDirectory, 'transaction.json'), JSON.stringify({
  version: 1,
  payload: manifest,
  sha256: createHash('sha256').update(payload).digest('hex')
}), { mode: 0o600 });
await rename(path.join(root, 'note.txt'), path.join(root, backupName));
process.exit(42);
