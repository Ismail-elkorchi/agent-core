import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ContextManager } from '@agent-core/runtime';

const modelProfile = {
  id: 'scripted',
  provider: 'scripted',
  capabilities: {
    streaming: false,
    toolCalling: true,
    supportedToolInputs: [{ kind: 'json' }],
    jsonMode: false,
    jsonSchema: false,
    logprobs: false,
    temperature: true,
    topP: true,
    reasoning: undefined
  },
  modalities: { input: ['text'], output: ['text'] },
  limits: { contextTokens: 20_000, outputTokens: 4_000 },
  supportedParameters: ['tools']
};

test('ContextManager ranks and budgets already-materialized evidence only', () => {
  const manager = new ContextManager();
  const bundle = manager.selectContext({
    maxTokens: 5_000,
    items: [
      {
        sourceUri: 'file://a-low.ts',
        sourceKind: 'external',
        representation: 'excerpt',
        mediaType: 'text/plain',
        title: 'Alphabetically first but lower relevance',
        content: 'export const low = true;',
        selectionReason: 'lower score evidence',
        score: 10
      },
      {
        sourceUri: 'file://z-high.ts',
        sourceKind: 'external',
        confidence: 'verified',
        representation: 'excerpt',
        mediaType: 'text/plain',
        title: 'Alphabetically last but higher relevance',
        content: 'export const high = true;',
        selectionReason: 'higher score evidence',
        score: 100
      },
      {
        sourceUri: 'agent-core://session/checkpoint/0',
        sourceKind: 'session',
        representation: 'summary',
        mediaType: 'text/plain',
        title: 'Session checkpoint',
        content: 'Previous task completed.',
        selectionReason: 'prior checkpoint evidence',
        score: 90
      }
    ]
  });

  assert.deepEqual(bundle.items.map((item) => item.sourceUri), [
    'file://z-high.ts',
    'agent-core://session/checkpoint/0',
    'file://a-low.ts'
  ]);
  assert.equal(bundle.items[0].sourceKind, 'external');
  assert.equal(bundle.items[0].confidence, 'verified');
});

test('ContextManager exposes no repository fetching helpers and the runtime has no legacy package dependencies', async () => {
  const contextModule = await import('@agent-core/runtime');
  const packageJson = JSON.parse(await readFile(new URL('../packages/runtime/package.json', import.meta.url), 'utf8'));

  assert.equal('buildRepoMap' in contextModule, false);
  assert.equal(['Context', 'Builder'].join('') in contextModule, false);
  assert.equal(['Context', 'Trust', 'Level'].join('') in contextModule, false);
  for (const removedPackage of ['@agent-core/context', '@agent-core/core-agent', '@agent-core/project', '@agent-core/prompt', '@agent-core/run', '@agent-core/session']) {
    assert.equal(packageJson.dependencies[removedPackage], undefined);
  }
});

test('ContextManager omits provided noisy evidence by score and budget, not by filesystem search', () => {
  const bundle = new ContextManager().selectContext({
    maxTokens: 20,
    items: [
      {
        sourceUri: 'file://src/parser.ts',
        sourceKind: 'external',
        representation: 'excerpt',
        mediaType: 'text/plain',
        title: 'Parser source',
        content: 'export function parse(input: string) { return input; }',
        selectionReason: 'source evidence supplied by caller',
        score: 100
      },
      {
        sourceUri: 'file://package-lock.json',
        sourceKind: 'external',
        representation: 'full',
        mediaType: 'application/json',
        title: 'Lockfile',
        content: 'x'.repeat(1_000),
        selectionReason: 'caller supplied noisy metadata',
        score: 1
      }
    ]
  });

  assert.equal(bundle.items.some((item) => item.sourceUri === 'file://src/parser.ts'), true);
  assert.equal(bundle.items.some((item) => item.sourceUri === 'file://package-lock.json'), false);
  assert.equal(bundle.omitted.some((item) => item.sourceUri === 'file://package-lock.json'), true);
});

test('ContextManager preserves native tool call/result pairs in projected history', () => {
  const manager = new ContextManager();
  manager.recordModelOutput({
    turnIndex: 1,
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        name: 'read_text_files',
        input: { kind: 'json', value: { files: [{ path: 'a.txt' }] } }
      }
    ]
  });
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'read_text_files',
    toolCallType: 'function',
    callId: 'call-1',
    immediateContent: '{"ok":true,"summary":"read a.txt"}',
    retainedContent: '{"ok":true,"summary":"retained read a.txt"}'
  });

  const projection = manager.project({
    task: 'summarize',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 }
  });

  assert.equal(projection.contextHistoryMessages.length, 2);
  assert.equal(projection.contextHistoryMessages[0].role, 'assistant');
  assert.equal(projection.contextHistoryMessages[0].toolCalls[0].id, 'call-1');
  assert.equal(projection.contextHistoryMessages[1].role, 'tool');
  assert.equal(projection.contextHistoryMessages[1].toolCallId, 'call-1');
});

