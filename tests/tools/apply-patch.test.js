import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { promises as realFs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyPatchTool, DEFAULT_LOCAL_TOOL_CONFIGURATION } from '@agent-core/tools-local';
import { commitTextFilePatchTransaction, recoverTextFilePatchTransactions } from '@agent-core/tools-local/testing/text-write';
import { invokeToolCall, textToolCall } from '../tool-call-helpers.js';

const policy = { allowedRisks: ['read', 'write', 'destructive'] };

function patch(lines) { return ['*** Begin Patch', ...lines, '*** End Patch'].join('\n'); }

test('apply_patch parses once into one canonical tree and applies add, update, move, and delete transactionally', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-'));
  await writeFile(path.join(root, 'update.txt'), 'old\n');
  await writeFile(path.join(root, 'move.txt'), 'move\n');
  await writeFile(path.join(root, 'delete.txt'), 'delete\n');
  const progress = [];
  const document = patch([
    '*** Add File: added.txt',
    '+added',
    '*** Update File: update.txt',
    '@@',
    '-old',
    '+new',
    '*** Update File: move.txt',
    '*** Move to: moved.txt',
    '@@',
    '-move',
    '+moved',
    '*** Delete File: delete.txt'
  ]);
  const observation = await invokeToolCall(textToolCall('apply_patch', document), [applyPatchTool], {
    policy,
    services: { workspaceRoot: root },
    emitProgress(item) { progress.push(item); }
  });
  assert.equal(observation.ok, true);
  assert.equal(observation.output.transactional, true);
  assert.deepEqual([...observation.output.changedPaths].sort(), ['added.txt', 'delete.txt', 'move.txt', 'moved.txt', 'update.txt']);
  assert.equal(await readFile(path.join(root, 'added.txt'), 'utf8'), 'added\n');
  assert.equal(await readFile(path.join(root, 'update.txt'), 'utf8'), 'new\n');
  assert.equal(await readFile(path.join(root, 'moved.txt'), 'utf8'), 'moved\n');
  await assert.rejects(readFile(path.join(root, 'move.txt')));
  await assert.rejects(readFile(path.join(root, 'delete.txt')));
  assert.deepEqual([...new Set(progress.map((item) => item.stage))], ['patch_parsing', 'patch_parsed', 'patch_preparing', 'patch_prepared', 'patch_committing', 'patch_committed']);
});

test('apply_patch enforces raw SHA-256 preconditions and keeps dry runs non-mutating', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-sha-'));
  const original = Buffer.from('old\r\n');
  await writeFile(path.join(root, 'note.txt'), original);
  const document = patch(['*** Update File: note.txt', '@@', '-old', '+new']);
  const wrong = await invokeToolCall({ name: 'apply_patch', input: { kind: 'json', value: { patch: document, expectedOldSha256: { 'note.txt': '0'.repeat(64) } } } }, [applyPatchTool], {
    policy, services: { workspaceRoot: root }
  });
  assert.equal(wrong.kind, 'failure');
  assert.match(wrong.summary, /SHA-256|sha256/iu);
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);

  const expected = createHash('sha256').update(original).digest('hex');
  const dryRun = await invokeToolCall({ name: 'apply_patch', input: { kind: 'json', value: { patch: document, dryRun: true, expectedOldSha256: { 'note.txt': expected } } } }, [applyPatchTool], {
    policy, services: { workspaceRoot: root }
  });
  assert.equal(dryRun.ok, true);
  assert.deepEqual(dryRun.output.changedPaths, []);
  assert.deepEqual(dryRun.output.wouldChangePaths, ['note.txt']);
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});

test('apply_patch dry runs require only read access and do not create transaction state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-read-only-'));
  await writeFile(path.join(root, 'note.txt'), 'old\n');
  const document = patch(['*** Update File: note.txt', '@@', '-old', '+new']);
  const observation = await invokeToolCall({ name: 'apply_patch', input: { kind: 'json', value: { patch: document, dryRun: true } } }, [applyPatchTool], {
    policy: { allowedRisks: ['read'] }, services: { workspaceRoot: root }
  });
  assert.equal(observation.ok, true);
  assert.equal(observation.output.dryRun, true);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'old\n');
  await assert.rejects(readdir(path.join(root, '.agent-core')), /ENOENT/u);
});

