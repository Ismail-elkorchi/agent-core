import { commitTextFilePatchTransaction } from '@agent-core/tools-local/testing/text-write';
import path from 'node:path';

const [root, journalDirectory, relativePath, expectedCurrentSha256, content] = process.argv.slice(2);
const result = await commitTextFilePatchTransaction(root, {
  writes: [{ path: relativePath, absolutePath: path.join(root, relativePath), content, overwrite: true, expectedCurrentSha256 }],
  removes: []
}, { journalDirectory });
process.stdout.write(JSON.stringify(result));
