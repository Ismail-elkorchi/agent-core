import { withPersistenceFileLock } from '@agent-core/persistence/node';

const [filePath] = process.argv.slice(2);
await withPersistenceFileLock(filePath, 5_000, 10, async () => {
  process.stdout.write('acquired\n');
  await new Promise(resolve => {
    const keepAlive = setInterval(() => undefined, 1_000);
    process.once('SIGTERM', () => {
      clearInterval(keepAlive);
      resolve();
    });
  });
});
