import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceTools } from './workspace-tools-helper.js';
import { InMemoryEventRepository } from '@agent-core/persistence';
import { agentEventCodec } from '@agent-core/runtime';
import { adoptWorkspaceFiles } from '@agent-core/tools';
import { createExecCommandTool } from '@agent-core/tools-local';

test('terminal progress survives the durable event boundary as a merged stream', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  await events.append('run', {
    type: 'tool.updated',
    turnIndex: 1,
    turnId: 'turn',
    requestAttempt: 1,
    toolBatchId: 'batch',
    callIndex: 0,
    callId: 'call',
    toolAttempt: 1,
    toolName: 'exec_command',
    progress: {
      type: 'output',
      stream: 'terminal',
      sequence: 0,
      text: 'terminal bytes',
      observedBytes: 14
    }
  });
  const records = [];
  for await (const record of events.read('run')) records.push(record);
  assert.equal(records[0].event.progress.stream, 'terminal');
});

test('workspace adoption rejects a null descriptor at the boundary', () => {
  assert.throws(() => adoptWorkspaceFiles({ descriptor: null }), /descriptor is invalid/);
});

test('command tools expose environment lifetimes only for a capable composition', () => {
  const local = createExecCommandTool();
  const environment = createExecCommandTool({ environmentLifetimeSupported: true });
  assert.equal(
    local.decodeInput({ kind: 'json', value: { command: 'server', lifetime: 'environment' } }).ok,
    false
  );
  assert.equal(
    environment.decodeInput({ kind: 'json', value: { command: 'server', lifetime: 'environment' } })
      .ok,
    true
  );
});

test('workspace reads preserve original BOM, CRLF, UTF-8 bytes and range hashes', async () => {
  const source = '\ufefffirst\r\nλ🙂second\r\nlast';
  const fixture = workspaceTools({ 'source.txt': source });
  const full = await fixture.invoke('read_files', { files: [{ path: 'source.txt' }] });
  assert.equal(full.kind, 'result');
  assert.equal(full.output.files[0].content, source);
  assert.equal(full.output.files[0].rangeSha256, fixture.digest(Buffer.from(source)));
  const range = await fixture.invoke('read_files', {
    files: [{ path: 'source.txt', startLine: 2, lineCount: 1 }]
  });
  assert.equal(range.output.files[0].content, 'λ🙂second\r\n');
  assert.equal(range.output.files[0].bytes, Buffer.byteLength('λ🙂second\r\n'));
  assert.equal(range.output.files[0].rangeSha256, fixture.digest(Buffer.from('λ🙂second\r\n')));
  const tool = fixture.host.tools.find((tool) => tool.name === 'read_files');
  const model = tool.buildModelContent({ observation: range });
  assert.ok(model.some((item) => item.type === 'text' && item.text === 'λ🙂second\r\n'));
});

test('workspace patch moves require delete authority and preserve executable modes', async () => {
  const fixture = workspaceTools({ 'tool.sh': 'old\n' });
  const patch =
    '*** Begin Patch\n*** Update File: tool.sh\n*** Move to: renamed.sh\n@@\n-old\n+new\n*** End Patch';
  const denied = await fixture.invoke('apply_patch', { patch }, ['read', 'write']);
  assert.equal(denied.kind, 'failure');
  assert.equal(fixture.transactions, 0);
  const accepted = await fixture.invoke('apply_patch', { patch });
  assert.equal(accepted.kind, 'result', accepted.summary);
  assert.equal(accepted.output.applicationStatus, 'applied');
  assert.equal(fixture.transactions, 1);
  assert.equal(fixture.content.has('tool.sh'), false);
  assert.equal(fixture.content.get('renamed.sh').mode, 0o755);
  assert.equal(Buffer.from(fixture.content.get('renamed.sh').bytes).toString(), 'new\n');
});

test('workspace text edits preserve Unicode positions and reject ambiguous duplicate paths', async () => {
  const fixture = workspaceTools({ 'source.txt': 'a🙂b\u2028last\r\nlast\n' });
  const file = {
    path: 'source.txt',
    expectedSha256: fixture.digest(Buffer.from('a🙂b\u2028last\r\nlast\n')),
    edits: [
      {
        range: { start: { line: 1, column: 5 }, end: { line: 1, column: 9 } },
        expectedText: 'last',
        replacementText: 'tail'
      }
    ]
  };
  const duplicate = await fixture.invoke('edit_text', {
    files: [file, { ...file, path: './source.txt' }]
  });
  assert.equal(duplicate.kind, 'failure');
  assert.equal(fixture.transactions, 0);
  const malformed = await fixture.invoke('edit_text', {
    files: [{ ...file, edits: [{ ...file.edits[0], replacementText: '\ud800' }] }]
  });
  assert.equal(malformed.kind, 'failure');
  assert.equal(fixture.transactions, 0);
  const edited = await fixture.invoke('edit_text', { files: [file] });
  assert.equal(edited.kind, 'result', edited.summary);
  assert.equal(
    Buffer.from(fixture.content.get('source.txt').bytes).toString(),
    'a🙂b\u2028tail\r\nlast\n'
  );
  assert.equal(fixture.content.get('source.txt').mode, 0o755);
});

test('workspace search uses bounded shared ripgrep semantics and reports incomplete reads', async () => {
  const fixture = workspaceTools({ 'one.ts': 'needle\nneedle again\n', 'two.js': 'needle\n' });
  const result = await fixture.invoke('search_text', {
    query: 'needle',
    patterns: ['*.{ts,js}'],
    mode: 'count'
  });
  assert.equal(result.kind, 'result', result.summary);
  assert.equal(result.output.status, 'completed');
  assert.equal(result.output.occurrenceCount, 3);
  assert.equal(result.output.matchingFileCount, 2);
  const exact = await fixture.invoke('search_text', {
    path: 'one.ts', query: 'needle', patterns: ['*.ts'], mode: 'count'
  });
  assert.equal(exact.kind, 'result', exact.summary);
  assert.equal(exact.output.occurrenceCount, 2);
  assert.deepEqual(exact.output.results.map((entry) => entry.path), ['one.ts']);
  fixture.files.readFile = async () => {
    throw new Error('source unavailable');
  };
  const partial = await fixture.invoke('search_text', { query: 'needle', patterns: ['*.ts'] });
  assert.equal(partial.output.resultCoverage, 'partial');
  assert.equal(partial.output.countCoverage, 'partial');
  assert.match(partial.output.diagnostic, /source unavailable/);
});

test('workspace discovery stops reading an incremental directory at the traversal bound', async () => {
  const fixture = workspaceTools({});
  let observed = 0;
  fixture.files.list = async function* () {
    for (let i = 0; i < 1_000_000; i++) {
      observed++;
      yield { name: `f${i}`, type: 'file' };
    }
  };
  const result = await fixture.invoke('find_files', { patterns: ['*'], resultLimit: 2 });
  assert.equal(result.output.coverage, 'partial');
  assert.ok(observed <= 20_001, `directory materialized ${observed} entries`);
  assert.equal(result.output.entries.length, 2);
});
