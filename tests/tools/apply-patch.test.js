import test from 'node:test';
import { invokeToolCall, jsonToolCall, presentToolObservation, textToolCall } from '../tool-call-helpers.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { promises as realFs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Text } from '@agent-core/tools-local/testing/filesystem';
import { commitTextFilePatchTransaction, recoverTextFilePatchTransactions } from '@agent-core/tools-local/testing/text-write';
import { applyPatchUpdate } from '@agent-core/tools-local/testing/apply-patch/apply-diff';
import { APPLY_PATCH_LARK_GRAMMAR } from '@agent-core/tools-local/testing/apply-patch/grammar';
import { parseApplyPatch } from '@agent-core/tools-local/testing/apply-patch/patch-parser';
import { APPLY_PATCH_PROMPT_GUIDE } from '@agent-core/tools-local/testing/apply-patch/prompt-guide';
import { validateToolObservationPresentation } from '@agent-core/tools';
import {
  applyPatchTool,
  listDirectoryTreeTool,
  readTextFilesTool,
  shellCommandTool,
  searchFileTextTool
} from '@agent-core/tools-local';

const readOnlyPolicy = { allowedRisks: ['read'] };
const writePolicy = { allowedRisks: ['read', 'write'] };
const dryRunWritePolicy = { allowedRisks: ['read'], dryRunWrites: true };
const allTools = [listDirectoryTreeTool, searchFileTextTool, readTextFilesTool, applyPatchTool, shellCommandTool];

function patch(body) {
  return `*** Begin Patch\n${body}*** End Patch`;
}

function assertPatchParseReason(text, reason, limits = { maxPatchBytes: 512_000 }) {
  assert.throws(
    () => parseApplyPatch(text, limits),
    (error) => error?.reason === reason
  );
}

function assertPatchApplyReason(content, body, reason, expected = {}) {
  const parsed = parseApplyPatch(patch(body), { maxPatchBytes: 512_000 });
  const operation = parsed.operations.find((item) => item.kind === 'update');
  assert.ok(operation);
  assert.throws(
    () => applyPatchUpdate(content, operation),
    (error) => {
      if (error?.reason !== reason) return false;
      for (const [key, value] of Object.entries(expected)) {
        if (value === undefined) {
          if (error[key] !== undefined) return false;
          continue;
        }
        assert.deepEqual(error[key], value);
      }
      return true;
    }
  );
}

test('apply_patch parses Codex-style patch documents', () => {
  const parsed = parseApplyPatch(patch([
    '*** Add File: created.txt',
    '+hello',
    '+world',
    '*** Update File: old.txt',
    '*** Move to: moved.txt',
    '@@ functionName',
    ' one',
    '-two',
    '+TWO',
    '*** Delete File: stale.txt',
    ''
  ].join('\n')), { maxPatchBytes: 512_000 });

  assert.equal(parsed.operations.length, 3);
  assert.equal(parsed.operations[0].kind, 'add');
  assert.equal(parsed.operations[0].path, 'created.txt');
  assert.equal(parsed.operations[0].content, 'hello\nworld\n');
  assert.equal(parsed.operations[1].kind, 'update');
  assert.equal(parsed.operations[1].moveTo, 'moved.txt');
  assert.equal(parsed.operations[1].hunks[0].header, 'functionName');
  assert.deepEqual(parsed.operations[1].hunks[0].oldLines, ['one', 'two']);
  assert.deepEqual(parsed.operations[1].hunks[0].newLines, ['one', 'TWO']);
  assert.equal(parsed.operations[2].kind, 'delete');
  assert.equal(parsed.additions, 3);
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.hunkCount, 1);

  assertPatchParseReason('', 'empty_patch');
  assertPatchParseReason('*** Begin Patch\n*** End Patch', 'invalid_operation');
  assertPatchParseReason('*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch', 'missing_wrapper');
  assertPatchParseReason('*** Begin Patch\n--- a/file\n+++ b/file\n*** End Patch', 'unsupported_header');
  assertPatchParseReason(patch('*** Update File: a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n'), 'unsupported_header');
  assertPatchParseReason(patch('*** Add File: empty.txt\n'), 'empty_add_file');
  assertPatchParseReason(patch('*** Add File: bad.txt\nnot-prefixed\n'), 'invalid_operation');
  assertPatchParseReason(patch('*** Update File: a.txt\nnot-a-hunk\n'), 'missing_hunk_header');
  assertPatchParseReason(patch('*** Update File: a.txt\n@@\n unchanged\n'), 'hunk_without_change');
  assertPatchParseReason(patch('*** Update File: a.txt\n@@\n-old\n+new\n'), 'patch_too_large', { maxPatchBytes: 10 });
});

