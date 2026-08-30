import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolCall, prepareToolCall } from '@agent-core/tools';
import { applyPatchTool, DEFAULT_LOCAL_TOOL_CONFIGURATION, TextPatchJournal } from '@agent-core/tools-local';
import { applyPatchWithAuthority } from '@agent-core/tools-local/testing/apply-patch';
import { commitTextFilePatchTransaction, recoverTextFilePatchTransactions } from '@agent-core/tools-local/testing/text-write';
import { invokePreparedForTest, invokeToolCall, textToolCall } from '../tool-call-helpers.js';
import { testPatchJournal, testRootedFileAuthority } from '../rooted-file-authority-helper.js';

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
    services: { rootedFileAuthority: testRootedFileAuthority(root) },
    emitProgress(item) { progress.push(item); }
  });
  assert.equal(observation.ok, true);
  assert.equal(observation.output.operationStatus, 'applied');
  assert.equal(observation.output.transactionOutcome, 'committed');
  assert.deepEqual([...observation.output.changedPaths].sort(), ['added.txt', 'delete.txt', 'move.txt', 'moved.txt', 'update.txt']);
  assert.equal(await readFile(path.join(root, 'added.txt'), 'utf8'), 'added\n');
  assert.equal(await readFile(path.join(root, 'update.txt'), 'utf8'), 'new\n');
  assert.equal(await readFile(path.join(root, 'moved.txt'), 'utf8'), 'moved\n');
  await assert.rejects(readFile(path.join(root, 'move.txt')));
  await assert.rejects(readFile(path.join(root, 'delete.txt')));
  assert.deepEqual([...new Set(progress.map((item) => item.stage))], ['patch_parsing', 'patch_parsed', 'patch_preparing', 'patch_prepared', 'patch_committing', 'patch_committed']);
});

test('tool policy denies destructive patches without destructive authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-no-apply-'));
  await writeFile(path.join(root, 'delete.txt'), 'delete\n');
  const observation = await invokeToolCall(textToolCall('apply_patch', patch(['*** Delete File: delete.txt'])), [applyPatchTool], {
    policy: { allowedRisks: ['read'] }, services: { rootedFileAuthority: testRootedFileAuthority(root) }
  });
  assert.equal(observation.kind, 'failure');
  assert.equal(observation.output.reason, 'policy');
  assert.match(observation.output.recovery, /delete|destructive/iu);
  assert.equal(await readFile(path.join(root, 'delete.txt'), 'utf8'), 'delete\n');
});

test('apply_patch enforces raw SHA-256 preconditions and keeps dry runs non-mutating', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-sha-'));
  const original = Buffer.from('old\r\n');
  await writeFile(path.join(root, 'note.txt'), original);
  const document = patch(['*** Update File: note.txt', '@@', '-old', '+new']);
  const wrong = await invokeToolCall({ name: 'apply_patch', input: { kind: 'json', value: { patch: document, expectedOldSha256: { 'note.txt': '0'.repeat(64) } } } }, [applyPatchTool], {
    policy, services: { rootedFileAuthority: testRootedFileAuthority(root) }
  });
  assert.equal(wrong.kind, 'failure');
  assert.match(wrong.summary, /SHA-256|sha256/iu);
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);

  const expected = createHash('sha256').update(original).digest('hex');
  const dryRun = await invokeToolCall({ name: 'apply_patch', input: { kind: 'json', value: { patch: document, dryRun: true, expectedOldSha256: { 'note.txt': expected } } } }, [applyPatchTool], {
    policy, services: { rootedFileAuthority: testRootedFileAuthority(root) }
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.output.operationStatus, 'dry_run');
  assert.equal(dryRun.output.transactionOutcome, undefined);
  assert.equal(dryRun.output.files[0].plannedChange, true);
  assert.equal(dryRun.output.files[0].finalState, 'unchanged');
  assert.deepEqual(dryRun.output.changedPaths, []);
  assert.deepEqual(dryRun.output.wouldChangePaths, ['note.txt']);
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});

