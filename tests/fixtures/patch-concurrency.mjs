import { commitTextFilePatchTransaction } from '@agent-core/tools-local/testing/text-write';
import { TextPatchJournal, WorkspaceFileRoot } from '@agent-core/tools-local';

const [root, journalDirectory, relativePath, expectedCurrentSha256, content] = process.argv.slice(2);
const workspaceFileRoot = WorkspaceFileRoot.adopt(root);
const journal = TextPatchJournal.adopt(journalDirectory);
const expectedCurrentIdentity = await workspaceFileRoot.fileIdentity(relativePath);
const result = await commitTextFilePatchTransaction(workspaceFileRoot, journal, {
  writes: [{ path: relativePath, content, overwrite: true, expectedCurrentSha256, expectedCurrentIdentity }],
  removes: []
});
workspaceFileRoot.close(); journal.close();
process.stdout.write(JSON.stringify(result));
