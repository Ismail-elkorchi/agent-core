import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deliverPromptContext, ModelRequestAssembler, ModelWindow } from '@agent-core/runtime';
import { SimpleTokenEstimator } from '@agent-core/model';

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

function assembleWindow(window, input) {
  const assembled = new ModelRequestAssembler().assemble({
    window,
    task: input.task,
    instructions: input.instructions,
    notes: input.notes,
    contextItems: input.contextItems,
    tools: input.tools,
    modelProfile: input.modelProfile,
    maxPromptTokens: input.requestWindow.maxPromptTokens,
    ...(input.observedFactTokenBudget === undefined ? {} : { observedFactTokenBudget: input.observedFactTokenBudget })
  });
  return { ...assembled, windowMessages: assembled.historyMessages, prompt: assembled.material };
}

function recordImageResult(manager, index, images) {
  const callId = `image-call-${index}`;
  manager.recordModelOutput({ turnIndex: index, content: '', toolCalls: [{ id: callId, type: 'function', name: 'view_image', input: { kind: 'json', value: { path: `${index}.png` } } }] });
  manager.recordToolResult({
    turnIndex: index, toolName: 'view_image', toolCallType: 'function', callId,
    immediateContent: JSON.stringify({ ok: true, summary: `image ${index}`, results: { artifacts: images.map((_, imageIndex) => `artifact-${index}-${imageIndex}`) } }),
    retainedContent: JSON.stringify({ ok: true, summary: `retained image ${index}`, results: { artifacts: images.map((_, imageIndex) => `artifact-${index}-${imageIndex}`) } }),
    immediateImages: images,
    imageArtifacts: images.map((image, imageIndex) => ({
      visibility: 'public', artifactId: `artifact-${index}-${imageIndex}`, sha256: `${index}${imageIndex}`.padEnd(64, '0'),
      size: image.data.byteLength, mediaType: image.mediaType
    }))
  });
}