test('apply_patch preserves all four transaction outcome semantics', async () => {
  const outcomes = [
    { outcome: 'committed', cleanup: { status: 'succeeded', diagnostics: [], strandedPaths: [] } },
    { outcome: 'committed_with_residue', cleanup: { status: 'failed', diagnostics: [{ operation: 'remove_patch_journal', path: '.agent-core/transactions/patch/tx', message: 'busy' }], strandedPaths: ['.agent-core/transactions/patch/tx'] } },
    { outcome: 'rolled_back', failure: { operation: 'commit_write', path: 'note.txt', message: 'write failed' }, rollback: { status: 'succeeded', diagnostics: [], strandedPaths: [] } },
    { outcome: 'rollback_failed', failure: { operation: 'commit_write', path: 'note.txt', message: 'write failed' }, rollback: { status: 'uncertain', diagnostics: [{ operation: 'restore_backup', path: 'note.txt', message: 'restore failed' }], strandedPaths: ['note.txt'] } }
  ];
  for (const transaction of outcomes) {
    const root = await mkdtemp(path.join(tmpdir(), `agent-core-patch-${transaction.outcome}-`));
    await writeFile(path.join(root, 'note.txt'), 'old\n');
    const context = {
      policy,
      boundary: { authorizationPolicyId: 'tests/patch-status@1', executionTargetId: root },
      signal: new AbortController().signal,
      services: { rootedFileAuthority: testRootedFileAuthority(root), localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION }
    };
    const preparation = await prepareToolCall(textToolCall('apply_patch', patch(['*** Update File: note.txt', '@@', '-old', '+new'])), [applyPatchTool], context);
    assert.equal(preparation.ok, true);
    const observation = await applyPatchWithAuthority(preparation.prepared.canonicalSnapshot, context, { async commit() { return transaction; } });
    assert.equal(observation.kind, 'result');
    assert.equal(observation.output.transactionOutcome, transaction.outcome);
    assert.equal(observation.output.operationStatus, transaction.outcome === 'committed' || transaction.outcome === 'committed_with_residue'
      ? 'applied' : transaction.outcome === 'rolled_back' ? 'not_applied' : 'uncertain');
    assert.deepEqual(observation.output.wouldChangePaths, ['note.txt']);
    if (transaction.outcome === 'committed' || transaction.outcome === 'committed_with_residue') {
      assert.equal(observation.ok, true);
      assert.deepEqual(observation.output.changedPaths, ['note.txt']);
      assert.equal(observation.output.files[0].finalState, 'changed');
      assert.equal(observation.evidence.items[0].scope.confidence, 'verified');
    } else {
      assert.equal(observation.ok, false);
      assert.deepEqual(observation.output.changedPaths, []);
      assert.equal(observation.output.files[0].finalState, transaction.outcome === 'rolled_back' ? 'unchanged' : 'uncertain');
    }
    if (transaction.outcome === 'committed_with_residue') {
      assert.equal(observation.scope.coverage, 'partial');
      assert.equal(observation.scope.causes.includes('journal_residue'), true);
      assert.equal(observation.scope.resources.includes('files/note.txt'), true);
      assert.match(observation.summary, /contents were committed/iu);
    }
    if (transaction.outcome === 'rolled_back') {
      assert.equal(observation.scope.coverage, 'complete');
      assert.equal(observation.output.rootState, 'known');
      assert.match(observation.summary, /no requested file changes remain/iu);
    }
    if (transaction.outcome === 'rollback_failed') {
      assert.equal(observation.scope.coverage, 'partial');
      assert.equal(observation.output.rootState, 'uncertain');
      assert.deepEqual(observation.output.potentiallyAffectedPaths, ['note.txt']);
      assert.equal(observation.evidence.items[0].scope.confidence, 'unverified');
    }
  }
});

