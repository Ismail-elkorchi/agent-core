import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareCandidateWorkspaceAcceptance } from '@agent-core/runtime';
import { LocalCandidateWorkspace, RootedFileAuthority, captureWorkspaceSnapshot } from '@agent-core/tools-local';

test('candidate workspaces isolate edits, checkpoint, roll back, and promote one exact snapshot', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-core-candidate-'));
  const sourceDirectory = path.join(parent, 'source');
  const runtimeDirectory = path.join(parent, 'runtime');
  await mkdir(path.join(sourceDirectory, 'src'), { recursive: true });
  await writeFile(path.join(sourceDirectory, 'src', 'value.txt'), 'baseline\n');
  await writeFile(path.join(sourceDirectory, 'keep.txt'), 'keep\n');
  const source = RootedFileAuthority.adopt(sourceDirectory);
  let candidate;
  try {
    const baseline = await captureWorkspaceSnapshot(source);
    candidate = await LocalCandidateWorkspace.open({ source, baseline, runtimeDirectory, runId: 'run-candidate' });
    assert.equal(await readFile(path.join(sourceDirectory, 'src', 'value.txt'), 'utf8'), 'baseline\n');

    await writeFile(path.join(candidate.root.identity.canonicalPath, 'src', 'value.txt'), 'checkpoint\n');
    const saved = await candidate.checkpoint('working edit');
    await writeFile(path.join(candidate.root.identity.canonicalPath, 'src', 'value.txt'), 'discarded\n');
    await candidate.rollback(saved.checkpointId);
    assert.equal(await readFile(path.join(candidate.root.identity.canonicalPath, 'src', 'value.txt'), 'utf8'), 'checkpoint\n');

    await candidate.rollback(candidate.baseline.checkpointId);
    assert.equal(await readFile(path.join(candidate.root.identity.canonicalPath, 'src', 'value.txt'), 'utf8'), 'baseline\n');
    await writeFile(path.join(candidate.root.identity.canonicalPath, 'src', 'value.txt'), 'candidate\n');
    const diff = await candidate.diff();
    assert.equal(diff.coverage, 'complete');
    assert.deepEqual(diff.entries.map((entry) => [entry.path, entry.kind]), [['src/value.txt', 'modified']]);
    assert.equal(await readFile(path.join(sourceDirectory, 'src', 'value.txt'), 'utf8'), 'baseline\n');

    const disposition = await prepareCandidateWorkspaceAcceptance(candidate);
    assert.equal(typeof disposition.start, 'function');
    const decision = await disposition.start(new AbortController().signal);
    assert.deepEqual(decision, { kind: 'accept' });
    assert.equal(await readFile(path.join(sourceDirectory, 'src', 'value.txt'), 'utf8'), 'candidate\n');
    assert.equal(await readFile(path.join(sourceDirectory, 'keep.txt'), 'utf8'), 'keep\n');
    const reconciled = await disposition.reconcile(new AbortController().signal);
    assert.equal(reconciled.status, 'settled');
    assert.deepEqual(reconciled.decision, { kind: 'accept' });
    await writeFile(path.join(sourceDirectory, 'src', 'value.txt'), 'changed-after-publication\n');
    const staleReconciliation = await disposition.reconcile(new AbortController().signal);
    assert.equal(staleReconciliation.status, 'settled');
    assert.equal(staleReconciliation.decision.kind, 'inconclusive');
    assert.match(staleReconciliation.decision.reason, /no longer matches the exact candidate/u);
    await disposition.release();
  } finally {
    await candidate?.release();
    source.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test('candidate promotion refuses a stale source and never overwrites concurrent work', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-core-candidate-stale-'));
  const sourceDirectory = path.join(parent, 'source');
  await mkdir(sourceDirectory);
  await writeFile(path.join(sourceDirectory, 'value.txt'), 'baseline\n');
  const source = RootedFileAuthority.adopt(sourceDirectory);
  let candidate;
  try {
    const baseline = await captureWorkspaceSnapshot(source);
    candidate = await LocalCandidateWorkspace.open({ source, baseline, runtimeDirectory: path.join(parent, 'runtime'), runId: 'run-stale' });
    await writeFile(path.join(candidate.root.identity.canonicalPath, 'value.txt'), 'candidate\n');
    await writeFile(path.join(sourceDirectory, 'value.txt'), 'concurrent\n');
    const prepared = await candidate.preparePromotion();
    assert.equal(typeof prepared.start, 'function');
    const promotion = await prepared.start(new AbortController().signal);
    assert.deepEqual(promotion, { status: 'not_promoted', reason: 'The source workspace changed after candidate isolation; publication was not started.' });
    assert.equal(await readFile(path.join(sourceDirectory, 'value.txt'), 'utf8'), 'concurrent\n');
  } finally {
    await candidate?.release();
    source.close();
    await rm(parent, { recursive: true, force: true });
  }
});
