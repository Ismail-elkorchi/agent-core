import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deliverPromptContext, ModelRequestAssembler, ModelWindow } from '@agent-core/runtime';
import { CompleteRequestEstimator } from '@agent-core/model';

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
const imageProfile = { ...modelProfile, modalities: { input: ['text', 'image'], output: ['text'] } };

test('application context follows retained history and precedes the current request and its tool responses', () => {
  const window = new ModelWindow();
  window.recordSourceItem('request-1', { role: 'user', content: 'Retain this requirement.' });
  window.recordSourceItem('answer-1', { role: 'assistant', content: 'Previous answer.' });
  const input = {
    window,
    task: 'Revise the result.',
    instructions: [{ id: 'preference', role: 'user', content: 'Keep it concise.', priority: 1 }],
    tools: [],
    modelProfile,
    contextItems: [{
      id: 'environment', sourceUri: 'application://environment', sourceKind: 'external',
      representation: 'full', mediaType: 'text/plain', title: 'Environment',
      content: 'Current environment.', purpose: 'Execution context.'
    }]
  };
  const assembler = new ModelRequestAssembler();
  const initial = assembler.assemble(input).messages;
  assert.deepEqual(initial.slice(0, 2), [
    { role: 'user', content: 'Retain this requirement.' },
    { role: 'assistant', content: 'Previous answer.' }
  ]);
  assert.match(initial[2].content, /Current environment/);
  assert.deepEqual(initial.slice(3), [
    { role: 'user', content: 'Keep it concise.' },
    { role: 'user', content: 'Revise the result.' }
  ]);

  window.recordModelOutput({
    turnIndex: 1, content: '',
    toolCalls: [{ id: 'read-1', type: 'function', name: 'read', input: { kind: 'json', value: {} } }]
  });
  window.recordToolResult({
    turnIndex: 1, toolName: 'read', toolCallType: 'function', callId: 'read-1',
    immediateContent: 'Observed result.'
  });
  const continuation = assembler.assemble(input).messages;
  assert.deepEqual(continuation.slice(0, initial.length), initial);
  assert.equal(continuation.at(-2).toolCalls[0].id, 'read-1');
  assert.equal(continuation.at(-1).role, 'tool');
  assert.equal(continuation.at(-1).toolCallId, 'read-1');
  assert.equal(continuation.at(-1).content, 'Observed result.');

  const refreshed = assembler.assemble({
    ...input,
    contextItems: [{ ...input.contextItems[0], content: 'Updated environment.' }]
  }).messages;
  assert.match(refreshed[2].content, /Updated environment/);
  assert.deepEqual(refreshed.slice(0, 2), continuation.slice(0, 2));
  assert.deepEqual(refreshed.slice(3), continuation.slice(3));
});

function assembleWindow(window, input) {
  const assembled = new ModelRequestAssembler().assemble({
    window,
    task: input.task,
    instructions: input.instructions,
    notes: input.notes,
    contextItems: input.contextItems,
    tools: input.tools,
    modelProfile: input.modelProfile
  });
  return { ...assembled, windowMessages: assembled.historyMessages, prompt: assembled.material };
}

function recordImageResult(manager, index, images) {
  const callId = `image-call-${index}`;
  manager.recordModelOutput({
    turnIndex: index,
    content: '',
    toolCalls: [
      {
        id: callId,
        type: 'function',
        name: 'view_image',
        input: { kind: 'json', value: { path: `${index}.png` } }
      }
    ]
  });
  manager.recordToolResult({
    turnIndex: index,
    toolName: 'view_image',
    toolCallType: 'function',
    callId,
    immediateContent: JSON.stringify({
      ok: true,
      summary: `image ${index}`,
      results: { artifacts: images.map((_, imageIndex) => `artifact-${index}-${imageIndex}`) }
    }),
    immediateImages: images
  });
}

test('selected images require explicit compatible admission without changing their source', () => {
  const manager = new ModelWindow();
  recordImageResult(manager, 1, [
    { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }
  ]);
  assert.throws(() => manager.messagesFor(modelProfile), /context_admission_failed/);
  assert.equal(manager.messagesFor(imageProfile).messages[1].images.length, 1);
});