test('apply_patch reports no-op without a transaction outcome', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-noop-'));
  await writeFile(path.join(root, 'note.txt'), 'same\n');
  const result = await invokeToolCall(textToolCall('apply_patch', patch(['*** Update File: note.txt', '@@', '-same', '+same'])), [applyPatchTool], {
    policy, services: { rootedFileAuthority: testRootedFileAuthority(root) }
  });
  assert.equal(result.kind, 'result');
  assert.equal(result.output.operationStatus, 'no_change');
  assert.equal(result.output.transactionOutcome, undefined);
  assert.equal(result.output.files[0].plannedChange, false);
  assert.equal(result.output.files[0].finalState, 'unchanged');
});

test('apply_patch dynamically requires a transaction directory only for writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-services-'));
  await writeFile(path.join(root, 'note.txt'), 'old\n');
  const base = {
    policy,
    boundary: { authorizationPolicyId: 'tests/patch-services@1', executionTargetId: root },
    signal: new AbortController().signal,
    services: { rootedFileAuthority: testRootedFileAuthority(root), localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION }
  };
  const document = patch(['*** Update File: note.txt', '@@', '-old', '+new']);
  const dryPreparation = await prepareToolCall(createToolCall({ name: 'apply_patch', input: { kind: 'json', value: { patch: document, dryRun: true } } }), [applyPatchTool], base);
  assert.equal(dryPreparation.ok, true);
  const dry = await invokePreparedForTest(dryPreparation.prepared, base);
  assert.equal(dry.output.operationStatus, 'dry_run');

  const writePreparation = await prepareToolCall(textToolCall('apply_patch', document), [applyPatchTool], base);
  assert.equal(writePreparation.ok, true);
  const missing = await invokePreparedForTest(writePreparation.prepared, base);
  assert.equal(missing.kind, 'failure');
  assert.match(missing.summary, /patchJournal/u);

  const withDirectory = { ...base, services: { ...base.services, patchJournal: testPatchJournal(base.services.rootedFileAuthority) } };
  const appliedPreparation = await prepareToolCall(textToolCall('apply_patch', document), [applyPatchTool], base);
  assert.equal(appliedPreparation.ok, true);
  const applied = await invokePreparedForTest(appliedPreparation.prepared, withDirectory);
  assert.equal(applied.output.operationStatus, 'applied');
  assert.deepEqual(applyPatchTool.requirements.services, ['rootedFileAuthority', 'localToolConfiguration']);
});

test('apply_patch dry runs require only read access and do not create transaction state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-read-only-'));
  await writeFile(path.join(root, 'note.txt'), 'old\n');
  const document = patch(['*** Update File: note.txt', '@@', '-old', '+new']);
  const observation = await invokeToolCall({ name: 'apply_patch', input: { kind: 'json', value: { patch: document, dryRun: true } } }, [applyPatchTool], {
    policy: { allowedRisks: ['read'] }, services: { rootedFileAuthority: testRootedFileAuthority(root) }
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
    policy, services: { rootedFileAuthority: testRootedFileAuthority(root) }
  });
  assert.equal(malformed.kind, 'failure');
  assert.equal(malformed.output.reason, 'invalid_arguments');
  assert.equal(malformed.output.details.failures[0].reason, 'patch_parse_error');
  assert.match(malformed.output.details.failures[0].nextAction, /Begin Patch/u);

  const contextOnly = await invokeToolCall(textToolCall('apply_patch', patch([
    '*** Update File: note.txt',
    '@@',
    ' section one'
  ])), [applyPatchTool], { policy, services: { rootedFileAuthority: testRootedFileAuthority(root) } });
  assert.equal(contextOnly.kind, 'failure');
  assert.equal(contextOnly.output.details.failures[0].hunkIndex, 0);
  assert.match(contextOnly.output.details.failures[0].nextAction, /at least one \+ or - line/u);

  const ambiguous = await invokeToolCall(textToolCall('apply_patch', patch([
    '*** Update File: note.txt',
    '@@',
    '-value',
    '+VALUE'
  ])), [applyPatchTool], { policy, services: { rootedFileAuthority: testRootedFileAuthority(root) } });
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
  }, [applyPatchTool], { policy, services: { rootedFileAuthority: testRootedFileAuthority(root) } });
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
    policy, services: { rootedFileAuthority: testRootedFileAuthority(root), localToolConfiguration }
  });
  assert.equal(observation.kind, 'failure');
  assert.deepEqual(
    observation.output.details.failures.map((failure) => failure.reason).sort(),
    ['already_exists', 'binary', 'not_file', 'not_found', 'too_large']
  );
  assert.equal(await readFile(path.join(root, 'good.txt'), 'utf8'), 'hello\nworld\n');
});

