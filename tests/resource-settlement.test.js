import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventRepository } from '@agent-core/persistence';
import { agentEventCodec, commitResourceRelease } from '@agent-core/runtime';

const report = {
  resourceId: 'process-1', outcome: 'released',
  details: { owner: { ownerId: 'session-1', runId: 'run-1' }, status: 'exited', exitCode: 0 }
};
const repository = () => new InMemoryEventRepository(agentEventCodec);

test('resource receipt replay verifies durable facts and retries a lost acknowledgement', async () => {
  const events = repository();
  let acknowledgements = 0;
  const input = { runId: 'run-1', report, events, acknowledge: async () => {
    if (++acknowledgements === 1) throw new Error('lost acknowledgement');
  } };
  await assert.rejects(commitResourceRelease(input), /lost acknowledgement/);
  const first = await commitResourceRelease(input);
  const second = await commitResourceRelease(input);
  assert.deepEqual(first, second);
  assert.equal((await events.tail('run-1')).sequence, 0);
  assert.equal(acknowledgements, 3);
});

for (const changed of [
  { resourceId: 'another-process' },
  { details: { ...report.details, exitCode: 9 } },
  { details: { ...report.details, owner: { ownerId: 'another-session', runId: 'run-1' } } }
]) test(`supplied settlement reference rejects changed ${JSON.stringify(changed)}`, async () => {
  const events = repository();
  const settlementReference = await commitResourceRelease({ runId: 'run-1', report, events });
  let acknowledged = false;
  await assert.rejects(commitResourceRelease({ runId: 'run-1', events,
    report: { ...report, ...changed, settlementReference },
    acknowledge: async () => { acknowledged = true; }
  }), /does not match/);
  assert.equal(acknowledged, false);
});

test('settlement references cannot cross runs even with matching resource facts', async () => {
  const events = repository();
  const settlementReference = await commitResourceRelease({ runId: 'run-1', report, events });
  await assert.rejects(commitResourceRelease({ runId: 'run-2', events,
    report: { ...report, details: {}, settlementReference }
  }), /another run/);
});

test('blocked finalization leaves the release key available for the terminal report', async () => {
  const events = repository();
  await assert.rejects(commitResourceRelease({ runId: 'run-1', events,
    report: { ...report, outcome: 'unknown', details: { ...report.details, finalizationPending: true } }
  }), /unknown/);
  assert.equal(await events.referenceByKey('run-1', 'run-1:resource:process-1:released'), undefined);
  await commitResourceRelease({ runId: 'run-1', report, events });
});

test('command settlement facts survive a recovered output presentation and diagnostics', async () => {
  const { commandReleaseReport } = await import('@agent-core/tools');
  const view = { segments: ['text'], observedBytes: 4, capturedBytes: 4, omittedBytes: 0,
    startsAtOutputStart: true, endsAtOutputEnd: true };
  const original = { result: { processId: 'process-1', owner: report.details.owner,
    status: 'exited', exitCode: 0, signal: null, cursorEnd: 4, cursorStart: 0,
    stdout: view, stderr: view, combined: view },
    terminalOutput: { stdout: { observedBytes: 4, capturedBytes: 4 },
      stderr: { observedBytes: 4, capturedBytes: 4 }, combined: { observedBytes: 4, capturedBytes: 4 } },
    terminalDiagnostic: 'Original execution diagnostic' };
  const recoveredView = { ...view, segments: [], capturedBytes: 0, omittedBytes: 4 };
  const recovered = { ...original, result: { ...original.result, stdout: recoveredView,
    stderr: recoveredView, combined: recoveredView,
    diagnostic: 'Recovered during restart', originalOutput: { kind: 'captured', cursorEnd: 4, omittedBytes: 0 } } };
  const events = repository();
  const first = await commitResourceRelease({ runId: 'run-1', events, report: commandReleaseReport(original) });
  const second = await commitResourceRelease({ runId: 'run-1', events, report: commandReleaseReport(recovered) });
  assert.deepEqual(first, second);
  const { event } = await events.readReference(second);
  assert.equal(event.details.diagnostic, 'Original execution diagnostic');
  assert.equal(event.details.combined.capturedBytes, 4);
});

test('a fresh repository verifies the same durable release after restart and lost acknowledgement', async (t) => {
  const { JsonlEventRepository } = await import('@agent-core/persistence/node');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const rootDir = await mkdtemp(path.join(tmpdir(), 'resource-settlement-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const first = new JsonlEventRepository({ rootDir, codec: agentEventCodec });
  await assert.rejects(commitResourceRelease({ runId: 'run-1', report, events: first,
    acknowledge: async () => { throw new Error('connection lost'); }
  }), /connection lost/);
  let acknowledged;
  const restarted = new JsonlEventRepository({ rootDir, codec: agentEventCodec });
  await commitResourceRelease({ runId: 'run-1', report, events: restarted,
    acknowledge: async (resourceId) => { acknowledged = resourceId; }
  });
  assert.equal(acknowledged, report.resourceId);
  assert.equal((await restarted.tail('run-1')).sequence, 0);
});
