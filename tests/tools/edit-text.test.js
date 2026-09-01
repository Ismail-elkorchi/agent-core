import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createToolCall,
  planToolCall,
  recoverToolCallPlan,
  releaseToolCallPlan
} from '@agent-core/tools';
import { issueEffectStartTicket, NO_EFFECT_EXPOSURE, startExternalEffect } from '@agent-core/effects';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, editTextTool } from '@agent-core/tools-local';
import { invokePlannedForTest, invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';
import { testPatchJournal, testRootedFileAuthority } from '../rooted-file-authority-helper.js';

const policy = { allowedRisks: ['read', 'write'] };
let identity = 0;

function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function invocation() {
  identity += 1;
  return { runId: `run-${String(identity)}`, turnId: 'turn-1', requestAttempt: 1, toolBatchId: 'batch-1', callIndex: 0, toolAttempt: 1 };
}
async function editHost() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-edit-text-'));
  const rootedFileAuthority = testRootedFileAuthority(root);
  return {
    root,
    context: {
      policy,
      invocation: invocation(),
      services: {
        rootedFileAuthority,
        patchJournal: testPatchJournal(rootedFileAuthority),
        localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION
      }
    }
  };
}

test('edit_text applies ordered Unicode-scalar replacements across files in one transaction and preserves CRLF', async () => {
  const { root, context } = await editHost();
  const first = 'A 😀 value\r\nsecond line\r\n';
  const second = 'alpha beta gamma\n';
  await writeFile(path.join(root, 'first.txt'), first);
  await writeFile(path.join(root, 'second.txt'), second);
  const observation = await invokeToolCall(jsonToolCall('edit_text', { files: [
    {
      path: './first.txt', expectedSha256: sha(first), edits: [
        { range: { start: { line: 1, column: 3 }, end: { line: 1, column: 4 } }, expectedText: '😀', replacementText: 'bright' },
        { range: { start: { line: 2, column: 1 }, end: { line: 2, column: 7 } }, expectedText: 'second', replacementText: 'final' }
      ]
    },
    {
      path: 'second.txt', expectedSha256: sha(second), edits: [
        { range: { start: { line: 1, column: 7 }, end: { line: 1, column: 11 } }, expectedText: 'beta', replacementText: 'delta' }
      ]
    }
  ] }), [editTextTool], context);

  assert.equal(observation.ok, true);
  assert.equal(observation.output.applicationStatus, 'applied');
  assert.equal(observation.output.transactionOutcome, 'committed');
  assert.deepEqual(observation.output.changedPaths, ['first.txt', 'second.txt']);
  assert.equal(observation.output.files[0].newlineConvention, 'crlf');
  assert.equal(observation.output.files[0].changedRanges[0].expectedScalars, 1);
  assert.equal(await readFile(path.join(root, 'first.txt'), 'utf8'), 'A bright value\r\nfinal line\r\n');
  assert.equal(await readFile(path.join(root, 'second.txt'), 'utf8'), 'alpha delta gamma\n');
});

test('edit_text rejects stale hashes, mismatched expected text, overlaps, malformed UTF-8, symlinks, and hard links without mutation', async () => {
  const { root, context } = await editHost();
  await writeFile(path.join(root, 'plain.txt'), 'abcdef\n');
  await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0x66, 0x80]));
  await symlink('plain.txt', path.join(root, 'alias.txt'));
  await link(path.join(root, 'plain.txt'), path.join(root, 'linked.txt'));

  const cases = [
    { path: 'plain.txt', expectedSha256: '0'.repeat(64), edits: [{ range: range(1, 1, 1, 2), expectedText: 'a', replacementText: 'x' }] },
    { path: 'plain.txt', expectedSha256: sha('abcdef\n'), edits: [{ range: range(1, 1, 1, 2), expectedText: 'z', replacementText: 'x' }] },
    { path: 'plain.txt', expectedSha256: sha('abcdef\n'), edits: [
      { range: range(1, 1, 1, 4), expectedText: 'abc', replacementText: 'x' },
      { range: range(1, 3, 1, 5), expectedText: 'cd', replacementText: 'y' }
    ] },
    { path: 'invalid.txt', expectedSha256: sha(Buffer.from([0x66, 0x80])), edits: [{ range: range(1, 1, 1, 2), expectedText: 'f', replacementText: 'x' }] },
    { path: 'alias.txt', expectedSha256: sha('abcdef\n'), edits: [{ range: range(1, 1, 1, 2), expectedText: 'a', replacementText: 'x' }] },
    { path: 'linked.txt', expectedSha256: sha('abcdef\n'), edits: [{ range: range(1, 1, 1, 2), expectedText: 'a', replacementText: 'x' }] }
  ];
  for (const file of cases) {
    const observation = await invokeToolCall(jsonToolCall('edit_text', { files: [file] }), [editTextTool], { ...context, invocation: invocation() });
    assert.equal(observation.kind, 'failure', file.path);
    assert.equal(observation.output.reason, 'invalid_arguments', file.path);
  }
  assert.equal(await readFile(path.join(root, 'plain.txt'), 'utf8'), 'abcdef\n');
});

