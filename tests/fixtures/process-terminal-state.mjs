import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, ProcessManager } from '@agent-core/tools-local';

const root = path.resolve(process.argv[2]);
await mkdir(root, { recursive: true });
const manager = new ProcessManager({
  artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') }),
  ledgerDirectory: path.join(root, 'processes'),
  ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
  onSupervisorCheckpoint(checkpoint, processId) {
    if (checkpoint !== 'released') return;
    process.stdout.write(JSON.stringify({ processId }) + '\n');
    process.exit(46);
  }
});
await manager.start({
  command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setTimeout(() => process.exit(0), 30)')}`,
  cwd: root,
  pty: false,
  timeoutMs: 5_000,
  yieldMs: 1,
  outputTokenBudget: 100,
  owner: { runId: 'recovered-run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 }
});
