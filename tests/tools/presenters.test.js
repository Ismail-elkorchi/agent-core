import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFilesTool,
  execCommandTool,
  searchTextTool,
  applyPatchTool,
  createExecCommandTool,
  findFilesTool,
  renderLocalToolObservation
} from '@agent-core/tools-local';
import { createCommandOutputView, renderCommandOutput, serializeToolModelContent } from '@agent-core/tools';
function content(tool, output) {
  return tool.buildModelContent({
    call: { name: tool.name, input: { kind: 'json', value: {} } },
    input: {},
    observation: {
      kind: 'result',
      summary: 'Source',
      scope: { resources: [], coverage: 'complete' },
      output
    }
  });
}

test('file content preserves large admissible source text and edit preconditions', () => {
  const source = 'const quotation = "Original αβγ";\n'.repeat(4000);
  const output = {
    coverage: 'partial',
    files: [
      {
        path: 'source.ts',
        startLine: 12,
        lineCount: 4000,
        nextStartLine: 4012,
        fullFileSha256: 'a'.repeat(64),
        rangeSha256: 'b'.repeat(64),
        bytes: Buffer.byteLength(source),
        fileBytes: Buffer.byteLength(source) + 300,
        eof: false,
        truncated: true,
        newlineConvention: 'lf',
        utf8Validation: 'valid',
        content: source
      }
    ],
    failures: [],
    requestedFiles: 1,
    returnedFiles: 1,
    failedFiles: 0,
    returnedBytes: Buffer.byteLength(source)
  };
  const parts = content(readFilesTool, output);
  assert.ok(parts.some((part) => part.type === 'text' && part.text === source));
  assert.match(serializeToolModelContent(parts), /fullFileSha256|nextStartLine/);
  assert.match(
    renderLocalToolObservation('read_files', { kind: 'result', output }).details[0].content,
    /12 │ const quotation/
  );
});

test('process content retains beginning, middle and end of selected logs without telemetry', () => {
  const log = 'first diagnostic\n' + 'detail\n'.repeat(4000) + 'last diagnostic';
  const output = {
    processId: 'process-1',
    status: 'exited',
    exitCode: 7,
    cursorStart: 0,
    cursorEnd: log.length,
    combined: {
      segments: [log],
      observedBytes: log.length,
      capturedBytes: log.length,
      omittedBytes: 0,
      startsAtOutputStart: true,
      endsAtOutputEnd: true
    },
    progressDroppedEvents: 19,
    progressDeliveryErrors: 3,
    owner: {
      ownerId: 'internal',
      runId: 'internal',
      turnId: 'turn',
      toolBatchId: 'batch',
      callIndex: 0
    },
    stdout: {
      segments: [log],
      observedBytes: log.length,
      capturedBytes: log.length,
      omittedBytes: 0,
      startsAtOutputStart: true,
      endsAtOutputEnd: true
    },
    stderr: {
      segments: [''],
      observedBytes: 0,
      capturedBytes: 0,
      omittedBytes: 0,
      startsAtOutputStart: true,
      endsAtOutputEnd: true
    }
  };
  const parts = content(execCommandTool, output);
  assert.ok(parts.some((part) => part.text === log));
  const serialized = serializeToolModelContent(parts);
  assert.match(serialized, /"exitCode":7/);
  assert.doesNotMatch(serialized, /progressDroppedEvents|progressDeliveryErrors|internal/);
  assert.equal(
    renderLocalToolObservation('exec_command', { kind: 'result', output }).status,
    'failed'
  );
  assert.equal(
    renderLocalToolObservation('exec_command', {
      kind: 'result',
      output: { ...output, status: 'running' }
    }).status,
    'running'
  );
});

test('overlapping search context appears once in continuous source passages with exact match ranges', () => {
  const output = {
    query: 'needle', status: 'partial', mode: 'matches',
    resultCoverage: 'partial', countCoverage: 'complete',
    examinedFileCount: 1, matchingFileCount: 1, matchingLineCount: 4, occurrenceCount: 4,
    omittedResultCount: 2, countsCapped: false, omittedResultCountIsLowerBound: false,
    outputTruncated: false, perFileOmissions: [],
    results: [
      { path: 'a', lineNumber: 30, text: 'needle α', occurrences: [{ startByte: 0, endByte: 6, text: 'needle' }],
        context: { before: [{ lineNumber: 29, text: 'before\tα' }], after: [{ lineNumber: 31, text: 'needle β' }] } },
      { path: 'a', lineNumber: 31, text: 'needle β', occurrences: [{ startByte: 0, endByte: 6, text: 'needle' }],
        context: { before: [{ lineNumber: 30, text: 'needle α' }], after: [{ lineNumber: 32, text: 'after\r' }] } }
    ]
  };
  searchTextTool.outputSchema.parse(output);
  const parts = content(searchTextTool, output);
  assert.equal(parts.length, 3);
  assert.equal(parts[2].text, 'before\tα\nneedle α\nneedle β\nafter\r');
  assert.match(parts[1].text, /"a" lines 29-32; match byte ranges by line: 30: 0-6; 31: 0-6/);
  assert.match(parts[0].text, /"resultCoverage":"partial","countCoverage":"complete"/);
  assert.match(parts[0].text, /"omittedResultCount":2/);
  const human = renderLocalToolObservation('search_text', { kind: 'result', output }).details[0].content;
  assert.equal(human.split('needle α').length - 1, 1);
});

