import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LocalArtifactRepository } from '@agent-core/persistence/node';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, LocalCommandExecution, RootedFileAuthority } from '@agent-core/tools-local';

const root = path.resolve(process.argv[2]);
await mkdir(root, { recursive: true });
const manager = new LocalCommandExecution({
  artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') }),
  rootedFileAuthority: RootedFileAuthority.adopt(root),
  ledgerDirectory: path.join(root, 'processes'),
  ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process
});
const plan = await manager.plan({
  command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(()=>{},1000)')}`,
  rootedDirectory: '.', pty: false, timeoutMs: 60_000, yieldMs: 20, outputTokenBudget: 1_000,
  owner: { runId: 'orphan-run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 }
});
const result = await manager.start(plan);
process.stdout.write(JSON.stringify({ processId: result.processId }) + '\n');
process.exit(44);
