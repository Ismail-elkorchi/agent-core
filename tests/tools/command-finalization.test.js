import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalCommandExecution } from '@agent-core/tools-local';

// Exercise observation finalization without launching a process or opening a socket.
function terminalObservation(report) {
  const process = { id: 'terminal-process', owner: { ownerId: 'owner' },
    status: 'exited', exitCode: 0, signal: null,
    cursor: 0, oldestCursor: 0, history: [], observed: { stdout: 0, stderr: 0 },
    progressDroppedEvents: 0, progressDeliveryErrors: 0 };
  const command = Object.assign(Object.create(LocalCommandExecution.prototype), {
    ready: Promise.resolve(), active: new Map(), completed: new Map([[process.id, process]]),
    finish: async () => report
  });
  return { command, process };
}

test('a resolved but undurable terminal report remains finalizationPending through query', async () => {
  const { command, process } = terminalObservation({ result: { finalizationPending: true } });
  const pending = await command.query(process.id, 100, 0, 0, process.owner);
  assert.equal(pending.status, 'exited');
  assert.equal(pending.exitCode, 0);
  assert.equal(pending.finalizationPending, true);
  command.finish = async () => ({ result: {} });
  const durable = await command.query(process.id, 100, 0, 0, process.owner);
  assert.equal(durable.status, 'exited');
  assert.equal(durable.exitCode, 0);
  assert.equal(durable.finalizationPending, undefined);
});