test('history assembly removes incompatible images without mutating stored tool protocol history', () => {
  const manager = new ModelWindow();
  assert.equal(typeof manager.rawItems, 'undefined');
  recordImageResult(manager, 1, [{ type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', detail: 'original' }]);
  const multimodal = manager.messagesFor(imageProfile);
  assert.equal(multimodal.messages[1].images.length, 1);
  assert.equal(multimodal.reductions.length, 0);
  const textOnly = manager.messagesFor(modelProfile);
  assert.equal(textOnly.messages.length, 2);
  assert.equal(textOnly.messages[0].toolCalls[0].id, textOnly.messages[1].toolCallId);
  assert.equal(textOnly.messages[1].images, undefined);
  assert.match(textOnly.messages[1].content, /public artifact artifact-1-0/u);
  assert.deepEqual(textOnly.reductions.map((item) => item.reason), ['unsupported_modality']);
  assert.equal(manager.messagesFor(imageProfile).messages[1].images.length, 1);
  assert.ok(textOnly.estimatedTokens < multimodal.estimatedTokens);
});

test('active image count, byte, and token budgets remove older images deterministically', () => {
  const scenarios = [
    { limits: { maxCount: 2, maxBytes: 100, maxEstimatedTokens: 10_000 }, reason: 'image_count_limit' },
    { limits: { maxCount: 10, maxBytes: 5, maxEstimatedTokens: 10_000 }, reason: 'image_byte_limit' },
    { limits: { maxCount: 10, maxBytes: 100, maxEstimatedTokens: 2_000 }, reason: 'image_token_limit' }
  ];
  for (const scenario of scenarios) {
    const manager = new ModelWindow(new SimpleTokenEstimator(), scenario.limits);
    for (let index = 1; index <= 3; index += 1) recordImageResult(manager, index, [{ type: 'bytes', data: new Uint8Array([index, index, index]), mediaType: 'image/png' }]);
    const assembly = manager.messagesFor(imageProfile);
    const toolMessages = assembly.messages.filter((message) => message.role === 'tool');
    const attached = toolMessages.flatMap((message) => message.images ?? []);
    assert.equal(attached.every((image) => image.data[0] !== 1), true);
    assert.equal(assembly.reductions.some((item) => item.reason === scenario.reason), true);
    assert.equal(assembly.messages.filter((message) => message.role === 'assistant').length, 3);
    assert.equal(toolMessages.length, 3);
  }
});

test('several images in one result obey the same global newest-first budget', () => {
  const manager = new ModelWindow(new SimpleTokenEstimator(), { maxCount: 2, maxBytes: 100, maxEstimatedTokens: 10_000 });
  recordImageResult(manager, 1, [1, 2, 3].map((value) => ({ type: 'bytes', data: new Uint8Array([value]), mediaType: 'image/png' })));
  const assembly = manager.messagesFor(imageProfile);
  assert.deepEqual(assembly.messages[1].images.map((image) => image.data[0]), [2, 3]);
  assert.match(assembly.messages[1].content, /artifact-1-0/u);
});

test('context compaction keeps image tool protocol and public references while dropping active bytes', () => {
  const manager = new ModelWindow();
  recordImageResult(manager, 1, [{ type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }]);
  const reductions = manager.reduceOlderLargeToolResults({ keepLatestToolResults: 0, includeLatest: true });
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
    turnIndex: 1, toolName: 'exec_command', toolCallType: 'function',
    immediateContent: JSON.stringify({ output: 'x'.repeat(2_000) }), retainedContent: JSON.stringify({ output: 'retained' })
  });
  const reductions = manager.reduceOlderLargeToolResults({ keepLatestToolResults: 0, includeLatest: true });
  const reduction = reductions[0];
  assert.ok(reduction);
  const expected = { ...reduction };
  assert.throws(() => { reduction.afterBytes = 0; }, TypeError);
  assert.throws(() => reductions.push(reduction), TypeError);
  const assembly = assembleWindow(manager, {
    task: 'continue', instructions: [], notes: [], contextItems: [], tools: [], modelTools: [], modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 }
  });
  assert.deepEqual(assembly.reductions[0], expected);
  assert.ok(Object.isFrozen(assembly.reductions[0]));
  const checkpoint = manager.installCheckpoint();
  assert.ok(checkpoint);
  assert.ok(Object.isFrozen(checkpoint));
  assert.throws(() => { checkpoint.removedItems = 0; }, TypeError);
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

  assert.deepEqual(bundle.items.map((item) => item.sourceUri), [
    'file://a-low.ts',
    'file://z-high.ts',
    'agent-core://session/checkpoint/0'
  ]);
  assert.equal(bundle.items[0].sourceKind, 'external');
  assert.equal(bundle.items[1].integrity, 'verified');
});

test('ModelWindow exposes no repository fetching helpers and the runtime has no legacy package dependencies', async () => {
  const contextModule = await import('@agent-core/runtime');
  const packageJson = JSON.parse(await readFile(new URL('../packages/runtime/package.json', import.meta.url), 'utf8'));

  assert.equal('buildRepoMap' in contextModule, false);
  assert.equal(['Context', 'Builder'].join('') in contextModule, false);
  assert.equal(['Context', 'Trust', 'Level'].join('') in contextModule, false);
  for (const removedPackage of ['@agent-core/context', '@agent-core/core-agent', '@agent-core/project', '@agent-core/prompt', '@agent-core/run', '@agent-core/session']) {
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

  assert.equal(bundle.items.some((item) => item.sourceUri === 'file://src/parser.ts'), true);
  assert.equal(bundle.items.some((item) => item.sourceUri === 'file://package-lock.json'), true);
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
    immediateContent: '{"ok":true,"summary":"read a.txt"}',
    retainedContent: '{"ok":true,"summary":"retained read a.txt"}'
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

test('ModelWindow renders compact observedFacts without inferring reads from listed paths', () => {
  const manager = new ModelWindow();
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'list_directory',
    toolCallType: 'function',
    immediateContent: '{"ok":true}',
    retainedContent: '{"ok":true}',
    observedFacts: [
      {
        id: 'obs-list:observedFacts:1',
        observationId: 'obs-list',
        toolName: 'list_directory',
        createdAt: '2026-06-23T00:00:00.000Z',
        action: 'list',
        outcome: 'success',
        resources: [{ uri: 'rooted-file:///src/index.ts' }],
        scope: { truncated: false, confidence: 'verified' },
        summary: 'Listed src/index.ts.'
      },
      {
        id: 'obs-shell:observedFacts:1',
        observationId: 'obs-shell',
        toolName: 'exec_command',
        createdAt: '2026-06-23T00:00:00.000Z',
        action: 'execute',
        outcome: 'success',
        resources: [],
        scope: { truncated: false, confidence: 'verified' },
        summary: 'Executed ls.'
      }
    ]
  });

  const assembly = assembleWindow(manager, {
    task: 'continue',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 },
    observedFactTokenBudget: 4_000
  });

  assert.equal(assembly.prompt.observedFacts.records.length, 2);
  assert.deepEqual(assembly.prompt.observedFacts.records.map((record) => record.action), ['list', 'execute']);
  assert.equal(assembly.prompt.observedFacts.records.some((record) => record.action === 'read'), false);
  assert.equal(assembly.estimate.observedFactTokens > 0, true);
});

