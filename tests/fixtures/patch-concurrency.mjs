import { commitTextFilePatchTransaction } from '@agent-core/tools-local/testing/text-write';
import { TextPatchJournal, RootedFileAuthority } from '@agent-core/tools-local';

const [root, journalDirectory, relativePath, expectedCurrentSha256, expectedIdentity, content] = process.argv.slice(2);
const rootedFileAuthority = RootedFileAuthority.adopt(root);
const journal = TextPatchJournal.adopt(journalDirectory);
const expectedCurrentIdentity = JSON.parse(expectedIdentity);
const result = await commitTextFilePatchTransaction(rootedFileAuthority, journal, {
  writes: [{ path: relativePath, content, overwrite: true, expectedCurrentSha256, expectedCurrentIdentity }],
  removes: []
});
rootedFileAuthority.close(); journal.close();
process.stdout.write(JSON.stringify(result));