test('apply_patch reports parser and matching diagnostics without mutating files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-diagnostics-'));
  await writeFile(path.join(root, 'note.txt'), 'section one\r\nvalue   \r\nsection two\r\nvalue\t\r\n');

  const malformed = await invokeToolCall(textToolCall('apply_patch', 'not a patch'), [applyPatchTool], {
    policy, services: { workspaceRoot: root }
  });
  assert.equal(malformed.kind, 'failure');
  assert.equal(malformed.output.reason, 'invalid_arguments');
  assert.equal(malformed.output.details.failures[0].reason, 'patch_parse_error');
  assert.match(malformed.output.details.failures[0].nextAction, /Begin Patch/u);

  const contextOnly = await invokeToolCall(textToolCall('apply_patch', patch([
    '*** Update File: note.txt',
    '@@',
    ' section one'
  ])), [applyPatchTool], { policy, services: { workspaceRoot: root } });
  assert.equal(contextOnly.kind, 'failure');
  assert.equal(contextOnly.output.details.failures[0].hunkIndex, 0);
  assert.match(contextOnly.output.details.failures[0].nextAction, /at least one \+ or - line/u);

  const ambiguous = await invokeToolCall(textToolCall('apply_patch', patch([
    '*** Update File: note.txt',
    '@@',
    '-value',
    '+VALUE'
  ])), [applyPatchTool], { policy, services: { workspaceRoot: root } });
  assert.equal(ambiguous.kind, 'failure');
  assert.equal(ambiguous.output.details.failures[0].reason, 'ambiguous_context');
  assert.deepEqual(ambiguous.output.details.failures[0].candidateLines, [2, 4]);

  const narrowed = await invokeToolCall({
    name: 'apply_patch',
    input: { kind: 'json', value: { dryRun: true, patch: patch([
      '*** Update File: note.txt',
      '@@ section two',
      '-value',
      '+VALUE',
      '*** End of File'
    ]) } }
  }, [applyPatchTool], { policy, services: { workspaceRoot: root } });
  assert.equal(narrowed.ok, true);
  assert.deepEqual(narrowed.output.files[0].matchModes, ['trim_trailing_whitespace']);
  assert.equal(narrowed.output.files[0].exact, false);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'section one\r\nvalue   \r\nsection two\r\nvalue\t\r\n');
});

test('apply_patch rejects invalid targets atomically under host limits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-invalid-'));
  await writeFile(path.join(root, 'good.txt'), 'hello\nworld\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(256));
  await mkdir(path.join(root, 'directory'));
  const localToolConfiguration = {
    ...DEFAULT_LOCAL_TOOL_CONFIGURATION,
    applyPatch: { ...DEFAULT_LOCAL_TOOL_CONFIGURATION.applyPatch, maxFileBytes: 128, maxNewBytesPerFile: 128 }
  };
  const document = patch([
    '*** Update File: good.txt',
    '@@',
    '-hello',
    '+HELLO',
    '*** Update File: missing.txt',
    '@@',
    '-old',
    '+new',
    '*** Update File: directory',
    '@@',
    '-old',
    '+new',
    '*** Update File: binary.bin',
    '@@',
    '-old',
    '+new',
    '*** Update File: large.txt',
    '@@',
    '-old',
    '+new',
    '*** Add File: good.txt',
    '+duplicate'
  ]);
  const observation = await invokeToolCall(textToolCall('apply_patch', document), [applyPatchTool], {
    policy, services: { workspaceRoot: root, localToolConfiguration }
  });
  assert.equal(observation.kind, 'failure');
  assert.deepEqual(
    observation.output.details.failures.map((failure) => failure.reason).sort(),
    ['already_exists', 'binary', 'not_file', 'not_found', 'too_large']
  );
  assert.equal(await readFile(path.join(root, 'good.txt'), 'utf8'), 'hello\nworld\n');
});

test('patch transactions preserve modes, roll back atomically, and recover interrupted rollback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-transaction-'));
  const journalDirectory = path.join(root, '.journal');
  const firstPath = path.join(root, 'first.txt');
  const secondPath = path.join(root, 'second.txt');
  await writeFile(firstPath, 'old first\n');
  await writeFile(secondPath, 'old second\n');
  await chmod(firstPath, 0o744);
  const mode = (await stat(firstPath)).mode;

  const committed = await commitTextFilePatchTransaction(root, {
    writes: [{ path: 'first.txt', absolutePath: firstPath, content: 'mode preserved\n', mode, overwrite: true }],
    removes: []
  }, { journalDirectory });
  assert.equal(committed.outcome, 'committed');
  assert.equal((await stat(firstPath)).mode & 0o777, 0o744);

  await writeFile(firstPath, 'old first\n');
  const fileSystem = {
    ...realFs,
    async rename(source, destination) {
      const sourceName = path.basename(String(source));
      if (sourceName === 'write-1.tmp') throw new Error('injected second write failure');
      if (sourceName === 'backup-write-0' && String(destination) === firstPath) throw new Error('injected rollback interruption');
      return realFs.rename(source, destination);
    }
  };
  const interrupted = await commitTextFilePatchTransaction(root, {
    writes: [
      { path: 'first.txt', absolutePath: firstPath, content: 'new first\n', overwrite: true },
      { path: 'second.txt', absolutePath: secondPath, content: 'new second\n', overwrite: true }
    ],
    removes: []
  }, { fileSystem, journalDirectory, transactionId: 'interrupted' });
  assert.equal(interrupted.outcome, 'rollback_failed');
  assert.equal(interrupted.rollback.status, 'failed');
  await assert.rejects(readFile(firstPath), /ENOENT/u);
  assert.equal(await readFile(secondPath, 'utf8'), 'old second\n');

  await recoverTextFilePatchTransactions(root, journalDirectory);
  assert.equal(await readFile(firstPath, 'utf8'), 'old first\n');
  assert.equal(await readFile(secondPath, 'utf8'), 'old second\n');
  assert.deepEqual(await readdir(journalDirectory), []);
});

