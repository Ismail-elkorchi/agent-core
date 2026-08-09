import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, ProcessManager } from '@agent-core/tools-local';

const root = path.resolve(process.argv[2]);
const phase = process.argv[3];
const marker = path.join(root, 'user-command-started');
await mkdir(root, { recursive: true });
const manager = new ProcessManager({
  artifactRepository: new LocalArtifactRepository({ rootDir: path.join(root, 'artifacts') }),
  ledgerDirectory: path.join(root, 'processes'),
  ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process,
  supervisorReleaseTimeoutMs: 300,
  onSupervisorCheckpoint(checkpoint, processId) {
    if (checkpoint !== phase) return;
    process.stdout.write(JSON.stringify({ processId, checkpoint }) + '\n');
    process.exit(45);
  }
});
await manager.start({
  command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(()=>{},1000)`)}`,
  cwd: root,
  pty: false,
  timeoutMs: 60_000,
  yieldMs: 1,
  outputTokenBudget: 100,
  owner: { runId: `crash-${phase}`, turnId: 'turn', toolBatchId: 'batch', callIndex: 0 }
});
