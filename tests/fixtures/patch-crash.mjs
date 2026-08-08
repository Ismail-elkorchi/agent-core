import { promises as fs } from 'node:fs';
import path from 'node:path';
import { commitTextFilePatchTransaction } from '@agent-core/tools-local/testing/text-write';

const root = path.resolve(process.argv[2]);
const target = path.join(root, 'note.txt');
const journalDirectory = path.join(root, '.agent-core', 'transactions', 'patch');
const fileSystem = new Proxy(fs, {
  get(targetObject, property) {
    if (property !== 'rename') return Reflect.get(targetObject, property, targetObject);
    return async (source, destination) => {
      await fs.rename(source, destination);
      if (String(destination).includes('backup-write-')) process.exit(42);
    };
  }
});

await commitTextFilePatchTransaction(root, {
  writes: [{ path: 'note.txt', absolutePath: target, content: 'after\n', overwrite: true }],
  removes: []
}, { journalDirectory, transactionId: 'crash-fixture', fileSystem });
