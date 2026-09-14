import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFilesTool,
  execCommandTool,
  searchTextTool,
  renderLocalToolObservation
} from '@agent-core/tools-local';
import { serializeToolModelContent } from '@agent-core/tools';
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
      text: log,
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
      text: log,
      observedBytes: log.length,
      capturedBytes: log.length,
      omittedBytes: 0,
      startsAtOutputStart: true,
      endsAtOutputEnd: true
    },
    stderr: {
      text: '',
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
  assert.match(serialized, /"exitCode": 7/);
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

test('search matches retain exact source bytes and omission facts', () => {
  const source = 'needle ' + 'α'.repeat(8000);
  const parts = content(searchTextTool, {
    mode: 'matches',
    resultCoverage: 'partial',
    omittedResultCount: 2,
    results: [{ path: 'a', lineNumber: 30, text: source }]
  });
  assert.ok(parts.some((part) => part.text === source));
  assert.match(serializeToolModelContent(parts), /omittedResultCount/);
});