test('apply_patch freeform grammar and guide prevent context-only update hunks', () => {
  assert.match(APPLY_PATCH_LARK_GRAMMAR, /patch_hunk: change_context hunk_line\* changed_line hunk_line\* eof_line\?/);
  assert.match(APPLY_PATCH_LARK_GRAMMAR, /changed_line: \("\+" \| "-"\)/);
  assert.match(APPLY_PATCH_LARK_GRAMMAR, /update_hunk: "\*\*\* Update File: " filename LF \(move_update \| patch_update\)/);
  assert.match(APPLY_PATCH_LARK_GRAMMAR, /move_update: change_move patch_update\?/);
  assert.doesNotMatch(APPLY_PATCH_LARK_GRAMMAR, /change: \(change_context \| change_line\)\+/);

  assert.match(APPLY_PATCH_PROMPT_GUIDE, /Every Update File section has at least one @@ hunk unless it is move-only/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /Every @@ hunk has at least one \+ or - line/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /context-only hunks are invalid/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /Patch against exact current file text/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /Inspect the exact current target region immediately before patching/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /not remembered text or earlier broad output/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /do not copy line numbers from numbered listings/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /larger changed regions/);
  assert.doesNotMatch(APPLY_PATCH_PROMPT_GUIDE, /Valid minimal update:/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /Valid update with multiple changed lines and hunks:/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /@@ functionOrSectionName/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /-old line two from current file/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /@@ nextSection/);
  assert.match(APPLY_PATCH_PROMPT_GUIDE, /Do not do this:/);
});

test('apply_patch applies update hunks with exact matching semantics', () => {
  const replace = parseApplyPatch(patch('*** Update File: note.txt\n@@\n one\n-two\n+TWO\n three\n'), { maxPatchBytes: 512_000 });
  const replaced = applyPatchUpdate('one\ntwo\nthree\n', replace.operations[0]);
  assert.equal(replaced.content, 'one\nTWO\nthree\n');
  assert.deepEqual(replaced.matchModes, ['exact']);
  assert.equal(replaced.exact, true);

  const insertBefore = parseApplyPatch(patch('*** Update File: note.txt\n@@\n+zero\n one\n'), { maxPatchBytes: 512_000 });
  assert.equal(applyPatchUpdate('one\ntwo\n', insertBefore.operations[0]).content, 'zero\none\ntwo\n');

  const insertAfter = parseApplyPatch(patch('*** Update File: note.txt\n@@\n one\n+after\n'), { maxPatchBytes: 512_000 });
  assert.equal(applyPatchUpdate('one\ntwo\n', insertAfter.operations[0]).content, 'one\nafter\ntwo\n');

  const deleteLine = parseApplyPatch(patch('*** Update File: note.txt\n@@\n one\n-two\n three\n'), { maxPatchBytes: 512_000 });
  assert.equal(applyPatchUpdate('one\ntwo\nthree\n', deleteLine.operations[0]).content, 'one\nthree\n');

  assertPatchApplyReason('x\ny\n', '*** Update File: note.txt\n@@\n missing\n-old\n+new\n', 'context_not_found', { possiblyAlreadyApplied: undefined });
  assertPatchApplyReason('x\ny\nx\ny\n', '*** Update File: note.txt\n@@\n x\n-y\n+Y\n', 'ambiguous_context', { matchCount: 2, candidateLines: [1, 3] });
  const narrowed = parseApplyPatch(patch('*** Update File: note.txt\n@@ function two\n x\n-y\n+Y\n'), { maxPatchBytes: 512_000 });
  assert.equal(applyPatchUpdate('function one\nx\ny\nfunction two\nx\ny\n', narrowed.operations[0]).content, 'function one\nx\ny\nfunction two\nx\nY\n');
  assertPatchApplyReason('x\nY\n', '*** Update File: note.txt\n@@\n x\n-y\n+Y\n', 'context_not_found', { possiblyAlreadyApplied: true });
  const crlf = parseApplyPatch(patch('*** Update File: note.txt\n@@\n-a\n+A\n'), { maxPatchBytes: 512_000 });
  assert.equal(applyPatchUpdate('a\r\nb\r\n', crlf.operations[0]).content, 'A\r\nb\r\n');

  const eofMarker = parseApplyPatch(patch('*** Update File: note.txt\n@@\n start\n-old\n+new\n*** End of File\n'), { maxPatchBytes: 512_000 });
  assert.equal(applyPatchUpdate('start\nold\n', eofMarker.operations[0]).content, 'start\nnew\n');
});

