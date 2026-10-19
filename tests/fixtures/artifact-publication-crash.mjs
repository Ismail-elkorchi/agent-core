import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LocalArtifactRepository } from '@agent-core/persistence/node';

const [directory, visibility] = process.argv.slice(2);
const link = fs.link.bind(fs);
fs.link = async (source, target) => {
  await link(source, target);
  if (path.basename(source).startsWith('tmp-')) {
    process.send({ type: 'body-linked', target });
    // Keep this owner alive until the parent terminates it at the publication boundary.
    await new Promise(() => { setInterval(() => {}, 60_000); });
  }
};
const repository = new LocalArtifactRepository(directory);
const input = { label: 'original', mediaType: 'text/plain', content: Buffer.from('immutable artifact evidence') };
await (visibility === 'protected' ? repository.storeProtected(input) : repository.store(input));
throw new Error('The publication crash boundary was not reached.');