test('patch transactions preserve requested modes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-transaction-'));
  const journalDirectory = path.join(root, '.journal');
  const firstPath = path.join(root, 'first.txt');
  const secondPath = path.join(root, 'second.txt');
  await writeFile(firstPath, 'old first\n');
  await writeFile(secondPath, 'old second\n');
  await chmod(firstPath, 0o744);
  const mode = (await stat(firstPath)).mode;
  const rootedFileAuthority = testRootedFileAuthority(root);
  const journal = testPatchJournal(rootedFileAuthority);
  const firstIdentity = await rootedFileAuthority.fileIdentity('first.txt');

  const committed = await commitTextFilePatchTransaction(rootedFileAuthority, journal, {
    writes: [{ path: 'first.txt', content: 'mode preserved\n', mode, overwrite: true, expectedCurrentSha256: createHash('sha256').update('old first\n').digest('hex'), expectedCurrentIdentity: firstIdentity }],
    removes: []
  });
  assert.equal(committed.outcome, 'committed');
  assert.equal((await stat(firstPath)).mode & 0o777, mode & 0o777);
});

test('patch journals recover an interrupted process before another transaction runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-crash-'));
  await writeFile(path.join(root, 'note.txt'), 'before\n');
  const fixture = path.resolve('tests/fixtures/patch-crash.mjs');
  const child = spawnSync(process.execPath, [fixture, root], { encoding: 'utf8' });
  assert.equal(child.status, 42, child.stderr);
  const journalDirectory = path.join(root, '.agent-core', 'transactions', 'patch');
  const rootedFileAuthority = testRootedFileAuthority(root);
  const journal = TextPatchJournal.adopt(journalDirectory);
  await recoverTextFilePatchTransactions(rootedFileAuthority, journal);
  journal.close();
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'before\n');
  assert.deepEqual(await readdir(journalDirectory), []);
});