test('image limits reject the selection instead of silently removing older attachments', () => {
  for (const limits of [
    { maxCount: 2, maxBytes: 100, maxEstimatedTokens: 10000 },
    { maxCount: 10, maxBytes: 5, maxEstimatedTokens: 10000 },
    { maxCount: 10, maxBytes: 100, maxEstimatedTokens: 2000 }
  ]) {
    const manager = new ModelWindow(new CompleteRequestEstimator(), limits);
    for (let i = 1; i <= 3; i++)
      recordImageResult(manager, i, [
        { type: 'bytes', data: new Uint8Array([i, i, i]), mediaType: 'image/png' }
      ]);
    assert.throws(() => manager.messagesFor(imageProfile), /context_admission_failed/);
    assert.equal(manager.toolResult('image-call-1').images.length, 1);
  }
});

test('context compaction keeps image tool protocol and public references while dropping active bytes', () => {
  const manager = new ModelWindow();
  recordImageResult(manager, 1, [
    { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }
  ]);
  const original = manager.toolResult('image-call-1');
  manager.selectToolResultPresentations(
    new Map([['image-call-1', { ...original, images: undefined, content: 'artifact-1-0' }]])
  );
  const reductions = manager.consumeReductions();
  assert.equal(reductions.length, 1);
  assert.ok(Object.isFrozen(reductions));
  assert.ok(Object.isFrozen(reductions[0]));
  const assembly = manager.messagesFor(imageProfile);
  assert.equal(assembly.messages.length, 2);
  assert.equal(assembly.messages[0].toolCalls[0].id, assembly.messages[1].toolCallId);
  assert.equal(assembly.messages[1].images, undefined);
  assert.match(assembly.messages[1].content, /artifact-1-0/u);
});

test('returned context reductions cannot mutate pending manager state', () => {
  const manager = new ModelWindow();
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'exec_command',
    toolCallType: 'function',
    callId: 'result-1',
    immediateContent: JSON.stringify({ output: 'x'.repeat(2_000) })
  });
  manager.selectToolResultPresentations(
    new Map([
      [
        'result-1',
        {
          role: 'tool',
          toolName: 'exec_command',
          toolCallType: 'function',
          toolCallId: 'result-1',
          content: 'retained'
        }
      ]
    ])
  );
  const reductions = manager.consumeReductions();
  const reduction = reductions[0];
  assert.ok(reduction);
  const expected = { ...reduction };
  assert.throws(() => {
    reduction.afterBytes = 0;
  }, TypeError);
  assert.throws(() => reductions.push(reduction), TypeError);
  const assembly = assembleWindow(manager, {
    task: 'continue',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 }
  });
  assert.deepEqual(reductions[0], expected);
  assert.ok(Object.isFrozen(reductions[0]));
  assert.equal('installCheckpoint' in manager, false);
});

test('prompt context delivery preserves application order without a second Core selection', () => {
  const bundle = deliverPromptContext([
    {
      sourceUri: 'file://a-low.ts',
      sourceKind: 'external',
      representation: 'excerpt',
      mediaType: 'text/plain',
      title: 'Alphabetically first but lower relevance',
      content: 'export const low = true;',
      purpose: 'lower-priority application context'
    },
    {
      sourceUri: 'file://z-high.ts',
      sourceKind: 'external',
      integrity: 'verified',
      representation: 'excerpt',
      mediaType: 'text/plain',
      title: 'Alphabetically last but higher relevance',
      content: 'export const high = true;',
      purpose: 'higher-priority application context'
    },
    {
      sourceUri: 'agent-core://session/checkpoint/0',
      sourceKind: 'session',
      representation: 'summary',
      mediaType: 'text/plain',
      title: 'Session checkpoint',
      content: 'Previous task completed.',
      purpose: 'prior checkpoint context'
    }
  ]);

  assert.deepEqual(
    bundle.items.map((item) => item.sourceUri),
    ['file://a-low.ts', 'file://z-high.ts', 'agent-core://session/checkpoint/0']
  );
  assert.equal(bundle.items[0].sourceKind, 'external');
  assert.equal(bundle.items[1].integrity, 'verified');
});

test('ModelWindow exposes no repository fetching helpers and the runtime has no legacy package dependencies', async () => {
  const contextModule = await import('@agent-core/runtime');
  const packageJson = JSON.parse(
    await readFile(new URL('../packages/runtime/package.json', import.meta.url), 'utf8')
  );

  assert.equal('buildRepoMap' in contextModule, false);
  assert.equal(['Context', 'Builder'].join('') in contextModule, false);
  assert.equal(['Context', 'Trust', 'Level'].join('') in contextModule, false);
  for (const removedPackage of [
    '@agent-core/context',
    '@agent-core/core-agent',
    '@agent-core/project',
    '@agent-core/prompt',
    '@agent-core/run',
    '@agent-core/session'
  ]) {
    assert.equal(packageJson.dependencies[removedPackage], undefined);
  }
});