test('apply_patch applies bounded tolerant matches and reports match quality', async () => {
  const trailing = parseApplyPatch(patch('*** Update File: note.txt\n@@\n-foo\n-bar\n+FOO\n+BAR\n'), { maxPatchBytes: 512_000 });
  const trailingResult = applyPatchUpdate('foo   \nbar\t\n', trailing.operations[0]);
  assert.equal(trailingResult.content, 'FOO\nBAR\n');
  assert.deepEqual(trailingResult.matchModes, ['trim_trailing_whitespace']);
  assert.equal(trailingResult.exact, false);

  const surrounding = parseApplyPatch(patch('*** Update File: note.txt\n@@\n-alpha\n-beta\n+ALPHA\n+BETA\n'), { maxPatchBytes: 512_000 });
  const surroundingResult = applyPatchUpdate('  alpha  \n beta\n', surrounding.operations[0]);
  assert.equal(surroundingResult.content, 'ALPHA\nBETA\n');
  assert.deepEqual(surroundingResult.matchModes, ['trim_surrounding_whitespace']);

  const punctuation = parseApplyPatch(patch('*** Update File: note.txt\n@@\n-a-b\n+a to b\n'), { maxPatchBytes: 512_000 });
  const punctuationResult = applyPatchUpdate('a—b\n', punctuation.operations[0]);
  assert.equal(punctuationResult.content, 'a to b\n');
  assert.deepEqual(punctuationResult.matchModes, ['normalize_common_unicode_punctuation']);

  assertPatchApplyReason('foo   \nfoo\t\n', '*** Update File: note.txt\n@@\n-foo\n+bar\n', 'ambiguous_context', {
    matchCount: 2,
    candidateLines: [1, 2]
  });

  const narrowed = parseApplyPatch(patch('*** Update File: note.txt\n@@ section two\n-foo\n+bar\n'), { maxPatchBytes: 512_000 });
  const narrowedResult = applyPatchUpdate('section one\nfoo   \nsection two\nfoo\t\n', narrowed.operations[0]);
  assert.equal(narrowedResult.content, 'section one\nfoo   \nsection two\nbar\n');
  assert.deepEqual(narrowedResult.matchModes, ['trim_trailing_whitespace']);

  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-apply-patch-match-quality-'));
  await writeFile(path.join(dir, 'note.txt'), 'foo   \nbar\t\n', 'utf8');
  const patchText = patch('*** Update File: note.txt\n@@\n-foo\n-bar\n+FOO\n+BAR\n');
  const dryRun = await invokeToolCall(
    jsonToolCall('apply_patch', { patch: patchText, dryRun: true }),
    allTools,
    { services: { workspaceRoot: dir }, policy: writePolicy }
  );
  assert.equal(dryRun.ok, true);
  assert.deepEqual(dryRun.output.files[0].matchModes, ['trim_trailing_whitespace']);
  assert.equal(dryRun.output.files[0].exact, false);
  const view = await presentToolObservation(
    applyPatchTool,
    jsonToolCall('apply_patch', { patch: patchText, dryRun: true }),
    dryRun,
    { services: { workspaceRoot: dir }, policy: writePolicy },
    12_000
  );
  assert.deepEqual(view.results.files[0].matchModes, ['trim_trailing_whitespace']);
  assert.equal(view.results.files[0].exact, false);
});

