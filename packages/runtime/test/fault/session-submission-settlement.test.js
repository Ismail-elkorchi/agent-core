import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import { AgentRunCoordinator, AgentSession, agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const binding = Object.freeze({ schemaId: 'agent-core.tests/session-settlement', schemaVersion: 1, subject: Object.freeze({ fixture: 'fault-session' }) });

for (const [timing, exitStatus, expectedResumes] of [['before', 64, 1], ['after', 65, 0]]) {
  test(`session submission settlement recovers exactly once after process death ${timing} commit`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `agent-session-settlement-${timing}-`));
    try {
      const fixture = path.resolve('packages/runtime/test/fault/fixtures/session-settlement-crash.mjs');
      const crashed = spawnSync(process.execPath, [fixture, root, timing], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 });
      assert.equal(crashed.status, exitStatus, crashed.stderr);

      const repository = new JsonlSessionRepository({ rootDir: path.join(root, 'sessions') });
      const descriptor = await repository.open('fault-session', binding);
      const events = new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
      let resumes = 0;
      const restored = new AgentSession({
        descriptor,
        expectedBinding: binding,
        repository,
        runs: new AgentRunCoordinator(events),
        configuration: { provider: 'fixture', model: 'fixture' },
        createRuntime() {
          return {
            resume(runId) {
              resumes += 1;
              return control(runId, Promise.resolve({ state: 'ended', terminal: { runId }, deliveryDiagnostics: [] }));
            },
            run() { throw new Error('Recovered claimed work must resume its durable operation.'); }
          };
        }
      });
      await restored.restore();
      assert.equal(resumes, 0, 'restore is read-only');
      await restored.waitForIdle();
      assert.equal(resumes, expectedResumes);
      assert.deepEqual(await repository.loadPendingSubmissions(descriptor), []);

      const ledger = await readFile(repository.location(descriptor.id), 'utf8');
      assert.equal((ledger.match(/"type":"submission\.completed"/gu) ?? []).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

function control(runId, result) {
  return { runId, result, injectSteering() { throw new Error('unused'); }, abort() {} };
}
