import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, LocalCommandExecution, WorkspaceFileRoot } from '@agent-core/tools-local';

const root = path.resolve(process.argv[2]);
await mkdir(root, { recursive: true });
const manager = new LocalCommandExecution({
  artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') }),
  workspaceFileRoot: WorkspaceFileRoot.adopt(root),
  ledgerDirectory: path.join(root, 'processes'),
  ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
  onSupervisorCheckpoint(checkpoint, processId) {
    if (checkpoint !== 'released') return;
    process.stdout.write(JSON.stringify({ processId }) + '\n');
    process.exit(46);
  }
});
const prepared = await manager.prepare({
  command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setTimeout(() => process.exit(0), 30)')}`,
  workspacePath: '.',
  pty: false,
  timeoutMs: 5_000,
  yieldMs: 1,
  outputTokenBudget: 100,
  owner: { runId: 'recovered-run', turnId: 'turn', toolBatchId: 'batch', callIndex: 0 }
});
await manager.start(prepared);