test('edit_text revalidates physical identity immediately before publication and rolls back the entire multi-file transaction', async () => {
  const { root, context } = await editHost();
  await writeFile(path.join(root, 'first.txt'), 'first old\n');
  await writeFile(path.join(root, 'second.txt'), 'second old\n');
  let replaced = false;
  const observation = await invokeToolCall(jsonToolCall('edit_text', { files: [
    { path: 'first.txt', expectedSha256: sha('first old\n'), edits: [{ range: range(1, 7, 1, 10), expectedText: 'old', replacementText: 'new' }] },
    { path: 'second.txt', expectedSha256: sha('second old\n'), edits: [{ range: range(1, 8, 1, 11), expectedText: 'old', replacementText: 'new' }] }
  ] }), [editTextTool], {
    ...context,
    async persistProgressCheckpoint(progress) {
      if (replaced || progress.stage !== 'text_edit_planned') return;
      replaced = true;
      await rename(path.join(root, 'second.txt'), path.join(root, 'second-original.txt'));
      await writeFile(path.join(root, 'second.txt'), 'replacement\n');
    }
  });
  assert.equal(replaced, true);
  assert.equal(observation.output.applicationStatus, 'not_applied');
  assert.equal(observation.output.transactionOutcome, 'rolled_back');
  assert.equal(await readFile(path.join(root, 'first.txt'), 'utf8'), 'first old\n');
  assert.equal(await readFile(path.join(root, 'second.txt'), 'utf8'), 'replacement\n');
  assert.equal(await readFile(path.join(root, 'second-original.txt'), 'utf8'), 'second old\n');
});

test('edit_text dry-run and abort-before-commit never mutate content', async () => {
  const { root, context } = await editHost();
  const original = 'before\n';
  await writeFile(path.join(root, 'note.txt'), original);
  const file = { path: 'note.txt', expectedSha256: sha(original), edits: [{ range: range(1, 1, 1, 7), expectedText: 'before', replacementText: 'after' }] };
  const dry = await invokeToolCall(jsonToolCall('edit_text', { files: [file], dryRun: true }), [editTextTool], { ...context, invocation: undefined, policy: { allowedRisks: ['read'] } });
  assert.equal(dry.output.applicationStatus, 'dry_run');
  assert.deepEqual(dry.output.changedPaths, []);
  assert.deepEqual(dry.output.wouldChangePaths, ['note.txt']);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), original);

  const controller = new AbortController();
  const aborted = invokeToolCall(jsonToolCall('edit_text', { files: [file] }), [editTextTool], {
    ...context,
    invocation: invocation(),
    signal: controller.signal,
    persistProgressCheckpoint(progress) { if (progress.stage === 'text_edit_planned') controller.abort('abort before text commit'); }
  });
  await assert.rejects(aborted, /abort before text commit|abort/iu);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), original);
});

test('edit_text reconciles a committed receipt idempotently without re-executing the mutation', async () => {
  const { root, context } = await editHost();
  const original = 'old value\n';
  await writeFile(path.join(root, 'note.txt'), original);
  const call = createToolCall(jsonToolCall('edit_text', { files: [{
    path: 'note.txt', expectedSha256: sha(original), edits: [{ range: range(1, 1, 1, 4), expectedText: 'old', replacementText: 'new' }]
  }] }));
  const planningContext = {
    ...context,
    signal: new AbortController().signal,
    boundary: { authorizationPolicyId: 'tests/edit-recovery@1', executionTargetId: root }
  };
  const first = await planToolCall(call, [editTextTool], planningContext);
  assert.equal(first.ok, true);
  const applied = await invokePlannedForTest(first.plan, planningContext);
  assert.equal(applied.output.applicationStatus, 'applied');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const plan = await planToolCall(call, [editTextTool], planningContext);
    assert.equal(plan.ok, true);
    const started = startedEffect(plan.plan, attempt);
    const recovered = await recoverToolCallPlan(plan.plan, started, planningContext);
    assert.equal(recovered.status, 'settled');
    assert.equal(recovered.observation.output.applicationStatus, 'applied');
    assert.deepEqual(recovered.observation.output.changedPaths, ['note.txt']);
    await releaseToolCallPlan(plan.plan);
  }
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'new value\n');
});

function range(startLine, startColumn, endLine, endColumn) {
  return { start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn } };
}
function startedEffect(plan, attempt) {
  const effectId = `edit-recovery-${String(attempt)}`;
  const issued = issueEffectStartTicket({
    intent: {
      effectId,
      ownerId: 'edit-recovery',
      implementationId: plan.toolImplementationId,
      parametersDigest: plan.fingerprint,
      recovery: plan.effects.recovery,
      exposure: NO_EFFECT_EXPOSURE
    },
    ticketId: `${effectId}-ticket`,
    settlementPermitId: `${effectId}-permit`,
    driverGeneration: 1,
    currentDriverGeneration: 1
  });
  assert.equal(issued.status, 'issued');
  const started = startExternalEffect(issued.state, issued.state.ticket, 1);
  assert.equal(started.status, 'started');
  return started.state;
}