test('patch recovery preserves directories and files that its journal cannot prove it owns', async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-unproven-root-'));
  const journalPath = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-unproven-journal-'));
  await mkdir(path.join(rootPath, 'external-empty'));
  const root = testRootedFileAuthority(rootPath);

  const unprovenId = 'unproven-directory';
  const unprovenDirectory = path.join(journalPath, unprovenId);
  await mkdir(unprovenDirectory);
  await writeJournalEnvelope(path.join(unprovenDirectory, 'transaction.json'), {
    version: 1, transactionId: unprovenId, transactionDigest: '1'.repeat(64), phase: 'prepared',
    createdDirectories: [{ path: 'external-empty' }], writes: [], removes: []
  });
  const journal = TextPatchJournal.adopt(journalPath);
  await assert.rejects(recoverTextFilePatchTransactions(root, journal), /cannot prove ownership|uncertain/iu);
  assert.equal((await stat(path.join(rootPath, 'external-empty'))).isDirectory(), true);
  assert.equal((await stat(unprovenDirectory)).isDirectory(), true);
  journal.close();

  const corruptJournalPath = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-corrupt-journal-'));
  const corruptId = 'corrupt-cleanup';
  const corruptDirectory = path.join(corruptJournalPath, corruptId);
  await mkdir(corruptDirectory);
  await writeFile(path.join(rootPath, 'victim.txt'), 'keep\n');
  await writeJournalEnvelope(path.join(corruptDirectory, 'transaction.json'), {
    version: 1, transactionId: corruptId, transactionDigest: '2'.repeat(64), phase: 'committed', createdDirectories: [],
    writes: [{ path: 'target.txt', stageName: 'victim.txt', newSha256: createHash('sha256').update('x').digest('hex'), mode: 0o600, overwrite: false, expectedAbsent: true }],
    removes: []
  });
  const corruptJournal = TextPatchJournal.adopt(corruptJournalPath);
  await assert.rejects(recoverTextFilePatchTransactions(root, corruptJournal), /invalid patch stage/iu);
  assert.equal(await readFile(path.join(rootPath, 'victim.txt'), 'utf8'), 'keep\n');
  corruptJournal.close();

  const checksumJournalPath = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-checksum-journal-'));
  const checksumId = 'checksum-failure';
  const checksumDirectory = path.join(checksumJournalPath, checksumId);
  await mkdir(checksumDirectory);
  const checksumManifest = { version: 1, transactionId: checksumId, transactionDigest: '3'.repeat(64), phase: 'prepared', createdDirectories: [], writes: [], removes: [] };
  await writeFile(path.join(checksumDirectory, 'transaction.json'), JSON.stringify({ version: 1, payload: checksumManifest, sha256: '0'.repeat(64) }), { mode: 0o600 });
  const checksumJournal = TextPatchJournal.adopt(checksumJournalPath);
  await assert.rejects(recoverTextFilePatchTransactions(root, checksumJournal), /checksum failed/iu);
  assert.equal((await stat(checksumDirectory)).isDirectory(), true);
  checksumJournal.close();
});

test('an adopted patch journal keeps its physical directory after its display path is replaced', async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-journal-root-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-journal-parent-'));
  const journalPath = path.join(parent, 'journal');
  const movedJournalPath = path.join(parent, 'journal-original');
  await mkdir(journalPath);
  await writeFile(path.join(rootPath, 'value.txt'), 'before\n');
  const root = testRootedFileAuthority(rootPath);
  const identity = await root.fileIdentity('value.txt');
  const journal = TextPatchJournal.adopt(journalPath);
  await rename(journalPath, movedJournalPath);
  await mkdir(journalPath);
  const result = await commitTextFilePatchTransaction(root, journal, {
    writes: [{ path: 'value.txt', content: 'after\n', overwrite: true, expectedCurrentSha256: createHash('sha256').update('before\n').digest('hex'), expectedCurrentIdentity: identity }],
    removes: []
  });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(await readdir(journalPath), []);
  assert.deepEqual(await readdir(movedJournalPath), []);
  journal.close();
});

test('patch journal operation authority expires when its callback returns', async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-authority-root-'));
  const journalPath = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-authority-journal-'));
  const root = testRootedFileAuthority(rootPath);
  const journal = TextPatchJournal.adopt(journalPath);
  if (process.platform !== 'win32') assert.equal((await stat(journalPath)).mode & 0o777, 0o700);
  let retained;
  await journal.withAuthority(root, async (authority) => { retained = authority; });
  await assert.rejects(retained.commit({ writes: [], removes: [] }), /expired/iu);
  journal.close();
});

