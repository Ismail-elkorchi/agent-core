import { rename, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

const [root, outside] = process.argv.slice(2);
const admitted = path.join(root, 'branch');
const held = path.join(root, 'branch-held');
process.stdout.write('ready\n');
for (;;) {
  try {
    await rename(admitted, held);
    await symlink(outside, admitted, 'dir');
    await new Promise((resolve) => setImmediate(resolve));
    await unlink(admitted);
    await rename(held, admitted);
  } catch {
    try { await unlink(admitted); } catch { /* The regular directory may be present. */ }
    try { await rename(held, admitted); } catch { /* The next iteration repairs or retries. */ }
  }
}