test('ContextManager projects compact evidence without inferring reads from listed paths', () => {
  const manager = new ContextManager();
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'list_directory_tree',
    toolCallType: 'function',
    immediateContent: '{"ok":true}',
    retainedContent: '{"ok":true}',
    evidence: [
      {
        id: 'obs-list:evidence:1',
        observationId: 'obs-list',
        toolName: 'list_directory_tree',
        createdAt: '2026-06-23T00:00:00.000Z',
        action: 'list',
        outcome: 'success',
        resources: [{ uri: 'workspace://src/index.ts' }],
        scope: { truncated: false, confidence: 'verified' },
        summary: 'Listed src/index.ts.'
      },
      {
        id: 'obs-shell:evidence:1',
        observationId: 'obs-shell',
        toolName: 'shell_command',
        createdAt: '2026-06-23T00:00:00.000Z',
        action: 'execute',
        outcome: 'success',
        resources: [],
        scope: { truncated: false, confidence: 'verified' },
        summary: 'Executed ls.'
      }
    ]
  });

  const projection = manager.project({
    task: 'continue',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 },
    evidenceTokenBudget: 4_000
  });

  assert.equal(projection.prompt.evidence.records.length, 2);
  assert.deepEqual(projection.prompt.evidence.records.map((record) => record.action), ['list', 'execute']);
  assert.equal(projection.prompt.evidence.records.some((record) => record.action === 'read'), false);
  assert.equal(projection.estimate.evidenceTokens > 0, true);
});

test('ContextManager summarizes omitted evidence within the evidence budget', () => {
  const manager = new ContextManager();
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'shell_command',
    toolCallType: 'function',
    immediateContent: '{"ok":true}',
    retainedContent: '{"ok":true}',
    evidence: [
      {
        id: 'obs-1:evidence:1',
        observationId: 'obs-1',
        toolName: 'shell_command',
        createdAt: '2026-06-23T00:00:00.000Z',
        action: 'execute',
        outcome: 'success',
        resources: [],
        summary: 'A'.repeat(2_000)
      },
      {
        id: 'obs-2:evidence:1',
        observationId: 'obs-2',
        toolName: 'shell_command',
        createdAt: '2026-06-23T00:00:01.000Z',
        action: 'execute',
        outcome: 'success',
        resources: [],
        summary: 'B'.repeat(2_000)
      },
      {
        id: 'obs-3:evidence:1',
        observationId: 'obs-3',
        toolName: 'apply_patch',
        createdAt: '2026-06-23T00:00:02.000Z',
        action: 'update',
        outcome: 'failure',
        resources: [],
        summary: 'C'.repeat(2_000)
      }
    ]
  });

  const evidence = manager.projectEvidence(120);

  assert.equal(evidence.records.length, 0);
  assert.equal(evidence.omittedRecords, 3);
  assert.deepEqual(evidence.omittedSummary, [
    { toolName: 'shell_command', action: 'execute', outcome: 'success', count: 2 },
    { toolName: 'apply_patch', action: 'update', outcome: 'failure', count: 1 }
  ]);
  assert.equal(evidence.tokenEstimate <= 120, true);
  assert.equal(evidence.coverage, 'partial');
});

test('ContextManager checkpoints old pairs instead of replaying executable placeholders', () => {
  const manager = new ContextManager();
  manager.recordModelOutput({
    turnIndex: 1,
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        name: 'shell_command',
        input: { kind: 'json', value: { command: 'printf large' } }
      }
    ]
  });
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'shell_command',
    toolCallType: 'function',
    callId: 'call-1',
    immediateContent: '{"ok":true,"summary":"large output immediate","results":{"stdout":"large output"}}',
    retainedContent: '{"ok":true,"summary":"large output retained"}',
    evidence: [{
      id: 'obs-shell:evidence:1',
      observationId: 'obs-shell',
      toolName: 'shell_command',
      createdAt: '2026-06-24T00:00:00.000Z',
      action: 'execute',
      outcome: 'success',
      resources: [],
      summary: 'Executed command.'
    }]
  });

  const checkpoint = manager.installCheckpoint();
  assert.ok(checkpoint);
  const projection = manager.project({
    task: 'continue',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 }
  });

  assert.equal(projection.contextHistoryMessages.length, 0);
  assert.equal(projection.prompt.continuity.length, 1);
  assert.match(projection.prompt.continuity[0], /reference-only continuity data/);
  assert.match(projection.prompt.continuity[0], /Compacted observations/);
  assert.match(projection.prompt.continuity[0], /shell_command ok: large output retained/);
  assert.match(projection.prompt.continuity[0], /Evidence summary/);
  assert.match(projection.prompt.continuity[0], /shell_command execute success: 1/);
  assert.equal(projection.contextHistoryMessages.some((message) => message.role === 'assistant' && message.toolCalls), false);
  assert.doesNotMatch(projection.prompt.continuity[0], /\[omitted large tool call string/);
});