test('patch journals recover an interrupted process before another transaction runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-crash-'));
  await writeFile(path.join(root, 'note.txt'), 'before\n');
  const fixture = path.resolve('tests/fixtures/patch-crash.mjs');
  const child = spawnSync(process.execPath, [fixture, root], { encoding: 'utf8' });
  assert.equal(child.status, 42, child.stderr);
  const journalDirectory = path.join(root, '.agent-core', 'transactions', 'patch');
  await recoverTextFilePatchTransactions(root, journalDirectory);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'before\n');
  assert.deepEqual(await readdir(journalDirectory), []);
});

test('patch commit revalidates every hash and absent destination before mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-precondition-'));
  const journalDirectory = path.join(root, '.agent-core', 'transactions', 'patch');
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination.txt');
  await writeFile(source, 'initial\n');
  const initialSha = createHash('sha256').update('initial\n').digest('hex');
  await writeFile(source, 'external\n');
  const changed = await commitTextFilePatchTransaction(root, {
    writes: [{ path: 'source.txt', absolutePath: source, content: 'patched\n', overwrite: true, expectedCurrentSha256: initialSha }], removes: []
  }, { journalDirectory });
  assert.equal(changed.outcome, 'rolled_back');
  assert.equal(await readFile(source, 'utf8'), 'external\n');

  await writeFile(destination, 'external destination\n');
  const appeared = await commitTextFilePatchTransaction(root, {
    writes: [{ path: 'destination.txt', absolutePath: destination, content: 'patched\n', overwrite: false, expectedAbsent: true }], removes: []
  }, { journalDirectory });
  assert.equal(appeared.outcome, 'rolled_back');
  assert.equal(await readFile(destination, 'utf8'), 'external destination\n');
});

test('one journal lock serializes same-process patches on different and identical files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-concurrent-'));
  const journalDirectory = path.join(root, '.agent-core', 'transactions', 'patch');
  await writeFile(path.join(root, 'a.txt'), 'a0\n');
  await writeFile(path.join(root, 'b.txt'), 'b0\n');
  const shaA = createHash('sha256').update('a0\n').digest('hex');
  const shaB = createHash('sha256').update('b0\n').digest('hex');
  const transaction = (file, content, expectedCurrentSha256) => ({ writes: [{ path: file, absolutePath: path.join(root, file), content, overwrite: true, expectedCurrentSha256 }], removes: [] });
  const distinct = await Promise.all([
    commitTextFilePatchTransaction(root, transaction('a.txt', 'a1\n', shaA), { journalDirectory }),
    commitTextFilePatchTransaction(root, transaction('b.txt', 'b1\n', shaB), { journalDirectory })
  ]);
  assert.deepEqual(distinct.map((item) => item.outcome), ['committed', 'committed']);

  const currentSha = createHash('sha256').update('a1\n').digest('hex');
  const same = await Promise.all([
    commitTextFilePatchTransaction(root, transaction('a.txt', 'first\n', currentSha), { journalDirectory }),
    commitTextFilePatchTransaction(root, transaction('a.txt', 'second\n', currentSha), { journalDirectory })
  ]);
  assert.equal(same.filter((item) => item.outcome === 'committed').length, 1);
  assert.equal(same.filter((item) => item.outcome === 'rolled_back').length, 1);
});

test('the patch journal lock isolates separate Agent Core processes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-interprocess-'));
  const journalDirectory = path.join(root, '.agent-core', 'transactions', 'patch');
  await writeFile(path.join(root, 'shared.txt'), 'base\n');
  const expected = createHash('sha256').update('base\n').digest('hex');
  const fixture = path.resolve('tests/fixtures/patch-concurrency.mjs');
  const results = await Promise.all([
    runPatchChild(fixture, [root, journalDirectory, 'shared.txt', expected, 'one\n']),
    runPatchChild(fixture, [root, journalDirectory, 'shared.txt', expected, 'two\n'])
  ]);
  assert.equal(results.filter((item) => item.outcome === 'committed').length, 1);
  assert.equal(results.filter((item) => item.outcome === 'rolled_back').length, 1);
});

function runPatchChild(fixture, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => { stdout += value; }); child.stderr.on('data', (value) => { stderr += value; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `child exited ${String(code)}`)));
  });
}