test('apply_patch validates policy, dry-run, schema, and observation presentation output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-apply-patch-policy-'));
  const filePath = path.join(dir, 'note.txt');
  await writeFile(filePath, 'hello\nworld\n', 'utf8');

  assert.match(applyPatchTool.description, /Codex-style patch document/);
  assert.match(applyPatchTool.description, /Add File/);
  assert.equal(applyPatchTool.jsonSchema.properties.dryRun.default, false);
  assert.equal(applyPatchTool.jsonSchema.properties.maxBytesPerFile.default, 1_000_000);
  assert.equal(applyPatchTool.jsonSchema.properties.maxPatchBytes.default, 512_000);
  assert.equal(applyPatchTool.jsonSchema.properties.maxNewBytesPerFile.default, 1_000_000);
  assert.deepEqual(applyPatchTool.jsonSchema.required, ['patch']);
  assert.equal('files' in applyPatchTool.jsonSchema.properties, false);

  const patchText = patch('*** Update File: note.txt\n@@\n-hello\n+HELLO\n');
  const policyBlocked = await invokeToolCall(
    jsonToolCall('apply_patch', { patch: patchText }),
    allTools,
    { services: { workspaceRoot: dir }, policy: readOnlyPolicy }
  );
  assert.equal(policyBlocked.ok, false);
  assert.equal(policyBlocked.output.reason, 'policy');
  assert.equal(policyBlocked.output.policyReason, 'deny');
  assert.equal(policyBlocked.output.risk, 'write');

  const dryRunPolicy = await invokeToolCall(
    jsonToolCall('apply_patch', { patch: patchText }),
    allTools,
    { services: { workspaceRoot: dir }, policy: dryRunWritePolicy }
  );
  assert.equal(dryRunPolicy.ok, true);
  assert.equal(dryRunPolicy.output.dryRun, true);
  assert.equal(dryRunPolicy.output.transactional, true);
  assert.deepEqual(dryRunPolicy.output.changedPaths, []);
  assert.deepEqual(dryRunPolicy.output.wouldChangePaths, ['note.txt']);
  assert.equal(dryRunPolicy.output.totalOperationCount, 1);
  assert.equal(dryRunPolicy.output.totalHunkCount, 1);
  assert.equal(dryRunPolicy.output.totalAdditions, 1);
  assert.equal(dryRunPolicy.output.totalDeletions, 1);
  assert.deepEqual(dryRunPolicy.output.files[0].matchModes, ['exact']);
  assert.equal(dryRunPolicy.output.files[0].exact, true);
  assert.equal(await readFile(filePath, 'utf8'), 'hello\nworld\n');

  const view = await presentToolObservation(
    applyPatchTool,
    jsonToolCall('apply_patch', { patch: patchText }),
    dryRunPolicy,
    { services: { workspaceRoot: dir }, policy: dryRunWritePolicy },
    12_000
  );
  assert.equal(validateToolObservationPresentation(view).ok, true);
  assert.equal(view.scope.patchBytes, Buffer.byteLength(patchText, 'utf8'));
  assert.equal(view.scope.operationCount, 1);
  assert.equal(view.limits.maxPatchBytes, 512_000);
  assert.equal(view.results.dryRun, true);
  assert.equal(view.results.transactional, true);
  assert.equal(view.results.wouldChangePaths[0], 'note.txt');
  assert.deepEqual(view.results.files[0].matchModes, ['exact']);
  assert.equal(view.results.files[0].exact, true);
  assert.equal(JSON.stringify(view).includes('*** Begin Patch'), false);

  const freeformDryRun = await invokeToolCall(
    textToolCall('apply_patch', patchText),
    allTools,
    { services: { workspaceRoot: dir }, policy: dryRunWritePolicy }
  );
  assert.equal(freeformDryRun.ok, true);
  assert.equal(freeformDryRun.output.dryRun, true);

  const malformedFreeform = await invokeToolCall(
    textToolCall('apply_patch', 'not a patch document'),
    allTools,
    { services: { workspaceRoot: dir }, policy: dryRunWritePolicy }
  );
  assert.equal(malformedFreeform.ok, false);
  assert.equal(malformedFreeform.output.reason, 'invalid_arguments');
  assert.equal(malformedFreeform.output.details.failures[0].reason, 'patch_parse_error');
  assert.match(malformedFreeform.output.details.failures[0].nextAction, /Begin Patch/);
  const malformedView = await presentToolObservation(
    applyPatchTool,
    textToolCall('apply_patch', 'not a patch document'),
    malformedFreeform,
    { services: { workspaceRoot: dir }, policy: dryRunWritePolicy },
    12_000
  );
  assert.equal(validateToolObservationPresentation(malformedView).ok, true);
  assert.equal(malformedView.title, 'Patch validation failed');
  assert.equal(malformedView.failures.items[0].reason, 'patch_parse_error');
  assert.match(malformedView.failures.items[0].nextAction, /Begin Patch/);
  assert.equal(JSON.stringify(malformedView).includes('not a patch document'), false);

  const contextOnlyPatch = patch('*** Update File: note.txt\n@@\n hello\n world\n');
  const contextOnly = await invokeToolCall(
    textToolCall('apply_patch', contextOnlyPatch),
    allTools,
    { services: { workspaceRoot: dir }, policy: dryRunWritePolicy }
  );
  assert.equal(contextOnly.ok, false);
  assert.equal(contextOnly.output.details.failures[0].path, 'note.txt');
  assert.equal(contextOnly.output.details.failures[0].hunkIndex, 0);
  assert.equal(contextOnly.output.details.failures[0].oldPreview, 'hello\nworld');
  assert.match(contextOnly.output.details.failures[0].nextAction, /at least one \+ or - line/);
  const contextOnlyView = await presentToolObservation(
    applyPatchTool,
    textToolCall('apply_patch', contextOnlyPatch),
    contextOnly,
    { services: { workspaceRoot: dir }, policy: dryRunWritePolicy },
    12_000
  );
  assert.equal(contextOnlyView.failures.items[0].path, 'note.txt');
  assert.equal(contextOnlyView.failures.items[0].hunk, 1);
  assert.equal(contextOnlyView.failures.items[0].oldPreview, 'hello\nworld');
  assert.match(contextOnlyView.failures.items[0].nextAction, /at least one \+ or - line/);
});