test('ModelWindow summarizes omitted observedFacts within the observedFacts budget', () => {
  const manager = new ModelWindow();
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'exec_command',
    toolCallType: 'function',
    immediateContent: '{"ok":true}',
    retainedContent: '{"ok":true}',
    observedFacts: [
      {
        id: 'obs-1:observedFacts:1',
        observationId: 'obs-1',
        toolName: 'exec_command',
        createdAt: '2026-06-23T00:00:00.000Z',
        action: 'execute',
        outcome: 'success',
        resources: [],
        summary: 'A'.repeat(2_000)
      },
      {
        id: 'obs-2:observedFacts:1',
        observationId: 'obs-2',
        toolName: 'exec_command',
        createdAt: '2026-06-23T00:00:01.000Z',
        action: 'execute',
        outcome: 'success',
        resources: [],
        summary: 'B'.repeat(2_000)
      },
      {
        id: 'obs-3:observedFacts:1',
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

  const observedFacts = manager.selectObservedFacts(120);

  assert.equal(observedFacts.records.length, 0);
  assert.equal(observedFacts.omittedRecords, 3);
  assert.deepEqual(observedFacts.omittedSummary, [
    { toolName: 'exec_command', action: 'execute', outcome: 'success', count: 2 },
    { toolName: 'apply_patch', action: 'update', outcome: 'failure', count: 1 }
  ]);
  assert.equal(observedFacts.tokenEstimate <= 120, true);
  assert.equal(observedFacts.coverage, 'partial');
});

test('ModelWindow checkpoints old pairs instead of replaying executable placeholders', () => {
  const manager = new ModelWindow();
  manager.recordModelOutput({
    turnIndex: 1,
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        name: 'exec_command',
        input: { kind: 'json', value: { command: 'printf large' } }
      }
    ]
  });
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'exec_command',
    toolCallType: 'function',
    callId: 'call-1',
    immediateContent: '{"ok":true,"summary":"large output immediate","results":{"stdout":"large output"}}',
    retainedContent: '{"ok":true,"summary":"large output retained"}',
    observedFacts: [{
      id: 'obs-shell:observedFacts:1',
      observationId: 'obs-shell',
      toolName: 'exec_command',
      createdAt: '2026-06-24T00:00:00.000Z',
      action: 'execute',
      outcome: 'success',
      resources: [],
      summary: 'Executed command.'
    }]
  });

  const checkpoint = manager.installCheckpoint();
  assert.ok(checkpoint);
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

  assert.equal(assembly.windowMessages.length, 0);
  assert.equal(assembly.prompt.continuity.length, 1);
  assert.match(assembly.prompt.continuity[0], /reference-only continuity data/);
  assert.match(assembly.prompt.continuity[0], /Compacted observations/);
  assert.match(assembly.prompt.continuity[0], /exec_command ok: large output retained/);
  assert.match(assembly.prompt.continuity[0], /Observed facts summary/);
  assert.match(assembly.prompt.continuity[0], /exec_command execute success: 1/);
  assert.equal(assembly.windowMessages.some((message) => message.role === 'assistant' && message.toolCalls), false);
  assert.doesNotMatch(assembly.prompt.continuity[0], /\[omitted large tool call string/);
});

