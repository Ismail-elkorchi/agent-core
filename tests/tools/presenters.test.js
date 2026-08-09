import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPatchTool,
  execCommandTool,
  findFilesTool,
  listDirectoryTool,
  readArtifactTool,
  readFilesTool,
  searchTextTool,
  stopProcessTool,
  writeStdinTool
} from '@agent-core/tools-local';

const hash = 'a'.repeat(64);
const completeScope = { resources: ['workspace/files'], coverage: 'complete' };

function present(tool, output, options = {}) {
  const scope = options.scope ?? completeScope;
  return tool.presentObservation({
    call: { name: tool.name, input: { kind: 'json', value: {} } }, input: {}, limit: { maxTokens: options.maxTokens ?? 500 },
    observation: { kind: 'result', ok: options.ok ?? true, summary: `${tool.name} result`, scope, output }
  });
}

test('domain presenters preserve their required shape while spending the supplied budget', () => {
  const listed = present(listDirectoryTool, {
    path: '.', coverage: 'partial', causes: ['result_limit'], counts: { visited: 12, returned: 9, omitted: 3 }, omitted: { ignoreFiles: 0 }, omissionSamples: [],
    entries: ['a/1', 'a/2', 'a/3', 'b/1', 'b/2', 'b/3', 'c/1', 'c/2', 'c/3'].map(path => ({ path, type: 'file' }))
  }, { scope: { resources: ['workspace/files'], coverage: 'partial', causes: ['result_limit'], omitted: { entries: 3 } }, maxTokens: 300 });
  assert.deepEqual([...new Set(listed.results.entries.map(entry => entry.path.split('/')[0]))], ['a', 'b', 'c']);
  assert.deepEqual(listed.results.counts, { visited: 12, returned: 9, omitted: 3 });
  assert.match(listed.next, /narrower/u);
  assertWithinBudget(listed, 300);

  const foundComplete = present(findFilesTool, {
    path: '.', patterns: ['**/*.ts'], coverage: 'complete', causes: [], counts: { visited: 5, returned: 3, omitted: 0 }, omitted: { ignoreFiles: 0 }, omissionSamples: [],
    entries: [{ path: 'z.ts', type: 'file' }, { path: 'a.ts', type: 'file' }, { path: 'm.ts', type: 'file' }]
  });
  assert.deepEqual(foundComplete.results.entries.map(entry => entry.path), ['a.ts', 'm.ts', 'z.ts']);
  assert.equal('next' in foundComplete, false);
  assertWithinBudget(foundComplete, 500);

  const read = present(readFilesTool, {
    requestedFiles: 3, returnedFiles: 3, failedFiles: 0, returnedBytes: 18_000, coverage: 'partial', failures: [],
    files: ['a.txt', 'b.txt', 'c.txt'].map((path, index) => ({ path, startLine: 1, lineCount: 100, content: String(index).repeat(6_000), bytes: 6_000, fileBytes: 6_000, eof: false, nextStartLine: 101, rangeSha256: hash, rangeLineEnding: 'lf' }))
  }, { scope: { resources: ['workspace/files/a.txt', 'workspace/files/b.txt', 'workspace/files/c.txt'], coverage: 'partial', causes: ['range_limit'] }, maxTokens: 700 });
  assert.deepEqual(read.results.files.map(file => file.path), ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(read.results.files.every(file => file.content.length > 0 && file.continuationLine === 101), true);
  assertWithinBudget(read, 700);

  const searched = present(searchTextTool, {
    query: 'needle', mode: 'matches', status: 'partial', coverage: 'partial', examinedFileCount: 2, matchingFileCount: 2, matchingLineCount: 4,
    occurrenceCount: 4, omittedResultCount: 2, countsCapped: false, omittedResultCountIsLowerBound: false, outputTruncated: false,
    perFileOmissions: [{ path: 'a.txt', cause: 'per_file_limit', retainedMatches: 1, omittedAtLeast: 1 }],
    results: [
      { path: 'a.txt', lineNumber: 1, text: 'needle ' + 'a'.repeat(2_000), occurrences: [{ startByte: 0, endByte: 6, text: 'needle' }] },
      { path: 'a.txt', lineNumber: 2, text: 'needle again', occurrences: [{ startByte: 0, endByte: 6, text: 'needle' }] },
      { path: 'b.txt', lineNumber: 3, text: 'needle ' + 'b'.repeat(2_000), occurrences: [{ startByte: 0, endByte: 6, text: 'needle' }] }
    ]
  }, { scope: { resources: ['workspace/files'], coverage: 'partial', causes: ['per_file_limit'] }, maxTokens: 700 });
  assert.deepEqual([...new Set(searched.results.results.map(match => match.path))], ['a.txt', 'b.txt']);
  assert.equal(searched.results.perFileOmissions[0].cause, 'per_file_limit');
  assertWithinBudget(searched, 700);

  const patched = present(applyPatchTool, {
    status: 'rollback_failed', workspaceState: 'uncertain', dryRun: false, transactional: true,
    files: [
      { path: 'a.txt', operation: 'update', hunkCount: 1, additions: 1, deletions: 1, oldBytes: 1, newBytes: 1, changed: false },
      { path: 'old.txt', destinationPath: 'new.txt', operation: 'move', hunkCount: 0, additions: 0, deletions: 0, oldBytes: 1, newBytes: 1, changed: false }
    ],
    changedPaths: [], wouldChangePaths: ['a.txt', 'old.txt', 'new.txt'], createdPaths: [], wouldCreatePaths: [], deletedPaths: [], wouldDeletePaths: [],
    movedPaths: [], wouldMovePaths: [{ sourcePath: 'old.txt', destinationPath: 'new.txt' }], potentiallyAffectedPaths: ['a.txt', 'old.txt', 'new.txt'],
    totalOperationCount: 2, totalHunkCount: 1, totalAdditions: 1, totalDeletions: 1, failures: [],
    transaction: { outcome: 'rollback_failed', failure: { operation: 'commit_patch', path: 'a.txt', message: 'commit failed' }, rollback: { status: 'uncertain', diagnostics: [{ operation: 'restore', path: 'a.txt', message: 'state unknown' }], strandedPaths: ['a.txt'] } }
  }, { scope: { resources: ['workspace/files/a.txt', 'workspace/files/old.txt', 'workspace/files/new.txt'], coverage: 'partial', causes: ['workspace_state_uncertain'] }, ok: false });
  assert.equal(patched.results.status, 'rollback_failed');
  assert.equal(patched.results.workspaceState, 'uncertain');
  assert.deepEqual(patched.results.files.map(file => [file.path, file.operation, file.additions, file.deletions]), [['a.txt', 'update', 1, 1], ['old.txt', 'move', 0, 0]]);
  assert.equal(patched.results.transaction.outcome, 'rollback_failed');
  assertWithinBudget(patched, 500);

  for (const tool of [execCommandTool, writeStdinTool, stopProcessTool]) {
    const process = present(tool, {
      status: 'exited', processId: 'proc-1', exitCode: 0, cursorStart: 0, cursorEnd: 5_000, cursorExpired: false,
      stdout: { text: '', bytes: 0, omittedBytes: 0 }, stderr: { text: '', bytes: 0, omittedBytes: 0 },
      combined: { text: 'START' + 'x'.repeat(5_000) + 'TRUE_TAIL', bytes: 5_014, omittedBytes: 100 },
      artifact: { artifactId: 'public.txt', sha256: hash, size: 5_014, mediaType: 'text/plain', visibility: 'public' }
    }, { maxTokens: 250 });
    assert.equal(process.results.processId, 'proc-1');
    assert.equal(process.results.exitCode, 0);
    assert.match(process.results.outputTail, /TRUE_TAIL$/u);
    assert.equal(process.results.artifact.visibility, 'public');
    assertWithinBudget(process, 250);
  }

  const completeArtifact = present(readArtifactTool, {
    artifact: { artifactId: 'public.txt', sha256: hash, size: 4, mediaType: 'text/plain', visibility: 'public' }, fullSize: 4,
    returnedRange: { start: 0, end: 4 }, returnedBytes: 4, coverage: 'complete', text: 'body', contentType: 'text'
  });
  assert.equal(completeArtifact.results.artifactId, 'public.txt');
  assert.equal(completeArtifact.results.fullSize, 4);
  assert.equal(completeArtifact.results.textExcerpt, 'body');
  assert.equal('next' in completeArtifact, false);
  assert.equal('nextOffset' in completeArtifact.results, false);
  assertWithinBudget(completeArtifact, 500);
});

function assertWithinBudget(presentation, maxTokens) {
  assert.ok(Buffer.byteLength(JSON.stringify(presentation), 'utf8') <= maxTokens * 4, `presentation exceeded ${maxTokens} tokens`);
}