test('apply_patch writes add/update/delete/move operations transactionally', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-apply-patch-runner-'));
  await mkdir(path.join(dir, 'nested'), { recursive: true });
  await writeFile(path.join(dir, 'first.txt'), 'one\ntwo\nthree\n', 'utf8');
  await writeFile(path.join(dir, 'nested', 'second.txt'), 'alpha\r\nbeta\r\n', 'utf8');
  await writeFile(path.join(dir, 'stale.txt'), 'remove me\n', 'utf8');

  const patchText = patch([
    '*** Add File: created/new.txt',
    '+fresh',
    '*** Update File: first.txt',
    '@@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '@@',
    ' three',
    '+four',
    '*** Update File: nested/second.txt',
    '*** Move to: moved/second.txt',
    '@@',
    '-alpha',
    '+ALPHA',
    '*** Delete File: stale.txt',
    ''
  ].join('\n'));

  const applied = await invokeToolCall(
    jsonToolCall('apply_patch', { patch: patchText }),
    allTools,
    { services: { workspaceRoot: dir }, policy: writePolicy }
  );

  assert.equal(applied.ok, true);
  assert.equal(applied.output.dryRun, false);
  assert.equal(applied.output.transactional, true);
  assert.deepEqual(applied.output.createdPaths, ['created/new.txt']);
  assert.deepEqual(applied.output.deletedPaths, ['stale.txt']);
  assert.deepEqual(applied.output.movedPaths, [{ sourcePath: 'nested/second.txt', destinationPath: 'moved/second.txt' }]);
  assert.deepEqual(applied.metadata.changedPaths.sort(), ['created/new.txt', 'first.txt', 'moved/second.txt', 'nested/second.txt', 'stale.txt']);
  assert.equal(await readFile(path.join(dir, 'first.txt'), 'utf8'), 'one\nTWO\nthree\nfour\n');
  assert.equal(await readFile(path.join(dir, 'created', 'new.txt'), 'utf8'), 'fresh\n');
  assert.equal(await readFile(path.join(dir, 'moved', 'second.txt'), 'utf8'), 'ALPHA\r\nbeta\r\n');
  await assert.rejects(() => readFile(path.join(dir, 'nested', 'second.txt'), 'utf8'));
  await assert.rejects(() => readFile(path.join(dir, 'stale.txt'), 'utf8'));
});