test('prompt context delivery does not silently omit application-selected material', () => {
  const bundle = deliverPromptContext([
    {
      sourceUri: 'file://src/parser.ts',
      sourceKind: 'external',
      representation: 'excerpt',
      mediaType: 'text/plain',
      title: 'Parser source',
      content: 'export function parse(input: string) { return input; }',
      purpose: 'source material supplied by caller'
    },
    {
      sourceUri: 'file://package-lock.json',
      sourceKind: 'external',
      representation: 'full',
      mediaType: 'application/json',
      title: 'Lockfile',
      content: 'x'.repeat(1_000),
      purpose: 'caller supplied metadata'
    }
  ]);

  assert.equal(
    bundle.items.some((item) => item.sourceUri === 'file://src/parser.ts'),
    true
  );
  assert.equal(
    bundle.items.some((item) => item.sourceUri === 'file://package-lock.json'),
    true
  );
});

test('ModelWindow preserves native tool call/result pairs in model-window history', () => {
  const manager = new ModelWindow();
  manager.recordModelOutput({
    turnIndex: 1,
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        name: 'read_files',
        input: { kind: 'json', value: { files: [{ path: 'a.txt' }] } }
      }
    ]
  });
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'read_files',
    toolCallType: 'function',
    callId: 'call-1',
    immediateContent: '{"ok":true,"summary":"read a.txt"}'
  });

  const assembly = assembleWindow(manager, {
    task: 'summarize',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 }
  });

  assert.equal(assembly.windowMessages.length, 2);
  assert.equal(assembly.windowMessages[0].role, 'assistant');
  assert.equal(assembly.windowMessages[0].toolCalls[0].id, 'call-1');
  assert.equal(assembly.windowMessages[1].role, 'tool');
  assert.equal(assembly.windowMessages[1].toolCallId, 'call-1');
});

test('selected source records preserve complete conversation independently of result presentation reduction', () => {
  const window = new ModelWindow();
  const original = 'original constraint ' + '中'.repeat(1200) + ' KEEP THE LATE CORRECTION';
  window.recordSourceItem('source:user:1', { role: 'user', content: original });
  window.recordSourceItem('source:assistant:1', { role: 'assistant', content: 'answer '.repeat(1000) });
  window.recordSourceItem('source:user:1', { role: 'user', content: original });
  window.selectToolResultPresentations(new Map());
  const assembled = new ModelRequestAssembler().assemble({
    window,
    task: 'new task',
    instructions: [],
    tools: [],
    modelProfile
  });
  assert.equal(assembled.messages[0].content, original);
  assert.equal(assembled.messages[1].content, 'answer '.repeat(1000));
  assert.equal(assembled.messages[2].content, 'new task');
  assert.equal(assembled.messages.filter((item) => item.content === original).length, 1);
  assert.throws(
    () => window.recordSourceItem('source:user:1', { role: 'user', content: 'mutated' }),
    /immutable content/
  );
  assert.equal('installCheckpoint' in window, false);
  assert.equal('continuity' in assembled.material, false);
});

test('all exact tool arguments survive presentation pressure, including arguments larger than display output', () => {
  const window = new ModelWindow();
  const value = 'argument '.repeat(15000);
  window.recordModelOutput({
    turnIndex: 1,
    content: '',
    toolCalls: [
      { id: 'large', type: 'function', name: 'inspect', input: { kind: 'json', value: { value } } }
    ]
  });
  window.recordToolResult({
    turnIndex: 1,
    toolName: 'inspect',
    toolCallType: 'function',
    callId: 'large',
    immediateContent: 'large result '.repeat(5000)
  });
  window.selectToolResultPresentations(
    new Map([
      [
        'large',
        {
          role: 'tool',
          toolName: 'inspect',
          toolCallType: 'function',
          toolCallId: 'large',
          content: 'retained observation'
        }
      ]
    ])
  );
  const history = window.messagesFor(modelProfile);
  assert.equal(history.messages[0].toolCalls[0].input.value.value, value);
  assert.equal(history.messages[1].toolCallId, 'large');
  assert.equal(history.messages[1].content, 'retained observation');
});
