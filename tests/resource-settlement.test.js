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

function reportScope(events, runIds = ['run-1'], inherited = new Map()) {
  return { events, ownerId: 'session-1', session: { id: 'session-1' }, repository: {
    async sourceSnapshot() { return { branchId: 'branch-1', index: { runs: { async has(id) { return runIds.includes(id); } } }, inheritedHeads: Promise.resolve(inherited) }; }
  } };
}

test('public committed resource pages retain exact references and exclude protected fields', async () => {
  const { readResourceReleaseReports } = await import('@agent-core/runtime');
  const events = repository();
  for (let index = 0; index < 19; index++) await commitResourceRelease({ runId: 'run-1', events,
    report: { ...report, resourceId: `process-${index}`, details: { ...report.details,
      protectedArtifact: { artifactId: 'secret-output' }, futureSecret: 'also-private' } } });
  const scope = reportScope(events);
  let afterSequence = -1;
  const found = [];
  for (;;) {
    const page = await readResourceReleaseReports(scope, { runId: 'run-1', afterSequence, limit: 3, maxBytes: 4096 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
    assert.equal(JSON.stringify(page).includes('secret'), false);
    for (const entry of page.reports) {
      assert.equal((await events.readReference(entry.settlementReference)).event.resourceId, entry.resourceId);
      found.push(entry.resourceId);
    }
    if (page.complete) break;
    assert.ok(page.next > afterSequence);
    afterSequence = page.next;
  }
  assert.equal(new Set(found).size, 19);
  await assert.rejects(readResourceReleaseReports(scope, { runId: 'sibling-run' }), /outside/);
  assert.deepEqual((await readResourceReleaseReports({ ...scope, ownerId: 'other-session' }, { runId: 'run-1' })).reports, []);
});

test('oversized committed records identify a skippable source without reading protected content', async () => {
  const { readResourceReleaseReports } = await import('@agent-core/runtime');
  const events = repository();
  await commitResourceRelease({ runId: 'run-1', events, report: { ...report,
    details: { ...report.details, diagnostic: 'x'.repeat(10_000), protectedArtifact: { artifactId: 'secret' } } } });
  const page = await readResourceReleaseReports(reportScope(events), { runId: 'run-1', maxBytes: 1024 });
  assert.equal(page.reports.length, 0);
  assert.equal(page.oversized.reference.sequence, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024);
  const next = await readResourceReleaseReports(reportScope(events), { runId: 'run-1', afterSequence: page.oversized.reference.sequence });
  assert.equal(next.complete, true);
});

test('pending projection is bounded and excludes sibling and inherited run handoffs', async () => {
  const { readPendingResourceReports } = await import('@agent-core/runtime');
  const scope = reportScope(repository(), ['run-1', 'inherited'], new Map([['inherited', { runId: 'inherited', sequence: 4 }]]));
  let calls = 0;
  scope.command = { async readPendingTerminalReports(request) {
    calls++;
    assert.deepEqual(request, { ownerId: 'session-1', limit: 3, maxBytes: 1024 });
    return { reports: ['run-1', 'sibling', 'inherited'].map(runId => ({ processId: runId,
      owner: { ownerId: 'session-1', runId }, status: 'exited', finalizationPending: false,
      handoffPending: true, details: {} })), next: 'opaque-local-cursor', complete: false, scanned: 3 };
  } };
  for (let index = 0; index < 25; index++) {
    const page = await readPendingResourceReports(scope, { limit: 3, maxBytes: 1024 });
    assert.deepEqual(page.reports.map(item => item.owner.runId), ['run-1']);
    assert.deepEqual(JSON.parse(page.next), { branchId: 'branch-1', cursor: 'opaque-local-cursor' });
    assert.equal(page.complete, false);
  }
  assert.equal(calls, 25);
  assert.equal((await scope.events.tail('run-1')).sequence, -1);
});

test('public projection closes nested fields and rejects protected references in artifact slots', async () => {
  const { readResourceReleaseReports } = await import('@agent-core/runtime');
  const events = repository();
  await commitResourceRelease({ runId: 'run-1', events, report: { ...report, details: {
    ...report.details, owner: { ...report.details.owner, protectedArtifact: { artifactId: 'secret-owner' } },
    stdout: { observedBytes: 2, protectedArtifact: { artifactId: 'secret-stream' } },
    artifact: { visibility: 'protected', artifactId: 'secret-artifact' }
  } } });
  const page = await readResourceReleaseReports(reportScope(events), { runId: 'run-1' });
  assert.equal(page.reports.length, 1);
  assert.equal(JSON.stringify(page).includes('secret'), false);
  assert.deepEqual(page.reports[0].details.stdout, { observedBytes: 2 });
  assert.equal(page.reports[0].details.artifact, undefined);
});

test('committed pages honor inherited branch head and do not expose later receipts', async () => {
  const { readResourceReleaseReports } = await import('@agent-core/runtime');
  const events = repository();
  const first = await commitResourceRelease({ runId: 'run-1', events, report });
  await commitResourceRelease({ runId: 'run-1', events, report: { ...report, resourceId: 'later-process' } });
  const scope = reportScope(events, ['run-1'], new Map([['run-1', first]]));
  const page = await readResourceReleaseReports(scope, { runId: 'run-1' });
  assert.deepEqual(page.reports.map(item => item.resourceId), ['process-1']);
  assert.equal(page.complete, true);
});


test('pending cursor cannot cross session branch boundaries', async () => {
  const { readPendingResourceReports } = await import('@agent-core/runtime');
  await assert.rejects(readPendingResourceReports(reportScope(repository()), {
    after: JSON.stringify({ branchId: 'sibling-branch', cursor: 'opaque' })
  }), /another branch/);
});


test('resource report tool advertises and decodes only valid discriminated request shapes', async () => {
  const { createResourceReportTool } = await import('@agent-core/runtime');
  const tool = createResourceReportTool(reportScope(repository()));
  for (const value of [
    { kind: 'pending' }, { kind: 'pending', after: 'opaque', maxBytes: 1024 },
    { kind: 'committed', runId: 'run-1' }, { kind: 'committed', runId: 'run-1', after: -1, limit: 64 }
  ]) assert.equal(tool.decodeInput({ kind: 'json', value }).ok, true, JSON.stringify(value));
  for (const value of [
    { kind: 'pending', after: 0 }, { kind: 'pending', runId: 'run-1' },
    { kind: 'committed' }, { kind: 'committed', runId: '' },
    { kind: 'committed', runId: 'run-1', after: 'opaque' },
    { kind: 'committed', runId: 'run-1', after: -2 }, { kind: 'pending', after: 'x'.repeat(8193) }
  ]) assert.equal(tool.decodeInput({ kind: 'json', value }).ok, false, JSON.stringify(value).slice(0, 100));
  const variants = tool.jsonSchema.oneOf ?? tool.jsonSchema.anyOf;
  assert.equal(variants.length, 2);
  const pending = variants.find(item => item.properties.kind.const === 'pending');
  const committed = variants.find(item => item.properties.kind.const === 'committed');
  assert.equal(pending.properties.after.type, 'string');
  assert.equal(pending.properties.runId, undefined);
  assert.ok(committed.required.includes('runId'));
  assert.equal(committed.properties.after.type, 'integer');
});