test('apply_patch rejects stale, oversized, malformed, and invalid targets without partial writes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-apply-patch-invalid-'));
  await mkdir(path.join(dir, 'nested'), { recursive: true });
  await writeFile(path.join(dir, 'good.txt'), 'hello\nworld\nagain\n', 'utf8');
  await writeFile(path.join(dir, 'other.txt'), 'other\n', 'utf8');
  await writeFile(path.join(dir, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(dir, 'large.txt'), 'x'.repeat(1_200_000), 'utf8');
  await symlink(path.join(dir, 'good.txt'), path.join(dir, 'good-link.txt'));

  const shaMismatch = await invokeToolCall(
    jsonToolCall('apply_patch', { expectedOldSha256: { 'good.txt': '0'.repeat(64) }, patch: patch('*** Update File: good.txt\n@@\n-hello\n+hi\n') }),
    allTools,
    { services: { workspaceRoot: dir }, policy: writePolicy }
  );
  assert.equal(shaMismatch.ok, false);
  assert.equal(shaMismatch.output.details.failures[0].reason, 'sha256_mismatch');

  const tooLarge = await invokeToolCall(
    jsonToolCall('apply_patch', { maxNewBytesPerFile: 5, patch: patch('*** Update File: good.txt\n@@\n-hello\n+HELLO-LONG\n') }),
    allTools,
    { services: { workspaceRoot: dir }, policy: writePolicy }
  );
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.output.details.failures[0].reason, 'result_too_large');
  assert.equal(tooLarge.output.details.failures[0].operation, 'update');
  assert.match(tooLarge.output.details.failures[0].nextAction, /Reduce/);

  const missingContext = await invokeToolCall(
    jsonToolCall('apply_patch', { patch: patch('*** Update File: good.txt\n@@\n-missing\n+present\n') }),
    allTools,
    { services: { workspaceRoot: dir }, policy: writePolicy }
  );
  assert.equal(missingContext.ok, false);
  assert.equal(missingContext.output.details.failures[0].operation, 'update');
  assert.equal(missingContext.output.details.failures[0].hunkIndex, 0);
  assert.equal(missingContext.output.details.failures[0].failingLine, '-missing');
  assert.equal(missingContext.output.details.failures[0].reason, 'context_not_found');
  assert.match(missingContext.output.details.failures[0].nextAction, /Inspect the exact current region again/);
  assert.match(missingContext.summary, /operation=update/);
  const missingContextView = await presentToolObservation(
    applyPatchTool,
    jsonToolCall('apply_patch', { patch: patch('*** Update File: good.txt\n@@\n-missing\n+present\n') }),
    missingContext,
    { services: { workspaceRoot: dir }, policy: writePolicy },
    12_000
  );
  assert.equal(validateToolObservationPresentation(missingContextView).ok, true);
  assert.equal(missingContextView.title, 'Patch validation failed');
  assert.equal(missingContextView.failures.items[0].path, 'good.txt');
  assert.equal(missingContextView.failures.items[0].operation, 'update');
  assert.equal(missingContextView.failures.items[0].hunk, 1);
  assert.equal(missingContextView.failures.items[0].failingLine, '-missing');
  assert.equal(missingContextView.failures.items[0].reason, 'context_not_found');
  assert.match(missingContextView.failures.items[0].oldPreview, /missing/);
  assert.match(missingContextView.next, /Inspect the exact current region again/);

  const invalidTargets = await invokeToolCall(
    jsonToolCall('apply_patch', {
        patch: patch([
          '*** Update File: good.txt',
          '@@',
          '-hello',
          '+hi',
          '*** Add File: good.txt',
          '+duplicate',
          '*** Update File: missing.txt',
          '@@',
          '-x',
          '+y',
          '*** Update File: nested',
          '@@',
          '-x',
          '+y',
          '*** Update File: binary.bin',
          '@@',
          '-x',
          '+y',
          '*** Update File: large.txt',
          '@@',
          '-x',
          '+y',
          '*** Update File: other.txt',
          '*** Move to: good.txt',
          ''
        ].join('\n'))
      }),
    allTools,
    { services: { workspaceRoot: dir }, policy: writePolicy }
  );
  assert.equal(invalidTargets.ok, false);
  assert.equal(invalidTargets.output.reason, 'invalid_arguments');
  assert.deepEqual(
    invalidTargets.output.details.failures.map((failure) => failure.reason).sort(),
    ['already_exists', 'binary', 'destination_exists', 'not_file', 'not_found', 'too_large']
  );
  for (const target of ['good-link.txt', '../outside.txt']) {
    const invalidPath = await invokeToolCall(
      jsonToolCall('apply_patch', { patch: patch(`*** Add File: ${target}\n+bad\n`) }),
      allTools,
      { services: { workspaceRoot: dir }, policy: writePolicy }
    );
    assert.equal(invalidPath.ok, false);
    assert.equal(invalidPath.output.reason, 'invalid_arguments');
  }
  assert.equal(await readFile(path.join(dir, 'good.txt'), 'utf8'), 'hello\nworld\nagain\n');
});

