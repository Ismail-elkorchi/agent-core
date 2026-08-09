import { promises as fs } from 'node:fs';

if (process.platform !== 'win32') await fs.chmod(new URL('../packages/cli/dist/index.js', import.meta.url), 0o755);
