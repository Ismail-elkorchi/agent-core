import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { createLocalToolHost, RootedFileAuthority, TextPatchJournal, DEFAULT_LOCAL_TOOL_CONFIGURATION } from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from './tool-call-helpers.js';
import { workspaceTools } from './workspace-tools-helper.js';

const names = ['read_files', 'edit_text', 'apply_patch'];
const digest = (text) => createHash('sha256').update(text).digest('hex');
const invocation = { runId: 'run', turnId: 'turn', requestAttempt: 1, toolBatchId: 'batch', callIndex: 0, toolAttempt: 1 };

async function fixture(t, backend, initial, configuration = DEFAULT_LOCAL_TOOL_CONFIGURATION) {
  if (backend === 'workspace') {
    const f = workspaceTools(initial, names, configuration);
    return { ...f, read: async (name) => Buffer.from(f.content.get(name).bytes).toString('utf8') };
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'file-tool-conformance-'));
  const root = path.join(directory, 'workspace');
  const journal = path.join(directory, 'journal');
  await mkdir(root);
  await mkdir(journal, { mode: 0o700 });
  for (const [name, content] of Object.entries(initial))
    await writeFile(path.join(root, name), content, { mode: 0o755 });
  const host = createLocalToolHost({
    rootedFileAuthority: RootedFileAuthority.adopt(root),
    patchJournal: TextPatchJournal.adopt(journal),
    artifactRepository: new InMemoryArtifactRepository(),
    enabledTools: names,
    configuration
  });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  let index = 0;
  return {
    host,
    read: (name) => readFile(path.join(root, name), 'utf8'),
    invoke: (name, value, risks = ['read', 'write', 'destructive']) => invokeToolCall(
      jsonToolCall(name, value), host.tools,
      { invocation: { ...invocation, callIndex: index++ }, policy: { allowedRisks: risks }, services: host.services }
    )
  };
}