test('apply_patch checks abort before committing writes and shared transaction preserves mode and rolls back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-apply-patch-abort-'));
  const filePath = path.join(dir, 'note.txt');
  await writeFile(filePath, 'hello\n', 'utf8');
  const controller = new AbortController();
  controller.abort('stop before patch write');

  await assert.rejects(
    () => invokeToolCall(
      jsonToolCall('apply_patch', { patch: patch('*** Update File: note.txt\n@@\n-hello\n+hi\n') }),
      allTools,
      { services: { workspaceRoot: dir }, policy: writePolicy, signal: controller.signal }
    ),
    /stop before patch write/
  );
  assert.equal(await readFile(filePath, 'utf8'), 'hello\n');

  await chmod(filePath, 0o744);
  const mode = (await stat(filePath)).mode;
  const committed = await commitTextFilePatchTransaction(dir, {
    writes: [{ path: 'note.txt', absolutePath: filePath, content: 'mode preserved\n', mode, overwrite: true }],
    removes: []
  }, { journalDirectory: path.join(dir, '.journal') });
  assert.equal(committed.outcome, 'committed');
  assert.equal((await stat(filePath)).mode & 0o777, 0o744);
  assert.equal(await readFile(filePath, 'utf8'), 'mode preserved\n');

  const firstPath = path.join(dir, 'first.txt');
  const blockingDir = path.join(dir, 'blocking');
  await writeFile(firstPath, 'old first\n', 'utf8');
  await mkdir(blockingDir);
  const rolledBack = await commitTextFilePatchTransaction(dir, {
      writes: [
        { path: 'first.txt', absolutePath: firstPath, content: 'new first\n', overwrite: true },
        { path: 'blocking', absolutePath: blockingDir, content: 'cannot replace directory\n', overwrite: true }
      ],
      removes: []
    }, { journalDirectory: path.join(dir, '.journal') });
  assert.equal(rolledBack.outcome, 'rolled_back');
  assert.equal(rolledBack.rollback.status, 'succeeded');
  assert.match(rolledBack.failure.message, /Path is not a regular file|EISDIR|ENOTEMPTY|EACCES|EPERM/);
  assert.equal(await readFile(firstPath, 'utf8'), 'old first\n');
});

test('text transaction journal survives an interrupted rollback and recovers on restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-core-apply-patch-recovery-'));
  const journalDirectory = path.join(dir, '.journal');
  const firstPath = path.join(dir, 'first.txt');
  const secondPath = path.join(dir, 'second.txt');
  await writeFile(firstPath, 'old first\n');
  await writeFile(secondPath, 'old second\n');
  const fileSystem = {
    ...realFs,
    async rename(source, destination) {
      const sourceName = path.basename(String(source));
      if (sourceName === 'write-1.tmp') throw new Error('injected second write failure');
      if (sourceName === 'backup-write-0' && String(destination) === firstPath) throw new Error('injected rollback interruption');
      return realFs.rename(source, destination);
    }
  };
  const result = await commitTextFilePatchTransaction(dir, {
    writes: [
      { path: 'first.txt', absolutePath: firstPath, content: 'new first\n', overwrite: true },
      { path: 'second.txt', absolutePath: secondPath, content: 'new second\n', overwrite: true }
    ],
    removes: []
  }, { fileSystem, journalDirectory, transactionId: 'interrupted' });
  assert.equal(result.outcome, 'rollback_failed');
  assert.equal(result.rollback.status, 'failed');
  assert.match(result.failure.message, /injected second write failure/);
  assert.equal(result.rollback.diagnostics.length, 1);
  assert.equal(result.rollback.diagnostics[0].operation, 'restore_write_backup');
  assert.equal(result.rollback.diagnostics[0].path, firstPath);
  assert.deepEqual(result.rollback.strandedPaths, [path.join(journalDirectory, 'interrupted', 'backup-write-0')]);
  await assert.rejects(readFile(firstPath, 'utf8'), /ENOENT/);
  assert.equal(await readFile(secondPath, 'utf8'), 'old second\n');

  await recoverTextFilePatchTransactions(dir, journalDirectory);
  assert.equal(await readFile(firstPath, 'utf8'), 'old first\n');
  assert.equal(await readFile(secondPath, 'utf8'), 'old second\n');
  assert.deepEqual(await readdir(journalDirectory), []);
});