test('ModelWindow preserves recent exact pairs while reducing and checkpointing shell-heavy history', () => {
  const manager = new ModelWindow();
  for (let index = 1; index <= 8; index += 1) {
    manager.recordModelOutput({
      turnIndex: index,
      content: `visible assistant turnIndex ${index}`,
      toolCalls: [
        {
          id: `call-${index}`,
          type: 'function',
          name: 'exec_command',
          input: { kind: 'json', value: { command: `printf turnIndex-${index}` } }
        }
      ]
    });
    manager.recordToolResult({
      turnIndex: index,
      toolName: 'exec_command',
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
      observedFacts: [{
        id: `obs-${index}:observedFacts:1`,
        observationId: `obs-${index}`,
        toolName: 'exec_command',
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

  const assembly = assembleWindow(manager, {
    task: 'continue',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 },
    observedFactTokenBudget: 120
  });
  const toolMessages = assembly.windowMessages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 8);
  assert.match(toolMessages.find((message) => message.toolCallId === 'call-1').content, /retained turnIndex 1/);
  assert.doesNotMatch(toolMessages.find((message) => message.toolCallId === 'call-1').content, /x{100}/);
  assert.match(toolMessages.find((message) => message.toolCallId === 'call-7').content, /immediate turnIndex 7/);
  assert.match(toolMessages.find((message) => message.toolCallId === 'call-8').content, /immediate turnIndex 8/);
  assert.equal(assembly.prompt.observedFacts.omittedSummary.some((item) => item.toolName === 'exec_command' && item.action === 'execute'), true);

  const checkpoint = manager.installCheckpoint();
  assert.ok(checkpoint);
  const checkpointAssembly = assembleWindow(manager, {
    task: 'continue after checkpoint',
    instructions: [],
    notes: [],
    contextItems: [],
    tools: [],
    modelTools: [],
    modelProfile,
    requestWindow: { contextWindowTokens: 20_000, maxPromptTokens: 16_000, maxOutputTokens: 4_000 },
    observedFactTokenBudget: 120
  });
  assert.equal(checkpointAssembly.windowMessages.length, 0);
  assert.equal(checkpointAssembly.prompt.continuity.length, 1);
  assert.match(checkpointAssembly.prompt.continuity[0], /reference-only continuity data/);
  assert.match(checkpointAssembly.prompt.continuity[0], /turnIndex 8 assistant: visible assistant turnIndex 8/);
  assert.match(checkpointAssembly.prompt.continuity[0], /exec_command execute success: 8/);
  assert.doesNotMatch(checkpointAssembly.prompt.continuity[0], /"toolCalls"/);
  assert.doesNotMatch(checkpointAssembly.prompt.continuity[0], /function_call_output/);
});

test('ModelWindow does not compact an existing checkpoint into a weaker checkpoint', () => {
  const manager = new ModelWindow();
  manager.recordModelOutput({
    turnIndex: 1,
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        name: 'exec_command',
        input: { kind: 'json', value: { command: 'printf retained' } }
      }
    ]
  });
  manager.recordToolResult({
    turnIndex: 1,
    toolName: 'exec_command',
    toolCallType: 'function',
    callId: 'call-1',
    immediateContent: '{"ok":true,"summary":"large output immediate"}',
    retainedContent: '{"ok":true,"summary":"large output retained"}'
  });

  const first = manager.installCheckpoint();
  assert.ok(first);
  const checkpointText = assembleWindow(manager, {
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

  assert.equal(assembly.prompt.continuity.length, 1);
  assert.equal(assembly.prompt.continuity[0], checkpointText);
  assert.match(assembly.prompt.continuity[0], /exec_command ok: large output retained/);
  assert.doesNotMatch(assembly.prompt.continuity[0], /Removed active history items: 1/);
});