for (const backend of ['rooted', 'workspace']) {
  const options = { skip: backend === 'rooted' && process.platform !== 'linux' };
  test(`${backend}: bounded ranges retain original bytes and evidence for files larger than the output allowance`, options, async (t) => {
    const source = '\ufefffirst\r\n' + 'filler\n'.repeat(20_000) + 'last 😀\n';
    const f = await fixture(t, backend, { 'source.txt': source }, {
      ...DEFAULT_LOCAL_TOOL_CONFIGURATION,
      readFiles: { maxFiles: 1, maxLinesPerFile: 2, maxBytesPerFile: 128, maxTotalBytes: 128 }
    });
    const read = await f.invoke('read_files', { files: [{ path: 'source.txt', lineCount: 1 }] });
    assert.equal(read.kind, 'result', read.summary);
    assert.equal(read.output.files[0].content, '\ufefffirst\r\n');
    assert.equal(read.output.files[0].fullFileSha256, digest(source));
    assert.equal(read.output.files[0].rangeSha256, digest('\ufefffirst\r\n'));
    assert.equal(read.scope.coverage, 'complete');
    assert.equal(read.output.files[0].nextStartLine, 2);
    const capped = await f.invoke('read_files', { files: [{ path: 'source.txt', lineCount: 100 }] });
    assert.equal(capped.scope.coverage, 'partial');
    assert.ok(capped.scope.causes.includes('line_limit'));
    assert.equal(capped.observedFacts.items[0].scope.coverage, 'partial');
    assert.equal(read.observedFacts.items[0].scope.actuality, 'observed');
    assert.equal(read.observedFacts.items[0].resources[0].fullSha256, digest(source));
    const batch = await f.invoke('read_files', { files: [{ path: 'source.txt', startLine: 20_002 }, { path: 'source.txt' }] });
    assert.equal(batch.output.files[0].content, 'last 😀\n');
    assert.equal(batch.output.files[0].eof, true);
    assert.equal(batch.output.failures[0].reason, 'batch_file_limit');
    assert.equal(batch.scope.coverage, 'partial');
    assert.equal(batch.observedFacts.items[1].outcome, 'failure');
  });

  test(`${backend}: exact edits preserve BOM and untouched CRLF, allow explicit newlines, and report only real changes`, options, async (t) => {
    const source = '\ufeffhello 😀\r\nlast';
    const f = await fixture(t, backend, { 'source.txt': source });
    const edits = { files: [{ path: 'source.txt', expectedSha256: digest(source), edits: [
      { range: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } }, expectedText: 'last', replacementText: 'last\nnext' }
    ] }] };
    const dry = await f.invoke('edit_text', { ...edits, dryRun: true }, ['read']);
    assert.equal(dry.kind, 'result', dry.summary);
    assert.equal(dry.output.applicationStatus, 'dry_run');
    assert.deepEqual(dry.output.changedPaths, []);
    assert.equal(dry.observedFacts.items[0].scope.actuality, 'predicted');
    assert.equal(await f.read('source.txt'), source);
    const applied = await f.invoke('edit_text', edits);
    assert.equal(applied.kind, 'result', applied.summary);
    assert.equal(await f.read('source.txt'), '\ufeffhello 😀\r\nlast\nnext');
    assert.equal(applied.output.files[0].changedRanges.length, 1);
    assert.match(applied.output.diffSummary.text, /last.*next/);
    assert.deepEqual(applied.scope.resources, ['files/source.txt']);
    assert.equal(applied.observedFacts.items[0].scope.actuality, 'observed');
    assert.equal(applied.observedFacts.items[0].resources[0].sha256, digest(await f.read('source.txt')));
    const stale = await f.invoke('edit_text', edits);
    assert.equal(stale.kind, 'failure');
    assert.equal(stale.execution.state, 'not_started');
    const current = await f.read('source.txt');
    const unchanged = await f.invoke('edit_text', { files: [{
      path: 'source.txt', expectedSha256: digest(current), edits: [{
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } }, expectedText: 'last', replacementText: 'last'
      }]
    }] });
    assert.equal(unchanged.output.applicationStatus, 'no_change');
    assert.equal(unchanged.output.transactionOutcome, undefined);
    assert.deepEqual(unchanged.output.files[0].changedRanges, []);
    assert.deepEqual(unchanged.observedFacts.items, []);
  });

  test(`${backend}: edit order is irrelevant but overlapping insertion points are rejected`, options, async (t) => {
    const f = await fixture(t, backend, { 'source.txt': 'abcd' });
    const edit = (column, expectedText, replacementText) => ({
      range: { start: { line: 1, column }, end: { line: 1, column: column + expectedText.length } },
      expectedText, replacementText
    });
    const ambiguous = await f.invoke('edit_text', { files: [{
      path: 'source.txt', expectedSha256: digest('abcd'), edits: [edit(2, '', 'x'), edit(2, '', 'y')]
    }] });
    assert.equal(ambiguous.kind, 'failure');
    assert.equal(await f.read('source.txt'), 'abcd');
    const result = await f.invoke('edit_text', { files: [{
      path: 'source.txt', expectedSha256: digest('abcd'), edits: [edit(4, 'd', 'D'), edit(1, 'a', 'A')]
    }] });
    assert.equal(result.kind, 'result', result.summary);
    assert.equal(await f.read('source.txt'), 'AbcD');
  });

  test(`${backend}: patches validate every source before changing files and retain mutation evidence`, options, async (t) => {
    const f = await fixture(t, backend, { 'one.txt': 'one\n', 'two.txt': 'two\n' });
    const patch = '*** Begin Patch\n*** Update File: one.txt\n@@\n-one\n+changed\n*** Delete File: two.txt\n*** End Patch';
    const rejected = await f.invoke('apply_patch', { patch, expectedOldSha256: { 'two.txt': '0'.repeat(64) } });
    assert.equal(rejected.kind, 'failure');
    assert.equal(rejected.execution.state, 'not_started');
    assert.equal(await f.read('one.txt'), 'one\n');
    const unknown = await f.invoke('apply_patch', { patch, expectedOldSha256: { 'absent.txt': '0'.repeat(64) } });
    assert.equal(unknown.kind, 'failure');
    const denied = await f.invoke('apply_patch', { patch }, ['read', 'write']);
    assert.equal(denied.kind, 'failure');
    assert.equal(await f.read('two.txt'), 'two\n');
    const dry = await f.invoke('apply_patch', { patch, dryRun: true }, ['read']);
    assert.equal(dry.output.applicationStatus, 'dry_run');
    assert.ok(dry.observedFacts.items.every((fact) => fact.scope.actuality === 'predicted'));
    const applied = await f.invoke('apply_patch', { patch });
    assert.equal(applied.kind, 'result', applied.summary);
    assert.equal(applied.output.applicationStatus, 'applied');
    assert.equal(await f.read('one.txt'), 'changed\n');
    assert.deepEqual(applied.observedFacts.items.map((fact) => fact.action), ['update', 'delete']);
    assert.ok(applied.observedFacts.items.every((fact) => fact.scope.actuality === 'observed'));
  });
}

test('workspace range revision changes and lost transaction replies cannot become successful evidence', async () => {
  const f = workspaceTools({ 'source.txt': 'one\n' }, names);
  const read = f.files.readRange;
  f.files.readRange = async (...args) => {
    const result = await read(...args);
    return { ...result, revision: { ...result.revision, digest: '0'.repeat(64) } };
  };
  const changed = await f.invoke('read_files', { files: [{ path: 'source.txt' }] });
  assert.equal(changed.output.failures[0].reason, 'file_changed');
  assert.equal(changed.observedFacts.items[0].outcome, 'failure');
  f.files.readRange = read;
  f.files.transaction = async () => { throw new Error('Transaction reply unavailable'); };
  const failed = await f.invoke('apply_patch', { patch: '*** Begin Patch\n*** Update File: source.txt\n@@\n-one\n+two\n*** End Patch' });
  assert.equal(failed.kind, 'failure');
  assert.notEqual(failed.execution?.state, 'not_started');
  assert.equal(failed.observedFacts, undefined);
});

test('workspace dry runs reject missing transaction parents before claiming an applicable patch', async () => {
  const f = workspaceTools({}, names);
  const result = await f.invoke('apply_patch', {
    patch: '*** Begin Patch\n*** Add File: missing/child.txt\n+text\n*** End Patch', dryRun: true
  });
  assert.equal(result.kind, 'failure');
  assert.equal(result.execution.state, 'not_started');
  assert.match(result.summary, /existing directory/);
  assert.equal(f.transactions, 0);
});