test('a hostile parent swap cannot redirect a structured mutation outside the adopted root', { skip: process.platform !== 'linux' }, async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-race-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-race-outside-'));
  await mkdir(path.join(rootPath, 'branch'));
  await writeFile(path.join(rootPath, 'branch', 'value.txt'), 'inside\n');
  await writeFile(path.join(outside, 'value.txt'), 'outside-secret\n');
  const fixture = path.resolve('tests/fixtures/hostile-path-swap.mjs');
  const child = spawn(process.execPath, [fixture, rootPath, outside], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Hostile fixture exited early: ${String(code)}`)));
  });
  const rootedFileAuthority = testRootedFileAuthority(rootPath);
  try {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        await invokeToolCall(textToolCall('apply_patch', patch([
          `*** Add File: branch/new-${String(attempt)}.txt`,
          '+inside'
        ])), [applyPatchTool], {
          policy,
          services: { rootedFileAuthority, localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION }
        });
      } catch { /* A concurrent alias or missing parent is an admitted conflict. */ }
    }
    assert.deepEqual((await readdir(outside)).sort(), ['value.txt']);
    assert.equal(await readFile(path.join(outside, 'value.txt'), 'utf8'), 'outside-secret\n');
  } finally {
    child.kill('SIGKILL'); await new Promise((resolve) => child.once('close', resolve));
  }
});

test('patch commit revalidates every hash and absent destination before mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-precondition-'));
  const journalDirectory = path.join(root, '.agent-core', 'transactions', 'patch');
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination.txt');
  await writeFile(source, 'initial\n');
  const initialSha = createHash('sha256').update('initial\n').digest('hex');
  const rootedFileAuthority = testRootedFileAuthority(root); const journal = testPatchJournal(rootedFileAuthority);
  const initialIdentity = await rootedFileAuthority.fileIdentity('source.txt');
  await writeFile(source, 'external\n');
  const changed = await commitTextFilePatchTransaction(rootedFileAuthority, journal, {
    writes: [{ path: 'source.txt', content: 'patched\n', overwrite: true, expectedCurrentSha256: initialSha, expectedCurrentIdentity: initialIdentity }], removes: []
  });
  assert.equal(changed.outcome, 'rolled_back');
  assert.equal(await readFile(source, 'utf8'), 'external\n');

  await writeFile(destination, 'external destination\n');
  const appeared = await commitTextFilePatchTransaction(rootedFileAuthority, journal, {
    writes: [{ path: 'destination.txt', content: 'patched\n', overwrite: false, expectedAbsent: true }], removes: []
  });
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
  const rootedFileAuthority = testRootedFileAuthority(root); const journal = testPatchJournal(rootedFileAuthority);
  const transaction = async (file, content, expectedCurrentSha256) => ({
    writes: [{ path: file, content, overwrite: true, expectedCurrentSha256, expectedCurrentIdentity: await rootedFileAuthority.fileIdentity(file) }], removes: []
  });
  const distinct = await Promise.all([
    transaction('a.txt', 'a1\n', shaA).then((value) => commitTextFilePatchTransaction(rootedFileAuthority, journal, value)),
    transaction('b.txt', 'b1\n', shaB).then((value) => commitTextFilePatchTransaction(rootedFileAuthority, journal, value))
  ]);
  assert.deepEqual(distinct.map((item) => item.outcome), ['committed', 'committed']);

  const currentSha = createHash('sha256').update('a1\n').digest('hex');
  const firstSame = await transaction('a.txt', 'first\n', currentSha);
  const secondSame = await transaction('a.txt', 'second\n', currentSha);
  const same = await Promise.all([
    commitTextFilePatchTransaction(rootedFileAuthority, journal, firstSame),
    commitTextFilePatchTransaction(rootedFileAuthority, journal, secondSame)
  ]);
  assert.equal(same.filter((item) => item.outcome === 'committed').length, 1);
  assert.equal(same.filter((item) => item.outcome === 'rolled_back').length, 1);
});

test('the patch journal lock isolates separate Agent Core processes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-patch-interprocess-'));
  const journalDirectory = path.join(root, '.agent-core', 'transactions', 'patch');
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
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

async function writeJournalEnvelope(filePath, manifest) {
  const payload = JSON.stringify(manifest);
  await writeFile(filePath, JSON.stringify({ version: 1, payload: manifest, sha256: createHash('sha256').update(payload).digest('hex') }), { mode: 0o600 });
}