test('text transaction restart removes a committed journal without rolling back content', async () => {
  const cleanupDir = await mkdtemp(path.join(tmpdir(), 'agent-core-apply-patch-cleanup-fault-'));
  const journalDirectory = path.join(cleanupDir, '.journal');
  const cleanupPath = path.join(cleanupDir, 'note.txt');
  await writeFile(cleanupPath, 'old\n');
  const cleanupFileSystem = {
    ...realFs,
    async rm(target, options) {
      if (String(target) === path.join(journalDirectory, 'committed')) throw new Error('injected journal cleanup failure');
      return realFs.rm(target, options);
    }
  };
  const committedWithResidue = await commitTextFilePatchTransaction(cleanupDir, {
    writes: [{ path: 'note.txt', absolutePath: cleanupPath, content: 'new\n', overwrite: true }],
    removes: []
  }, { fileSystem: cleanupFileSystem, journalDirectory, transactionId: 'committed' });
  assert.equal(committedWithResidue.outcome, 'committed_with_residue');
  assert.equal(committedWithResidue.cleanup.status, 'failed');
  assert.equal(committedWithResidue.cleanup.diagnostics[0].operation, 'remove_patch_journal');
  assert.deepEqual(committedWithResidue.cleanup.strandedPaths, [path.join(journalDirectory, 'committed')]);
  assert.equal(await readFile(cleanupPath, 'utf8'), 'new\n');
  await recoverTextFilePatchTransactions(cleanupDir, journalDirectory);
  assert.equal(await readFile(cleanupPath, 'utf8'), 'new\n');
  assert.deepEqual(await readdir(journalDirectory), []);
});

test('text transaction recovery preserves untouched files and removes incomplete new files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-apply-patch-prepared-fault-'));
  const journalDirectory = path.join(root, '.journal');
  const existingPath = path.join(root, 'existing.txt');
  await writeFile(existingPath, 'original\n');
  const beforeMutation = await commitTextFilePatchTransaction(root, {
    writes: [{ path: 'existing.txt', absolutePath: existingPath, content: 'replacement\n', overwrite: true }],
    removes: []
  }, {
    journalDirectory,
    transactionId: 'before-mutation',
    fileSystem: {
      ...realFs,
      async rename(source, destination) {
        if (String(destination).endsWith('transaction.json')) throw new Error('injected prepared-manifest failure');
        return realFs.rename(source, destination);
      }
    }
  });
  assert.equal(beforeMutation.outcome, 'rolled_back');
  assert.equal(await readFile(existingPath, 'utf8'), 'original\n');

  const createdDirectory = path.join(root, 'created');
  let manifestRenames = 0;
  const afterMutation = await commitTextFilePatchTransaction(root, {
    writes: [{ path: 'created/file.txt', absolutePath: path.join(createdDirectory, 'file.txt'), content: 'value\n', overwrite: false }],
    removes: [],
    parentDirsToCreate: [createdDirectory]
  }, {
    journalDirectory,
    transactionId: 'after-mutation',
    fileSystem: {
      ...realFs,
      async rename(source, destination) {
        if (String(destination).endsWith('transaction.json')) {
          manifestRenames += 1;
          if (manifestRenames === 2) throw new Error('injected commit-marker failure');
        }
        return realFs.rename(source, destination);
      }
    }
  });
  assert.equal(afterMutation.outcome, 'rolled_back');
  await assert.rejects(readFile(path.join(createdDirectory, 'file.txt'), 'utf8'), /ENOENT/u);
  await assert.rejects(stat(createdDirectory), /ENOENT/u);
  assert.deepEqual(await readdir(journalDirectory), []);
});
