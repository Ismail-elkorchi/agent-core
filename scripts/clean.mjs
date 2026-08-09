import { promises as fs } from 'node:fs';
import path from 'node:path';

async function cleanDirectory(directory, depth) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === 'dist') await fs.rm(target, { recursive: true, force: true });
    else if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) await fs.rm(target, { force: true });
    else if (entry.isDirectory() && depth > 0) await cleanDirectory(target, depth - 1);
  }
}

await cleanDirectory(path.resolve('packages'), 2);