test('disjoint command segments have inline gaps without modifying the authoritative source', () => {
  const view = createCommandOutputView({
    segments: ['first\n', 'last\n'], observedBytes: 100, capturedBytes: 11,
    startsAtOutputStart: true, endsAtOutputEnd: true
  });
  assert.equal(renderCommandOutput(view), 'first\n\n[... output omitted ...]\nlast\n');
  assert.deepEqual(view.segments, ['first\n', 'last\n']);
  const output = { processId: 'p', status: 'exited', exitCode: 0, cursorStart: 0, cursorEnd: 100,
    owner: { ownerId: 'o', runId: 'r', turnId: 't', toolBatchId: 'b', callIndex: 0 },
    stdout: view, stderr: { ...view, segments: [], observedBytes: 0, capturedBytes: 0, omittedBytes: 0 }, combined: view };
  assert.match(serializeToolModelContent(content(execCommandTool, output)), /first[\s\S]*output omitted[\s\S]*last/);
  assert.match(renderLocalToolObservation('exec_command', { kind: 'result', output }).details[0].content, /output omitted/);
  assert.match(renderCommandOutput({ ...view, segments: ['middle'], startsAtOutputStart: false, endsAtOutputEnd: false }), /Earlier output[\s\S]*middle[\s\S]*Later output/);
  assert.throws(() => execCommandTool.outputSchema.parse({ ...output, combined: { ...view, text: 'superseded' } }));
});

test('ordinary command success omits control telemetry, while partial output keeps continuation', () => {
  const view = createCommandOutputView({ segments: ['answer'], observedBytes: 6, capturedBytes: 6, startsAtOutputStart: true, endsAtOutputEnd: true });
  const output = { processId: 'p', status: 'exited', exitCode: 0, cursorStart: 0, cursorEnd: 6, stdout: view, stderr: view, combined: view };
  assert.deepEqual(JSON.parse(content(execCommandTool, output)[0].text), { status: 'exited', exitCode: 0, outputCoverage: 'complete' });
  const partial = JSON.parse(content(execCommandTool, { ...output, combined: { ...view, startsAtOutputStart: false } })[0].text);
  assert.equal(partial.outputCoverage, 'partial');
  assert.equal(partial.processId, 'p');
  assert.equal(partial.cursorEnd, 6);
});

test('mutation presentation lists each file once and keeps dry runs, uncertainty and residue explicit', () => {
  const output = {
    applicationStatus: 'applied', transactionOutcome: 'committed', rootState: 'known', dryRun: false,
    files: [{ path: 'new.txt', operation: 'add', hunkCount: 0, additions: 1, deletions: 0,
      newSha256: 'a'.repeat(64), oldBytes: 0, newBytes: 5, plannedChange: true, finalState: 'changed' }],
    changedPaths: ['new.txt'], wouldChangePaths: [], createdPaths: ['new.txt'], wouldCreatePaths: [],
    deletedPaths: [], wouldDeletePaths: [], movedPaths: [], wouldMovePaths: [], potentiallyAffectedPaths: [],
    transaction: { outcome: 'committed', cleanup: { status: 'succeeded', diagnostics: [], strandedPaths: [] } },
    totalOperationCount: 1, totalHunkCount: 0, totalAdditions: 1, totalDeletions: 0
  };
  applyPatchTool.outputSchema.parse(output);
  const rendered = serializeToolModelContent(content(applyPatchTool, output));
  assert.equal(rendered.split('new.txt').length - 1, 1);
  assert.match(rendered, /applied; workspace state known/);
  assert.match(rendered, /newSha256/);
  assert.doesNotMatch(rendered, /changedPaths|cleanup|wouldCreate/);
  assert.match(serializeToolModelContent(content(applyPatchTool, { ...output, dryRun: true, applicationStatus: 'dry_run' })), /dry_run[\s\S]*plannedChange/);
  assert.match(serializeToolModelContent(content(applyPatchTool, { ...output, applicationStatus: 'uncertain', rootState: 'uncertain', transaction: {
    outcome: 'rollback_failed', failure: { action: 'write', path: 'new.txt', message: 'write failed' },
    rollback: { status: 'failed', diagnostics: [], strandedPaths: ['residue.tmp'] }
  } })), /uncertain[\s\S]*rollback_failed[\s\S]*residue.tmp/);
});

test('tool schemas describe search-relative globs and expose only supported lifetimes', () => {
  assert.match(findFilesTool.jsonSchema.properties.patterns.description, /relative to path/);
  assert.match(searchTextTool.jsonSchema.properties.path.description, /do not bound traversal/);
  assert.equal(execCommandTool.jsonSchema.properties.lifetime, undefined);
  assert.match(execCommandTool.jsonSchema.properties.outputTokenBudget.description, /excerpts or pages/);
});