test('ContextManager preserves recent exact pairs while reducing and checkpointing shell-heavy history', () => {
  const manager = new ContextManager();
  for (let index = 1; index <= 8; index += 1) {
    manager.recordModelOutput({
      turnIndex: index,
      content: `visible assistant turnIndex ${index}`,
      toolCalls: [
        {
          id: `call-${index}`,
          type: 'function',
          name: 'shell_command',
          input: { kind: 'json', value: { command: `printf turnIndex-${index}` } }
        }
      ]
    });
    manager.recordToolResult({
      turnIndex: index,
      toolName: 'shell_command',
      toolCallType: 'function',
      callId: `call-${index}`,
      immediateContent: JSON.stringify({
        ok: true,
        title: 'Command execution result',
        summary: `immediate turnIndex ${index}`,
        results: { stdout: `turnIndex ${index} ${'x'.repeat(2_000)}` },
        truncated: false
      }),
      retainedContent: JSON.stringify({
        ok: true,
        title: 'Command execution result',
        summary: `retained turnIndex ${index}`,
        results: { status: { exitCode: 0 } },
        truncated: true
      }),
      evidence: [{
        id: `obs-${index}:evidence:1`,
        observationId: `obs-${index}`,
        toolName: 'shell_command',
        createdAt: `2026-06-24T00:00:${String(index).padStart(2, '0')}.000Z`,
        action: 'execute',
        outcome: 'success',
        resources: [],
        summary: `Executed turnIndex ${index}.`
      }]
    });
  }

  const reduction = manager.reduceHistoryForPromptPressure({
    modelProfile,
    maxHistoryTokens: 1_800,
    keepLatestToolResults: 2
  });
  assert.equal(reduction.reductions.length > 0, true);

  const projection = manager.project({
    task: 'continue',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 },
    evidenceTokenBudget: 120
  });
  const toolMessages = projection.contextHistoryMessages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 8);
  assert.match(toolMessages.find((message) => message.toolCallId === 'call-1').content, /retained turnIndex 1/);
  assert.doesNotMatch(toolMessages.find((message) => message.toolCallId === 'call-1').content, /x{100}/);
  assert.match(toolMessages.find((message) => message.toolCallId === 'call-7').content, /immediate turnIndex 7/);
  assert.match(toolMessages.find((message) => message.toolCallId === 'call-8').content, /immediate turnIndex 8/);
  assert.equal(projection.prompt.evidence.omittedSummary.some((item) => item.toolName === 'shell_command' && item.action === 'execute'), true);

  const checkpoint = manager.installCheckpoint();
  assert.ok(checkpoint);
  const checkpointProjection = manager.project({
    task: 'continue after checkpoint',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 },
    evidenceTokenBudget: 120
  });
  assert.equal(checkpointProjection.contextHistoryMessages.length, 0);
  assert.equal(checkpointProjection.prompt.continuity.length, 1);
  assert.match(checkpointProjection.prompt.continuity[0], /reference-only continuity data/);
  assert.match(checkpointProjection.prompt.continuity[0], /turnIndex 8 assistant: visible assistant turnIndex 8/);
  assert.match(checkpointProjection.prompt.continuity[0], /shell_command execute success: 8/);
  assert.doesNotMatch(checkpointProjection.prompt.continuity[0], /"toolCalls"/);
  assert.doesNotMatch(checkpointProjection.prompt.continuity[0], /function_call_output/);
});

test('ContextManager does not compact an existing checkpoint into a weaker checkpoint', () => {
  const manager = new ContextManager();
  manager.recordModelOutput({
    turnIndex: 1,
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        name: 'shell_command',
        input: { kind: 'json', value: { command: 'printf retained' } }
      }
    ]
  });
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'shell_command',
    toolCallType: 'function',
    callId: 'call-1',
    immediateContent: '{"ok":true,"summary":"large output immediate"}',
    retainedContent: '{"ok":true,"summary":"large output retained"}'
  });

  const first = manager.installCheckpoint();
  assert.ok(first);
  const checkpointText = manager.project({
    task: 'continue',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 }
  }).prompt.continuity[0];

  const second = manager.installCheckpoint();
  assert.equal(second, undefined);
  const projection = manager.project({
    task: 'continue',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 }
  });

  assert.equal(projection.prompt.continuity.length, 1);
  assert.equal(projection.prompt.continuity[0], checkpointText);
  assert.match(projection.prompt.continuity[0], /shell_command ok: large output retained/);
  assert.doesNotMatch(projection.prompt.continuity[0], /Removed active history items: 1/);
});
