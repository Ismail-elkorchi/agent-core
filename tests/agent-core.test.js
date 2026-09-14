import { InferenceService, InMemoryInferenceRepository } from '@agent-core/runtime';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AgentRuntime,
  resolveToolObservation,
  resolveToolModelContent,
  AgentRunCoordinator,
  pendingToolCalls,
  assertToolTransitionBoundary,
  AgentRunRecords,
  AgentFinalizationError,
  AgentRunFinalizer,
  applyAgentRunStateTransition,
  agentEventCodec,
  decodeAgentEvent,
  readCommittedTerminal
} from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/persistence';
import { ModelProviderError } from '@agent-core/model';
import * as z from 'zod';
import { decodeAgentTerminalSnapshot } from '@agent-core/runtime';
import { InMemorySessionRepository } from '@agent-core/runtime';
import { adoptToolDefinition } from '@agent-core/tools';

const capabilities = {
  streaming: false,
  toolCalling: true,
  supportedToolInputs: [{ kind: 'json' }],
  jsonMode: false,
  jsonSchema: false,
  logprobs: false,
  temperature: true,
  topP: true,
  reasoning: undefined
};
const toolBoundary = {
  authorizationPolicyId: 'tests/agent-core-policy@1',
  executionTargetId: 'tests/agent-core-target'
};
const emptyOutputSchema = z.strictObject({});
const readEnvelope = { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] };
const readEffects = { ...readEnvelope, recovery: { kind: 'unknown' } };
const completeScope = { resources: ['memory'], coverage: 'complete' };
const SESSION_BINDING = Object.freeze({
  schemaId: 'agent-core.tests/runtime',
  schemaVersion: 1,
  subject: Object.freeze({ application: 'agent-core-tests' })
});

function ended(result) {
  assert.equal(result.state, 'ended', JSON.stringify(result));
  return { ...result.terminal, deliveryDiagnostics: result.deliveryDiagnostics };
}

function profile(model = 'scripted', overrides = {}) {
  return {
    id: model,
    provider: 'scripted',
    capabilities: { ...capabilities, ...(overrides.capabilities ?? {}) },
    modalities: { input: ['text'], output: ['text'] },
    limits: { contextTokens: 16_000, outputTokens: 2_000 },
    supportedParameters: ['temperature', 'maxOutputTokens'],
    ...overrides
  };
}

function response(terminationReason = 'stop', content = 'done', extra = {}) {
  return { content, model: 'scripted', provider: 'scripted', terminationReason, ...extra };
}

class ScriptedProvider {
  id = 'scripted';
  implementationId = 'agent-core.tests.scripted-provider@1';
  calls = [];
  constructor(script, options = {}) {
    this.script = [...script];
    this.options = options;
  }
  describe() {
    return { id: this.id, displayName: 'Scripted', defaultModel: 'scripted' };
  }
  async describeModel(model) {
    return profile(
      model,
      typeof this.options.profile === 'function'
        ? this.options.profile(model)
        : (this.options.profile ?? {})
    );
  }
  async complete(request) {
    this.calls.push(request);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(request);
    return { ...next, model: request.model };
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// A reopened runtime retains the same owner records and original artifacts as its run ledger.
const runtimeRepositories = new WeakMap();
function createRuntime(options) {
  const events = options.repositories.events;
  let shared = runtimeRepositories.get(events);
  if (!shared) {
    shared = {
      inference: new InMemoryInferenceRepository(),
      artifacts: options.repositories.artifacts ?? new InMemoryArtifactRepository()
    };
    runtimeRepositories.set(events, shared);
  }
  const artifacts = options.repositories.artifacts ?? shared.artifacts;
  return new AgentRuntime({
    ...options,
    inferenceService: new InferenceService({
      provider: options.provider,
      repository: shared.inference,
      artifacts
    })
  });
}

async function harness(options = {}) {
  const events = options.events ?? new InMemoryEventRepository(agentEventCodec);
  const sessions = options.sessions ?? new InMemorySessionRepository();
  const session = options.withoutSession
    ? undefined
    : await sessions.create({ provider: 'scripted', model: 'scripted', binding: SESSION_BINDING });
  const artifacts = options.artifacts ?? new InMemoryArtifactRepository();
  const provider = options.provider ?? new ScriptedProvider(options.script ?? [response()]);
  const agent = createRuntime({
    provider,
    model: options.model ?? 'scripted',
    toolBoundary: options.toolBoundary ?? toolBoundary,
    repositories: {
      events,
      ...(session ? { session: { repository: sessions, descriptor: session } } : {}),
      artifacts
    },
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.tools ? { tools: options.tools.map(adoptToolDefinition) } : {}),
    ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
    ...(options.toolAuthorizer ? { toolAuthorizer: options.toolAuthorizer } : {}),
    ...(options.toolContext ? { toolContext: options.toolContext } : {}),
    ...(options.contextItems ? { contextItems: options.contextItems } : {}),
    ...(options.contextProvider ? { contextProvider: options.contextProvider } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.clock ? { clock: options.clock } : {})
  });
  return { agent, provider, events, sessions, session, artifacts };
}

test('runtime exposes artifact and image tools only with the required repository and model modality', async () => {
  const conditionalTool = (name) => ({
    name,
    implementationId: `tests/${name}@1`,
    description: name,
    jsonSchema: { type: 'object' },
    outputSchema: emptyOutputSchema,
    requirements:
      name === 'view_image'
        ? { services: ['artifactRepository'], modelInputModalities: ['image'] }
        : { services: ['artifactRepository'] },
    effectEnvelope: readEnvelope,
    decodeInput() {
      return { ok: true, input: {} };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return readEffects;
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          return { kind: 'result', output: {}, summary: 'ok', scope: completeScope };
        }
      };
    }
  });
  const tools = [conditionalTool('read_artifact'), conditionalTool('view_image')].map(
    adoptToolDefinition
  );

  const textProvider = new ScriptedProvider([response()]);
  const textAgent = createRuntime({
    provider: textProvider,
    model: 'scripted',
    toolBoundary,
    repositories: { events: new InMemoryEventRepository(agentEventCodec) },
    tools,
    toolPolicy: { allowedRisks: ['read'] }
  });
  await textAgent.run({ task: 'text only' }).result;
  assert.deepEqual((textProvider.calls[0].tools ?? []).map(modelToolName), []);

  const imageProvider = new ScriptedProvider([response()], {
    profile: { modalities: { input: ['text', 'image'], output: ['text'] } }
  });
  const imageArtifacts = new InMemoryArtifactRepository();
  const imageAgent = createRuntime({
    provider: imageProvider,
    model: 'scripted',
    toolBoundary,
    repositories: {
      events: new InMemoryEventRepository(agentEventCodec),
      artifacts: imageArtifacts
    },
    tools,
    toolPolicy: { allowedRisks: ['read'] }
  });
  await imageAgent.run({ task: 'image capable' }).result;
  assert.deepEqual((imageProvider.calls[0].tools ?? []).map(modelToolName), [
    'read_artifact',
    'view_image'
  ]);
});

function modelToolName(tool) {
  return tool.type === 'function' ? tool.function.name : tool.name;
}

test('tool progress from planning and invocation remains separate from the final observation', async () => {
  const progress = [];
  const tool = adoptToolDefinition({
    name: 'progress_tool',
    implementationId: 'tests/progress-tool@1',
    description: 'progress',
    jsonSchema: { type: 'object' },
    outputSchema: emptyOutputSchema,
    effectEnvelope: readEnvelope,
    decodeInput() {
      return { ok: true, input: {} };
    },
    async canonicalizeInput(input, context) {
      await context.emitProgress?.({ type: 'status', stage: 'canonicalize' });
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return readEffects;
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke(context) {
          await context.emitProgress?.({ type: 'status', stage: 'invoke' });
          return { kind: 'result', output: {}, summary: 'done', scope: completeScope };
        }
      };
    }
  });
  const { agent, events } = await harness({
    tools: [tool],
    script: [
      response('tool_calls', '', {
        toolCalls: [
          { id: 'progress', type: 'function', name: tool.name, input: { kind: 'json', value: {} } }
        ]
      }),
      response()
    ],
    onProgress(event) {
      if (event.type === 'tool.updated' && event.progress.type === 'status')
        progress.push(event.progress.stage);
    }
  });
  const result = ended(await agent.run({ task: 'report progress' }).result);
  assert.deepEqual(
    progress.filter((stage) => stage === 'canonicalize' || stage === 'invoke'),
    ['canonicalize', 'invoke']
  );
  const persisted = await eventsFor(events, result.runId);
  assert.deepEqual(
    persisted
      .filter((event) => event.type === 'tool.updated' && event.progress.type === 'status')
      .map((event) => event.progress.stage)
      .filter((stage) => stage === 'canonicalize' || stage === 'invoke'),
    []
  );
  assert.equal(persisted.filter((event) => event.type === 'tool.ended').length, 1);
});

test('oversized tool observations keep domain output intact in an artifact', async () => {
  const items = Array.from({ length: 2_000 }, (_unused, index) => ({
    id: index,
    value: `item-${String(index)}-${'x'.repeat(150)}`
  }));
  const tool = adoptToolDefinition({
    name: 'large_result',
    implementationId: 'tests/large-result@1',
    description: 'large result',
    jsonSchema: { type: 'object' },
    outputSchema: z.strictObject({
      items: z.array(z.strictObject({ id: z.int(), value: z.string() }))
    }),
    effectEnvelope: readEnvelope,
    decodeInput() {
      return { ok: true, input: {} };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return readEffects;
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          return {
            kind: 'result',

            output: { items },
            summary: 'large result complete',
            scope: completeScope
          };
        }
      };
    }
  });
  const { agent, events, artifacts } = await harness({
    tools: [tool],
    provider: new ScriptedProvider(
      [
        response('tool_calls', '', {
          toolCalls: [
            { id: 'large', type: 'function', name: tool.name, input: { kind: 'json', value: {} } }
          ]
        }),
        response()
      ],
      { profile: { limits: { contextTokens: 500000, outputTokens: 2000 } } }
    )
  });
  const result = ended(await agent.run({ task: 'preserve output' }).result);
  const persistedEvents = await eventsFor(events, result.runId);
  const observationEvent = persistedEvents.find(
    (event) => event.type === 'observation.record.created'
  );
  assert.ok(
    observationEvent,
    JSON.stringify({ types: persistedEvents.map((event) => event.type), terminal: result })
  );
  assert.equal(observationEvent.summary, 'large result complete');
  const originalEvent = persistedEvents.find((event) => event.type === 'tool.ended');
  const stored = await resolveToolObservation(originalEvent.observation, artifacts);
  assert.equal(stored.output.items.length, items.length);
  assert.ok((await resolveToolModelContent(observationEvent, artifacts)).length > 0);
});

test('artifact-store failure after a completed tool effect still persists tool.ended and a degraded diagnostic', async () => {
  class FailingArtifacts extends InMemoryArtifactRepository {
    async store() {
      throw new Error('artifact store failed');
    }
  }
  let effects = 0;
  const tool = {
    name: 'degraded_result',
    implementationId: 'tests/degraded-result@1',
    description: 'degraded result',
    jsonSchema: { type: 'object' },
    outputSchema: z.strictObject({ payload: z.string() }),
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'memory' }], lockScopes: ['memory'] },
    decodeInput() {
      return { ok: true, input: {} };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return {
        accesses: [{ mode: 'write', scope: 'memory' }],
        lockScopes: ['memory'],
        recovery: { kind: 'unknown' }
      };
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          effects += 1;
          return {
            kind: 'result',

            output: { payload: 'x'.repeat(400_000) },
            summary: 'effect completed',
            scope: completeScope
          };
        }
      };
    }
  };
  const { agent, events } = await harness({
    artifacts: new FailingArtifacts(),
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    script: [
      response('tool_calls', '', {
        toolCalls: [
          { id: 'degraded', type: 'function', name: tool.name, input: { kind: 'json', value: {} } }
        ]
      }),
      response()
    ]
  });
  const result = ended(
    await agent.run({ task: 'complete despite degraded artifact storage' }).result
  );
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(effects, 1);
  const persisted = await eventsFor(events, result.runId);
  assert.equal(persisted.filter((event) => event.type === 'tool.started').length, 1);
  assert.equal(persisted.filter((event) => event.type === 'tool.ended').length, 1);
  const diagnostic = persisted.find(
    (event) => event.type === 'observation.record.created'
  ).durableStorageDegraded;
  assert.match(diagnostic.message, /artifact store failed/u);
  assert.equal(
    persisted.find((event) => event.type === 'tool.ended').observation.storage,
    'unavailable'
  );
});

test('image and presenter assembly failures happen after durable tool truth and preserve protocol pairing', async () => {
  const missingImage = {
    visibility: 'public',
    artifactId: 'missing-image',
    sha256: '0'.repeat(64),
    size: 4,
    mediaType: 'image/png'
  };
  class IntegrityFailingArtifacts extends InMemoryArtifactRepository {
    async readVerified(ref) {
      if (!ref.mediaType.startsWith('image/')) return super.readVerified(ref);
      throw new Error(`Artifact SHA-256 integrity failure for ${ref.artifactId}`);
    }
  }
  const integrityArtifacts = new IntegrityFailingArtifacts();
  const integrityImage = await integrityArtifacts.store({
    label: 'integrity-image',
    content: new Uint8Array([1, 2, 3, 4]),
    mediaType: 'image/png'
  });
  const cases = [
    {
      name: 'missing_image_delivery',
      profile: { modalities: { input: ['text', 'image'], output: ['text'] } },
      expected: /Unknown artifact/u,
      observation: {
        kind: 'result',

        summary: 'image effect completed',
        scope: completeScope,
        content: [{ type: 'image', artifact: missingImage, detail: 'original' }],
        output: { artifact: missingImage }
      }
    },
    {
      name: 'image_integrity_delivery',
      profile: { modalities: { input: ['text', 'image'], output: ['text'] } },
      expected: /integrity failure/u,
      artifacts: integrityArtifacts,
      observation: {
        kind: 'result',

        summary: 'image effect completed',
        scope: completeScope,
        content: [{ type: 'image', artifact: integrityImage, detail: 'original' }],
        output: { artifact: integrityImage }
      }
    }
  ];
  for (const scenario of cases) {
    let effects = 0;
    let delivered;
    const tool = {
      name: scenario.name,
      implementationId: `tests/${scenario.name}@1`,
      description: scenario.name,
      jsonSchema: { type: 'object' },
      outputSchema: z.unknown(),
      effectEnvelope: { accesses: [{ mode: 'write', scope: 'memory' }], lockScopes: ['memory'] },
      ...(scenario.profile ? { requirements: { modelInputModalities: ['image'] } } : {}),
      ...(scenario.buildModelContent ? { buildModelContent: scenario.buildModelContent } : {}),
      decodeInput() {
        return { ok: true, input: {} };
      },
      canonicalizeInput(input) {
        return input;
      },
      snapshotInput(input) {
        return input;
      },
      deriveEffects() {
        return {
          accesses: [{ mode: 'write', scope: 'memory' }],
          lockScopes: ['memory'],
          recovery: { kind: 'unknown' }
        };
      },
      bindExecution(input) {
        return {
          snapshot: this.snapshotInput(input),
          async invoke() {
            effects += 1;
            return scenario.observation;
          }
        };
      }
    };
    const provider = new ScriptedProvider(
      [
        response('tool_calls', '', {
          toolCalls: [
            {
              id: `${scenario.name}-call`,
              type: 'function',
              name: scenario.name,
              input: { kind: 'json', value: {} }
            }
          ]
        }),
        (request) => {
          delivered = request.messages.find(
            (message) => message.role === 'tool' && message.toolName === scenario.name
          );
          return response('stop', 'continued after assembly failure');
        }
      ],
      { ...(scenario.profile ? { profile: scenario.profile } : {}) }
    );
    const { agent, events } = await harness({
      provider,
      tools: [tool],
      toolPolicy: { allowedRisks: ['read', 'write'] },
      withoutSession: true,
      ...(scenario.artifacts ? { artifacts: scenario.artifacts } : {})
    });
    const result = ended(await agent.run({ task: scenario.name }).result);
    assert.equal(
      result.executionStatus,
      'completed',
      JSON.stringify({ scenario: scenario.name, result })
    );
    assert.equal(effects, 1);
    assert.ok(delivered);
    assert.match(delivered.content, /committed|unavailable|fail|missing/iu);
    const persisted = await eventsFor(events, result.runId);
    const endedIndex = persisted.findIndex((event) => event.type === 'tool.ended');
    const failedIndex = persisted.findIndex(
      (event) => event.type === 'observation.recording.failed'
    );
    assert.ok(endedIndex >= 0 && failedIndex > endedIndex);
    assert.match(persisted[failedIndex].message, scenario.expected);
    assert.equal(
      persisted.some((event) => event.type === 'observation.record.created'),
      false
    );
  }
});

test('session and observation-record assembly failures do not reclassify a completed effect', async () => {
  class FailingSessionRepository extends InMemorySessionRepository {
    async appendObservation() {
      throw new Error('session assembly failed');
    }
  }
  class FailingObservationEventRepository extends InMemoryEventRepository {
    failed = false;
    async appendConditional(runId, event, options) {
      if (event.type === 'observation.record.created' && !this.failed) {
        this.failed = true;
        throw new Error('observation event assembly failed');
      }
      return super.appendConditional(runId, event, options);
    }
  }
  const cases = [
    { sessions: new FailingSessionRepository(), expected: /session assembly failed/u },
    {
      events: new FailingObservationEventRepository(agentEventCodec),
      expected: /observation event assembly failed/u
    }
  ];
  for (const scenario of cases) {
    let effects = 0;
    const tool = {
      name: 'observation_delivery_effect',
      implementationId: 'tests/assembly-effect@1',
      description: 'assembly effect',
      jsonSchema: { type: 'object' },
      outputSchema: z.unknown(),
      effectEnvelope: { accesses: [{ mode: 'write', scope: 'memory' }], lockScopes: ['memory'] },
      decodeInput() {
        return { ok: true, input: {} };
      },
      canonicalizeInput(input) {
        return input;
      },
      snapshotInput(input) {
        return input;
      },
      deriveEffects() {
        return {
          accesses: [{ mode: 'write', scope: 'memory' }],
          lockScopes: ['memory'],
          recovery: { kind: 'unknown' }
        };
      },
      bindExecution(input) {
        return {
          snapshot: this.snapshotInput(input),
          async invoke() {
            effects += 1;
            return {
              kind: 'result',

              summary: 'effect committed',
              scope: completeScope,
              output: { done: true }
            };
          }
        };
      }
    };
    const run = await harness({
      ...scenario,
      tools: [tool],
      toolPolicy: { allowedRisks: ['read', 'write'] },
      script: [
        response('tool_calls', '', {
          toolCalls: [
            {
              id: 'assembly',
              type: 'function',
              name: tool.name,
              input: { kind: 'json', value: {} }
            }
          ]
        }),
        response()
      ]
    });
    const result = ended(await run.agent.run({ task: 'assembly failure' }).result);
    assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
    assert.equal(effects, 1);
    const persisted = await eventsFor(run.events, result.runId);
    assert.equal(persisted.filter((event) => event.type === 'tool.ended').length, 1);
    assert.match(
      persisted.find((event) => event.type === 'observation.recording.failed').message,
      scenario.expected
    );
  }
});

test('parallel tool observations commit independently while an earlier call remains pending', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const started = [deferred(), deferred(), deferred()];
  let active = 0;
  let maximumActive = 0;
  const tool = {
    name: 'parallel',
    implementationId: 'tests/parallel-settlement@1',
    description: 'controlled parallel tool',
    jsonSchema: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
      additionalProperties: false
    },
    outputSchema: z.strictObject({ index: z.int() }),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'parallel' }], lockScopes: [] },
    decodeInput(input) {
      return Number.isInteger(input.value?.index)
        ? { ok: true, input: { index: input.value.index } }
        : { ok: false, issues: [] };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects(input) {
      return {
        accesses: [{ mode: 'read', scope: `parallel/${String(input.index)}` }],
        lockScopes: [],
        recovery: { kind: 'unknown' }
      };
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          started[input.index].resolve();
          try {
            await gates[input.index].promise;
            return {
              kind: 'result',

              output: { index: input.index },
              summary: `parallel ${String(input.index)}`,
              scope: completeScope
            };
          } finally {
            active -= 1;
          }
        }
      };
    }
  };
  const calls = [0, 1, 2].map((index) => ({
    id: `parallel-${String(index)}`,
    type: 'function',
    name: tool.name,
    input: { kind: 'json', value: { index } }
  }));
  const fixture = await harness({
    tools: [tool],
    limits: { maxConcurrentToolCalls: 2 },
    script: [
      response('tool_calls', '', { toolCalls: calls }),
      response('stop', 'parallel complete')
    ]
  });
  const control = fixture.agent.run({ task: 'run independent calls' });
  await Promise.all([started[0].promise, started[1].promise]);
  let inspection = await fixture.agent.inspectRun(control.runId);
  assert.equal(inspection.state.phase.kind, 'active');
  assert.equal(inspection.state.toolBatches[0].maxConcurrency, 2);
  assert.deepEqual(
    inspection.state.toolBatches[0].callStates.map((state) => state.stage),
    ['effect_pending', 'effect_pending', 'effect_ready']
  );

  gates[1].resolve();
  await started[2].promise;
  gates[2].resolve();
  for (;;) {
    inspection = await fixture.agent.inspectRun(control.runId);
    if (
      inspection.state.phase.kind === 'active' &&
      inspection.state.toolBatches[0].callStates[1]?.stage === 'recorded' &&
      inspection.state.toolBatches[0].callStates[2]?.stage === 'recorded'
    )
      break;
    await Promise.resolve();
  }
  assert.deepEqual(
    inspection.state.toolBatches[0].callStates.map((state) => state.stage),
    ['effect_pending', 'recorded', 'recorded']
  );
  const pending = pendingToolCalls(inspection.state);
  assert.deepEqual(
    pending.map((call) => call.callId),
    ['parallel-0']
  );
  assert.equal(new Set(pending.map((call) => call.catalogRevision)).size, 1);
  assert.throws(() => assertToolTransitionBoundary(inspection.state), /exact results/);
  assert.deepEqual(
    (await eventsFor(fixture.events, control.runId))
      .filter((event) => event.type === 'observation.record.created')
      .map((event) => event.callIndex),
    [1, 2]
  );

  gates[0].resolve();
  const result = ended(await control.result);
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(maximumActive, 2);
  const events = await eventsFor(fixture.events, control.runId);
  assert.deepEqual(
    events.filter((event) => event.type === 'tool.ended').map((event) => event.callIndex),
    [1, 2, 0]
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === 'observation.record.created')
      .map((event) => event.callIndex),
    [1, 2, 0]
  );
  const settledState = (await fixture.agent.inspectRun(control.runId)).state;
  assert.deepEqual(pendingToolCalls(settledState), []);
  assert.deepEqual(settledState.toolBatches, []);
  assertToolTransitionBoundary(settledState);
});

test('parallel scheduler enforces explicit dependencies and resource conflicts without serializing unrelated calls', async () => {
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started = [deferred(), deferred(), deferred(), deferred()];
  const startOrder = [];
  const tool = {
    name: 'scheduled',
    implementationId: 'tests/parallel-scheduler@1',
    description: 'dependency scheduler fixture',
    jsonSchema: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
      additionalProperties: false
    },
    outputSchema: z.strictObject({ index: z.int() }),
    effectEnvelope: {
      accesses: [
        { mode: 'read', scope: 'scheduled' },
        { mode: 'write', scope: 'scheduled' }
      ],
      lockScopes: []
    },
    decodeInput(input) {
      return Number.isInteger(input.value?.index)
        ? { ok: true, input: { index: input.value.index } }
        : { ok: false, issues: [] };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects(input) {
      if (input.index === 0)
        return {
          accesses: [{ mode: 'write', scope: 'scheduled/a' }],
          lockScopes: [],
          recovery: { kind: 'unknown' }
        };
      if (input.index === 1 || input.index === 3)
        return {
          accesses: [{ mode: 'write', scope: 'scheduled/b' }],
          lockScopes: [],
          recovery: { kind: 'unknown' }
        };
      return {
        accesses: [{ mode: 'read', scope: 'scheduled/c' }],
        lockScopes: [],
        dependsOnCallIndices: [0],
        recovery: { kind: 'unknown' }
      };
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          startOrder.push(input.index);
          started[input.index].resolve();
          await gates[input.index].promise;
          return {
            kind: 'result',

            output: { index: input.index },
            summary: `scheduled ${String(input.index)}`,
            scope: completeScope
          };
        }
      };
    }
  };
  const calls = [0, 1, 2, 3].map((index) => ({
    id: `scheduled-${String(index)}`,
    type: 'function',
    name: tool.name,
    input: { kind: 'json', value: { index } }
  }));
  const fixture = await harness({
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    limits: { maxConcurrentToolCalls: 4 },
    script: [response('tool_calls', '', { toolCalls: calls }), response()]
  });
  const control = fixture.agent.run({ task: 'respect dependencies' });
  await Promise.all([started[0].promise, started[1].promise]);
  let inspection = await fixture.agent.inspectRun(control.runId);
  assert.equal(inspection.state.phase.kind, 'active');
  assert.deepEqual(
    inspection.state.toolBatches[0].callStates.map((state) => state.stage),
    ['effect_pending', 'effect_pending', 'effect_ready', 'effect_ready']
  );

  gates[1].resolve();
  await started[3].promise;
  inspection = await fixture.agent.inspectRun(control.runId);
  assert.equal(inspection.state.phase.kind, 'active');
  assert.equal(inspection.state.toolBatches[0].callStates[2].stage, 'effect_ready');
  gates[3].resolve();
  gates[0].resolve();
  await started[2].promise;
  gates[2].resolve();
  const result = ended(await control.result);
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.deepEqual(startOrder, [0, 1, 3, 2]);
});

test('approval waits for earlier unplanned calls and binds the revision after preceding effects', async () => {
  const readStarted = deferred();
  const readGate = deferred();
  const laterPlanned = deferred();
  let revision = 0;
  const writes = [];
  const tool = {
    name: 'revision_order',
    implementationId: 'tests/approval-order@1',
    description: 'revision-bound effects',
    jsonSchema: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] },
    outputSchema: emptyOutputSchema,
    effectEnvelope: {
      accesses: [
        { mode: 'read', scope: 'revision' },
        { mode: 'write', scope: 'revision' }
      ],
      lockScopes: []
    },
    decodeInput(input) {
      return { ok: true, input: input.value };
    },
    canonicalizeInput(input) {
      return { index: input.index, revision };
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects(input) {
      return {
        accesses: [{ mode: input.index === 0 ? 'read' : 'write', scope: 'revision' }],
        lockScopes: [],
        recovery: { kind: 'unknown' }
      };
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          if (input.index === 0) {
            readStarted.resolve();
            await readGate.promise;
          } else {
            assert.equal(input.revision, revision);
            writes.push(input.index);
            revision += 1;
          }
          return { kind: 'result', output: {}, summary: 'settled', scope: completeScope };
        }
      };
    }
  };
  const fixture = await harness({
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolAuthorizer(request) {
      if (request.input.index === 2) laterPlanned.resolve();
      return request.input.index === 0
        ? { decision: 'allow' }
        : { decision: 'require_approval', reason: 'Approve this revision.' };
    },
    script: [
      response('tool_calls', '', {
        toolCalls: [0, 1, 2].map((index) => ({
          id: `revision-${index}`,
          type: 'function',
          name: tool.name,
          input: { kind: 'json', value: { index } }
        }))
      }),
      response()
    ]
  });
  const control = fixture.agent.run({ task: 'Approve effects against their current revisions.' });
  await Promise.all([readStarted.promise, laterPlanned.promise]);
  readGate.resolve();
  let result = await control.result;
  for (const index of [1, 2]) {
    assert.equal(result.state, 'suspended', JSON.stringify(result));
    assert.equal(result.pendingApprovals.length, 1);
    const approval = result.pendingApprovals[0];
    assert.deepEqual(approval.input, { index, revision: index - 1 });
    result = await (
      await fixture.agent.resolveApproval({
        runId: result.runId,
        approvalId: approval.approvalId,
        fingerprint: approval.fingerprint,
        decision: 'allow'
      })
    ).result;
  }
  assert.equal(ended(result).executionStatus, 'completed');
  assert.deepEqual(writes, [1, 2]);
});

test('cancellation durably closes or marks every call in a parallel batch', async () => {
  const started = [deferred(), deferred()];
  const tool = {
    name: 'abort_parallel',
    implementationId: 'tests/parallel-abort@1',
    description: 'abort fixture',
    jsonSchema: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
      additionalProperties: false
    },
    outputSchema: emptyOutputSchema,
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'abort' }], lockScopes: [] },
    decodeInput(input) {
      return Number.isInteger(input.value?.index)
        ? { ok: true, input: { index: input.value.index } }
        : { ok: false, issues: [] };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects(input) {
      return {
        accesses: [{ mode: 'read', scope: `abort/${String(input.index)}` }],
        lockScopes: [],
        recovery: { kind: 'unknown' }
      };
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke(context) {
          if (input.index < 2) started[input.index].resolve();
          await new Promise((_resolve, reject) =>
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true
            })
          );
          throw new Error('unreachable');
        }
      };
    }
  };
  const calls = [0, 1, 2].map((index) => ({
    id: `abort-${String(index)}`,
    type: 'function',
    name: tool.name,
    input: { kind: 'json', value: { index } }
  }));
  const run = await harness({
    tools: [tool],
    limits: { maxConcurrentToolCalls: 2 },
    script: [response('tool_calls', '', { toolCalls: calls })]
  });
  const control = run.agent.run({ task: 'abort all calls' });
  await Promise.all(started.map((entry) => entry.promise));
  await control.abort('cancel parallel batch');
  const result = ended(await control.result);
  assert.equal(result.executionStatus, 'aborted');
  let projected;
  const transitions = [];
  for (const event of await eventsFor(run.events, control.runId)) {
    if (event.type !== 'run.state.transitioned') continue;
    projected = await applyAgentRunStateTransition(
      projected,
      event.transition,
      new AgentRunRecords(run.artifacts)
    );
    transitions.push(projected);
  }
  const cancelling = transitions.find(
    (state) => state.phase.kind === 'cancelling' && state.toolBatches.length
  );
  assert.ok(cancelling);
  assert.deepEqual(
    cancelling.toolBatches[0].callStates.map((state) => state.stage),
    ['outcome_unknown', 'outcome_unknown', 'cancelled']
  );
  assert.equal(
    cancelling.toolBatches[0].callStates.every(
      (state) =>
        state.stage !== 'ready' &&
        state.stage !== 'effect_ready' &&
        state.stage !== 'effect_pending'
    ),
    true
  );
});

async function eventsFor(repository, runId) {
  const output = [];
  for await (const record of repository.read(runId)) output.push(record.event);
  return output;
}

function toolStageKey(runId, identity, stage) {
  return `${runId}:tool:${identity.turnId}:${identity.toolBatchId}:${identity.callIndex}:attempt:${identity.toolAttempt}:${stage}`;
}

test('modelOutput mappings preserve execution, completeness, source, and verification independently', async () => {
  const cases = [
    [response('stop', 'complete'), 'completed', 'complete', 'content', 'model_completed'],
    [response('output_limit', 'partial'), 'completed', 'partial', 'content', 'model_output_limit'],
    [response('content_filter', 'filtered'), 'completed', 'partial', 'content', 'content_filtered'],
    [
      response('unknown', 'uncertain'),
      'completed',
      'indeterminate',
      'content',
      'unknown_model_termination'
    ],
    [
      response('stop', '', { reasoningSummary: 'visible summary' }),
      'failed',
      'absent',
      undefined,
      'empty_response'
    ],
    [
      response('stop', '', { reasoning: 'private only' }),
      'failed',
      'absent',
      undefined,
      'empty_response'
    ],
    [response('tool_calls', ''), 'failed', 'absent', undefined, 'malformed_response']
  ];
  for (const [modelResponse, execution, status, source, termination] of cases) {
    const { agent, events } = await harness({ script: [modelResponse], withoutSession: true });
    const result = ended(await agent.run({ task: 'map modelOutput' }).result);
    assert.equal(result.executionStatus, execution);
    assert.equal(result.modelOutput.status, status);
    if (source) assert.equal(result.modelOutput.source, source);
    assert.equal(result.terminationReason, termination);
    const assistant = (await eventsFor(events, result.runId)).find(
      (event) => event.type === 'assistant.ended'
    );
    assert.equal(assistant.modelOutput.status, status);
    if (source) assert.equal(assistant.modelOutput.source, source);
  }
});

test('stream interruption preserves an unknown provider outcome without treating partial output as settlement', async () => {
  const provider = new ScriptedProvider([], {
    profile: { capabilities: { ...capabilities, streaming: true } }
  });
  provider.createSession = () => ({
    async complete() {
      throw new Error('not used');
    },
    async *stream() {
      yield { type: 'content', content: 'part', accumulated: 'part' };
      throw new Error('socket closed');
    }
  });
  const { agent, events, sessions, session } = await harness({ provider });
  const result = await agent.run({ task: 'stream' }).result;
  assert.equal(result.state, 'suspended');
  assert.equal(result.reason, 'provider_outcome_unknown');
  const records = await eventsFor(events, result.runId);
  const interrupted = records.find((event) => event.type === 'assistant.interrupted');
  assert.equal(interrupted.content, 'part');
  assert.equal(interrupted.modelOutput.status, 'partial');
  assert.equal(interrupted.diagnostic.causeSummary.message, 'socket closed');
  const replay = await sessions.loadReplayState(session);
  const partial = replay.branch.find((entry) => entry.type === 'assistant');
  assert.equal(partial.content, 'part');
  assert.equal(partial.completeness, 'partial');
  assert.equal(partial.source.runId, result.runId);
  assert.equal(partial.turnId, interrupted.turnId);
  assert.equal(
    records.some((event) => event.type === 'provider.attempt.settled'),
    false
  );
});

test('abort at the finalization boundary wins before terminal planning', async () => {
  const controller = new AbortController();
  const { agent, events } = await harness({
    onProgress(event) {
      if (event.type === 'assistant.ended') controller.abort('cancel before terminal planning');
    }
  });
  const result = ended(
    await agent.run({ task: 'cancel at finalization boundary', signal: controller.signal }).result
  );
  assert.equal(result.executionStatus, 'aborted');
  assert.equal(result.modelOutput.status, 'partial');
  const records = await eventsFor(events, result.runId);
  const plan = records.find((event) => event.type === 'run.finalization.staged');
  const committed = records.find((event) => event.type === 'run.ended');
  assert.equal(plan.terminal.executionStatus, 'aborted');
  assert.deepEqual(plan.terminal, committed.terminal);
});

test('persisted terminal validation rejects illegal cross-field combinations', () => {
  assert.throws(
    () => decodeAgentTerminalSnapshot({ ...terminal(), verificationStatus: 'passed' }),
    /Unsupported terminal field/i
  );
  assert.throws(
    () => decodeAgentTerminalSnapshot({ ...terminal(), modelOutput: { status: 'absent' } }),
    /present modelOutput/i
  );
  assert.throws(
    () =>
      decodeAgentTerminalSnapshot({
        ...terminal(),
        terminationReason: 'model_output_limit',
        modelTerminationReason: 'output_limit'
      }),
    /modelOutput status partial/i
  );
  assert.throws(
    () =>
      decodeAgentTerminalSnapshot({
        ...terminal(),
        terminationReason: 'content_filtered',
        modelTerminationReason: 'content_filter',
        modelOutput: { ...terminal().modelOutput, status: 'indeterminate' }
      }),
    /modelOutput status partial/i
  );
  assert.throws(
    () =>
      decodeAgentTerminalSnapshot({
        ...terminal(),
        terminationReason: 'unknown_model_termination',
        modelTerminationReason: 'unknown'
      }),
    /modelOutput status indeterminate/i
  );
  assert.throws(
    () =>
      decodeAgentTerminalSnapshot({
        ...terminal(),
        modelOutput: { ...terminal().modelOutput, status: 'partial' }
      }),
    /modelOutput status complete/i
  );
  assert.throws(() => decodeAgentEvent({ type: 'obsolete.event', value: true }), /unsupported/i);
  assert.throws(
    () =>
      decodeAgentEvent({
        type: 'assistant.ended',
        turnIndex: 2,
        turnId: 'turn-2',
        requestAttempt: 1,
        content: 'x',
        modelOutput: { status: 'complete', message: 'x', source: 'content', turnIndex: 1 }
      }),
    /modelOutput turnIndex/i
  );
});

test('agent event persistence rejects hostile caller data before hashing or writing', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  let getterCalls = 0;
  const responseSummary = Object.defineProperty({}, 'getter', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('must not run');
    }
  });
  await assert.rejects(
    events.append('hostile-event', {
      type: 'model.responded',
      turnIndex: 1,
      turnId: 'turn-1',
      requestAttempt: 1,
      response: responseSummary
    }),
    /not safely serializable.*accessor/u
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(await eventsFor(events, 'hostile-event'), []);
});

test('agent event persistence accepts long model answers within the runtime output envelope', () => {
  const message = '🧠'.repeat(100_000);
  const event = decodeAgentEvent({
    type: 'assistant.ended',
    turnIndex: 1,
    turnId: 'turn-1',
    requestAttempt: 1,
    content: message,
    modelOutput: { status: 'complete', message, source: 'content', turnIndex: 1 }
  });
  assert.equal(event.content, message);
  assert.throws(
    () =>
      decodeAgentEvent({
        ...event,
        content: 'x'.repeat(1024 * 1024 + 1),
        modelOutput: {
          status: 'complete',
          message: 'x'.repeat(1024 * 1024 + 1),
          source: 'content',
          turnIndex: 1
        }
      }),
    /not safely serializable.*text_truncated/u
  );
});

test('in-memory repositories run, reopen, and replay without filesystem paths', async () => {
  const first = await harness({ script: [response('stop', 'first')] });
  const firstResult = ended(await first.agent.run({ task: 'first' }).result);
  const started = (await eventsFor(first.events, firstResult.runId)).find(
    (event) => event.type === 'run.started'
  );
  assert.equal(started.runId, firstResult.runId);
  assert.equal(started.finalizationId, firstResult.finalizationId);
  const reopened = await first.sessions.open(first.session.id, SESSION_BINDING);
  assert.equal(reopened.id, first.session.id);
  const secondProvider = new ScriptedProvider([
    (request) =>
      response(
        'stop',
        request.messages.some(
          (message) => message.role === 'user' && message.content === 'first'
        ) &&
          request.messages.some(
            (message) => message.role === 'assistant' && message.content === 'first'
          )
          ? 'replayed'
          : 'missing'
      )
  ]);
  const second = createRuntime({
    provider: secondProvider,
    model: 'scripted',
    toolBoundary,
    repositories: {
      events: first.events,
      session: { repository: first.sessions, descriptor: reopened },
      artifacts: first.artifacts
    }
  });
  const secondResult = ended(await second.run({ task: 'second' }).result);
  assert.equal(firstResult.executionStatus, 'completed');
  assert.equal(secondResult.modelOutput.message, 'replayed');
});

test('reasoning-only interruption keeps reasoning in session and event channels with an absent answer', async () => {
  const provider = new ScriptedProvider([], {
    profile: {
      capabilities: {
        ...capabilities,
        streaming: true,
        reasoning: { strategies: [], canDisable: false, separateOutput: true }
      }
    }
  });
  provider.createSession = () => ({
    async complete() {
      throw new Error('not used');
    },
    async *stream() {
      yield { type: 'reasoning', reasoning: 'private work', accumulatedReasoning: 'private work' };
      yield {
        type: 'reasoning',
        channel: 'summary',
        reasoning: 'reasoning summary',
        accumulatedReasoning: 'reasoning summary'
      };
      throw new Error('reasoning interrupted');
    }
  });
  const { agent, events, sessions, session } = await harness({ provider });
  const result = await agent.run({ task: 'reasoning only' }).result;
  assert.equal(result.state, 'suspended');
  const interrupted = (await eventsFor(events, result.runId)).find(
    (event) => event.type === 'assistant.interrupted'
  );
  assert.deepEqual(interrupted.modelOutput, { status: 'absent' });
  assert.equal(interrupted.content, '');
  assert.equal(interrupted.reasoningSummary, 'reasoning summary');
  assert.equal(interrupted.reasoning, 'private work');
  const assistant = (await sessions.loadReplayState(session)).branch.find(
    (entry) => entry.type === 'assistant'
  );
  assert.equal(assistant.content, '');
  assert.equal(assistant.completeness, 'absent');
  assert.equal(assistant.reasoningSummary, 'reasoning summary');
});

test('session replay preserves an accepted task from an interrupted run', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    provider: 'scripted',
    model: 'scripted',
    binding: SESSION_BINDING
  });
  const artifacts = new InMemoryArtifactRepository();
  const interruptedTask = 'Investigate the unfinished continuity problem.';
  await sessions.appendInput(session, { runId: 'interrupted-run', task: interruptedTask });
  await events.append('interrupted-run', {
    type: 'run.started',
    runId: 'interrupted-run',
    finalizationId: 'interrupted-finalization',
    task: interruptedTask,
    model: 'scripted',
    toolPolicy: { allowedRisks: [] }
  });
  const provider = new ScriptedProvider([
    (request) =>
      response(
        'stop',
        request.messages.some((message) => message.content.includes(interruptedTask))
          ? 'recovered interrupted task'
          : 'missing interrupted task'
      )
  ]);
  const reopened = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: { events, session: { repository: sessions, descriptor: session }, artifacts }
  });

  const result = ended(await reopened.run({ task: 'Continue after recovery.' }).result);
  assert.equal(result.modelOutput.message, 'recovered interrupted task');
});

test('model-turn limits terminate deterministically', async () => {
  const call = { id: '1', type: 'function', name: 'noop', input: { kind: 'json', value: {} } };
  const provider = new ScriptedProvider([response('tool_calls', '', { toolCalls: [call] })]);
  const noop = {
    name: 'noop',
    implementationId: 'tests/noop-model-change@1',
    description: 'noop',
    jsonSchema: { type: 'object' },
    outputSchema: emptyOutputSchema,
    effectEnvelope: readEnvelope,
    decodeInput() {
      return { ok: true, input: {} };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return readEffects;
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          return { kind: 'result', output: {}, summary: 'ok', scope: completeScope };
        }
      };
    }
  };
  const { agent } = await harness({ provider, tools: [noop], limits: { modelTurns: 1 } });
  const exhausted = ended(await agent.run({ task: 'limit' }).result);
  assert.equal(exhausted.terminationReason, 'limit_exhausted');
  assert.equal(exhausted.exhaustedLimit, 'model_turns');
});

test('provider failure preserves one durable unknown outcome without a second request', async () => {
  const provider = new ScriptedProvider([
    new ModelProviderError({
      provider: 'scripted',
      code: 'provider_unavailable',
      message: 'unknown outcome',
      retryable: true
    }),
    response()
  ]);
  const fixture = await harness({ provider, withoutSession: true });
  const result = await fixture.agent.run({ task: 'one provider attempt' }).result;
  assert.equal(result.state, 'suspended');
  assert.equal(result.reason, 'provider_outcome_unknown');
  assert.equal(provider.calls.length, 1);
  const records = await eventsFor(fixture.events, result.runId);
  assert.equal(records.filter((event) => event.type === 'model.requested').length, 1);
  assert.equal(records.filter((event) => event.type === 'provider.attempt.settled').length, 0);
  const inspection = await new AgentRunCoordinator(fixture.events, fixture.artifacts).inspect(
    result.runId
  );
  assert.equal(inspection.state.phase.kind, 'active');
  assert.equal(inspection.state.providerRequests.at(-1).stage, 'outcome_unknown');
  assert.equal(
    inspection.state.providerRequests.at(-1).effect.intent.implementationId,
    provider.implementationId
  );
  assert.deepEqual(inspection.state.providerRequests.at(-1).effect.intent.recovery, {
    kind: 'unknown'
  });
  assert.deepEqual(
    inspection.state.providerRequests
      .at(-1)
      .effect.intent.exposure.quantities.map((quantity) => quantity.unit),
    ['prompt_tokens', 'completion_tokens']
  );
  assert.ok(
    inspection.state.providerRequests
      .at(-1)
      .effect.intent.exposure.quantities.every((quantity) => quantity.amount > 0)
  );
});

test('a provider start ticket stranded by process loss becomes an exact durable abort decision', async () => {
  class InterruptedProviderStartRepository extends InMemoryEventRepository {
    interrupt = true;
    stopped = false;
    async appendConditional(runId, event, options) {
      if (this.stopped) throw new Error('simulated process stop before provider start');
      const receipt = await super.appendConditional(runId, event, options);
      if (
        this.interrupt &&
        event.type === 'run.state.transitioned' &&
        event.transition.kind === 'updated' &&
        event.transition.providerRequests?.some((entry) => entry.value.stage === 'effect_ready')
      ) {
        this.interrupt = false;
        this.stopped = true;
        throw new Error('simulated process stop before provider start');
      }
      return receipt;
    }
  }
  const events = new InterruptedProviderStartRepository(agentEventCodec);
  const provider = new ScriptedProvider([response('stop', 'must not be requested')]);
  const first = await harness({ events, provider, withoutSession: true });
  const control = first.agent.run({ task: 'strand the issued provider ticket' });
  await assert.rejects(
    control.result,
    /simulated process stop before provider start|outcome is unknown|stale_tail/u
  );
  assert.equal(provider.calls.length, 0);

  events.stopped = false;
  const resumed = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: { events }
  });
  const result = await resumed.resume(control.runId).result;
  assert.equal(result.state, 'suspended');
  assert.equal(result.reason, 'user_decision');
  assert.deepEqual(result.decisionRequest.choices, ['abort']);
  assert.equal(
    result.decisionRequest.runRevision,
    (await resumed.inspectRun(control.runId)).state.revision
  );
  assert.match(result.decisionRequest.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(provider.calls.length, 0);

  const restored = await new AgentRunCoordinator(events, first.artifacts).inspect(control.runId);
  assert.equal(restored.state.phase.kind, 'suspended');
  assert.equal(restored.state.phase.reason, 'user_decision');
  assert.deepEqual(restored.state.phase.decisionRequest, result.decisionRequest);
});

test('a persisted provider settlement resumes without issuing a duplicate request', async () => {
  class InterruptedSettlementRepository extends InMemoryEventRepository {
    interrupt = true;
    async appendConditional(runId, event, options) {
      if (
        this.interrupt &&
        event.type === 'run.state.transitioned' &&
        event.transition.kind === 'updated' &&
        event.transition.providerRequests?.some((entry) => entry.value.stage === 'settled')
      ) {
        this.interrupt = false;
        throw new Error('simulated process stop after provider settlement');
      }
      return super.appendConditional(runId, event, options);
    }
  }
  const events = new InterruptedSettlementRepository(agentEventCodec);
  const provider = new ScriptedProvider([
    response('stop', 'persisted answer'),
    response('stop', 'duplicate')
  ]);
  const first = await harness({ events, provider, withoutSession: true });
  const control = first.agent.run({ task: 'resume settled provider response' });
  await assert.rejects(control.result, /simulated process stop|unresolved started provider effect/);
  assert.equal(provider.calls.length, 1);
  const run = await new AgentRunCoordinator(events, first.artifacts).inspect(control.runId);
  assert.equal(run.state.phase.kind, 'active');
  assert.equal(run.state.providerRequests.at(-1).stage, 'effect_pending');
  const resumed = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: { events }
  });
  const result = ended(await resumed.resume(control.runId).result);
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(result.modelOutput.message, 'persisted answer');
  assert.equal(provider.calls.length, 1);
  const records = await eventsFor(events, control.runId);
  assert.equal(records.filter((event) => event.type === 'provider.attempt.settled').length, 1);
  assert.equal(records.filter((event) => event.type === 'assistant.ended').length, 1);
});

test('provider takeover never starts a second request while the previous owner may still be live', async () => {
  let releaseRequest;
  let reportStarted;
  const started = new Promise((resolve) => {
    reportStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const provider = new ScriptedProvider([
    async () => {
      reportStarted();
      await blocked;
      return response('stop', 'late response');
    },
    response('stop', 'duplicate response')
  ]);
  const first = await harness({ provider, withoutSession: true });
  const original = first.agent.run({ task: 'fence provider execution' });
  await started;
  const replacement = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: { events: first.events }
  });
  const recovered = await replacement.resume(original.runId).result;
  assert.equal(recovered.state, 'suspended');
  assert.equal(recovered.reason, 'provider_outcome_unknown');
  assert.equal(provider.calls.length, 1);
  releaseRequest();
  await assert.rejects(original.result);
  assert.equal(provider.calls.length, 1);
});

test('logical request fingerprint separates every dynamic context origin and hashes the prompt', async () => {
  const item = (id, content) => ({
    id,
    sourceUri: `memory:${id}`,
    sourceKind: 'external',
    representation: 'full',
    mediaType: 'text/plain',
    title: id,
    content,
    integrity: 'unverified',
    purpose: 'reference'
  });
  const fixture = await harness({
    withoutSession: true,
    contextItems: [item('configured', 'configured context')],
    contextProvider: () => [item('provider', 'provider context')]
  });
  const result = ended(
    await fixture.agent.run({ task: 'snapshot', contextItems: [item('run', 'run context')] }).result
  );
  const fingerprint = (await eventsFor(fixture.events, result.runId)).find(
    (event) => event.type === 'inference.request.fingerprinted'
  ).fingerprint;
  assert.deepEqual(fingerprint.configuredContextIds, ['configured']);
  assert.deepEqual(fingerprint.providerContextIds, ['provider']);
  assert.deepEqual(fingerprint.runContextIds, ['run']);
  for (const field of [
    'effectiveInstructionHash',
    'modelWindowHistoryHash',
    'modelToolSchemasHash',
    'modelWindowHash'
  ])
    assert.match(fingerprint[field], /^[a-f0-9]{64}$/);
});

test('tool planning resources release after denial, approval suspension, authorization failure, and success', async () => {
  for (const outcome of ['denied', 'approval', 'authorization_failure', 'success']) {
    let releases = 0;
    const call = {
      id: outcome,
      type: 'function',
      name: 'lifetime',
      input: { kind: 'json', value: {} }
    };
    const tool = {
      name: 'lifetime',
      implementationId: `tests/lifetime-${outcome}@1`,
      description: 'lifetime',
      jsonSchema: { type: 'object' },
      outputSchema: emptyOutputSchema,
      effectEnvelope: readEnvelope,
      decodeInput() {
        return { ok: true, input: {} };
      },
      async canonicalizeInput(input, context) {
        await context.lifetime.own({
          release() {
            releases += 1;
          }
        });
        return input;
      },
      snapshotInput(input) {
        return input;
      },
      deriveEffects() {
        return readEffects;
      },
      bindExecution(input) {
        return {
          snapshot: this.snapshotInput(input),
          async invoke() {
            return { kind: 'result', output: {}, summary: 'done', scope: completeScope };
          }
        };
      }
    };
    const run = await harness({
      script: [response('tool_calls', '', { toolCalls: [call] }), response()],
      tools: [tool],
      toolAuthorizer:
        outcome === 'denied'
          ? () => ({ decision: 'deny', reason: 'denied for test' })
          : outcome === 'approval'
            ? () => ({ decision: 'require_approval', reason: 'approve for test' })
            : outcome === 'authorization_failure'
              ? () => {
                  throw new Error('authorizer unavailable');
                }
              : () => ({ decision: 'allow' })
    });
    const result = await run.agent.run({ task: outcome }).result;
    assert.equal(result.state, outcome === 'approval' ? 'suspended' : 'ended');
    assert.equal(releases, 1, outcome);
  }
});

test('durable approval resumes after repository reopen and rejects changed policy fingerprints', async () => {
  let effects = 0;
  let preparationReleases = 0;
  const call = {
    id: 'effect-1',
    type: 'function',
    name: 'effect',
    input: { kind: 'json', value: { path: 'src/../state' } }
  };
  const tool = adoptToolDefinition({
    name: 'effect',
    implementationId: 'tests/canonical-effect@1',
    description: 'write one canonical resource',
    jsonSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    outputSchema: emptyOutputSchema,
    effectEnvelope: {
      accesses: [{ mode: 'write', scope: 'workspace' }],
      lockScopes: ['workspace']
    },
    decodeInput(input) {
      return { ok: true, input: input.value };
    },
    async canonicalizeInput(input, context) {
      await context.lifetime.own({
        release() {
          preparationReleases += 1;
        }
      });
      return { ...input, path: 'state' };
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects(input) {
      return {
        accesses: [{ mode: 'write', scope: `workspace/${input.path}` }],
        lockScopes: [`workspace/${input.path}`],
        recovery: { kind: 'unknown' }
      };
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          effects += 1;
          return {
            kind: 'result',

            output: {},
            summary: 'changed',
            scope: { resources: ['workspace/state'], coverage: 'complete' }
          };
        }
      };
    }
  });
  const provider = new ScriptedProvider([
    response('tool_calls', '', { toolCalls: [call] }),
    response('stop', 'approved')
  ]);
  const repositories = await harness({
    provider,
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolAuthorizer: (request) => {
      assert.deepEqual(request.input, { path: 'state' });
      assert.deepEqual(request.effects.accesses, [{ mode: 'write', scope: 'workspace/state' }]);
      return { decision: 'require_approval', reason: 'confirm write' };
    }
  });
  const suspended = await repositories.agent.run({ task: 'approval' }).result;
  assert.equal(suspended.state, 'suspended');
  assert.equal(effects, 0);
  assert.equal(preparationReleases, 1);
  const approval = suspended.pendingApprovals[0];

  const changedPolicy = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: {
      events: repositories.events,
      session: { repository: repositories.sessions, descriptor: repositories.session },
      artifacts: repositories.artifacts
    },
    tools: [tool],
    toolPolicy: { allowedRisks: ['read'] }
  });
  await assert.rejects(
    async () =>
      (
        await changedPolicy.resolveApproval({
          runId: suspended.runId,
          approvalId: approval.approvalId,
          fingerprint: approval.fingerprint,
          decision: 'allow'
        })
      ).result,
    /different runtime implementation or configuration/
  );
  assert.equal(preparationReleases, 1);
  assert.equal(
    (await eventsFor(repositories.events, suspended.runId)).filter(
      (event) => event.type === 'approval.resolved'
    ).length,
    0
  );

  const changedTarget = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary: { ...toolBoundary, executionTargetId: 'tests/other-target' },
    repositories: {
      events: repositories.events,
      session: { repository: repositories.sessions, descriptor: repositories.session },
      artifacts: repositories.artifacts
    },
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] }
  });
  await assert.rejects(
    async () =>
      (
        await changedTarget.resolveApproval({
          runId: suspended.runId,
          approvalId: approval.approvalId,
          fingerprint: approval.fingerprint,
          decision: 'allow'
        })
      ).result,
    /boundary changed/
  );
  assert.equal(preparationReleases, 1);

  const replacement = adoptToolDefinition({
    ...tool,
    implementationId: 'tests/canonical-effect@2'
  });
  const changedImplementation = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: {
      events: repositories.events,
      session: { repository: repositories.sessions, descriptor: repositories.session },
      artifacts: repositories.artifacts
    },
    tools: [replacement],
    toolPolicy: { allowedRisks: ['read', 'write'] }
  });
  const unavailable = await (
    await changedImplementation.resolveApproval({
      runId: suspended.runId,
      approvalId: approval.approvalId,
      fingerprint: approval.fingerprint,
      decision: 'allow'
    })
  ).result;
  assert.equal(unavailable.state, 'suspended');
  assert.equal(unavailable.reason, 'missing_implementation');
  assert.equal(preparationReleases, 1);
  assert.equal(
    (await repositories.agent.inspectRun(suspended.runId)).state.toolBatches[0].callStates[0].stage,
    'approval'
  );
  assert.deepEqual(approval.binding, {
    toolImplementationId: tool.implementationId,
    ...toolBoundary
  });

  const reopened = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: {
      events: repositories.events,
      session: { repository: repositories.sessions, descriptor: repositories.session },
      artifacts: repositories.artifacts
    },
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] }
  });
  const result = ended(
    await (
      await reopened.resolveApproval({
        runId: suspended.runId,
        approvalId: approval.approvalId,
        fingerprint: approval.fingerprint,
        decision: 'allow'
      })
    ).result
  );
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(effects, 1);
  assert.equal(preparationReleases, 3);
  const records = await eventsFor(repositories.events, result.runId);
  assert.equal(records.filter((event) => event.type === 'approval.requested').length, 1);
  assert.equal(records.filter((event) => event.type === 'approval.resolved').length, 1);
  assert.equal(records.filter((event) => event.type === 'run.ended').length, 1);
  assert.equal(
    (await repositories.sessions.open(repositories.session.id, SESSION_BINDING)).id,
    repositories.session.id
  );
});

test('current authorization is re-evaluated and may veto a stored approval', async () => {
  let effects = 0;
  const tool = adoptToolDefinition({
    name: 'effect',
    implementationId: 'tests/current-veto-effect@1',
    description: 'effect',
    jsonSchema: { type: 'object' },
    outputSchema: emptyOutputSchema,
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'state' }], lockScopes: ['state'] },
    decodeInput() {
      return { ok: true, input: {} };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return {
        accesses: [{ mode: 'write', scope: 'state' }],
        lockScopes: ['state'],
        recovery: { kind: 'unknown' }
      };
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          effects += 1;
          return {
            kind: 'result',

            output: {},
            summary: 'changed',
            scope: { resources: ['state'], coverage: 'complete' }
          };
        }
      };
    }
  });
  const provider = new ScriptedProvider([
    response('tool_calls', '', {
      toolCalls: [
        { id: 'effect', type: 'function', name: 'effect', input: { kind: 'json', value: {} } }
      ]
    }),
    response('stop', 'continued safely')
  ]);
  const first = await harness({
    provider,
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolAuthorizer: () => ({ decision: 'require_approval', reason: 'confirm' })
  });
  const suspended = await first.agent.run({ task: 'current veto' }).result;
  const approval = suspended.pendingApprovals[0];
  let currentChecks = 0;
  const reopened = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: {
      events: first.events,
      session: { repository: first.sessions, descriptor: first.session },
      artifacts: first.artifacts
    },
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolAuthorizer() {
      currentChecks += 1;
      return { decision: 'deny', reason: 'policy changed' };
    }
  });
  const result = ended(
    await (
      await reopened.resolveApproval({
        runId: suspended.runId,
        approvalId: approval.approvalId,
        fingerprint: approval.fingerprint,
        decision: 'allow'
      })
    ).result
  );
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(effects, 0);
  assert.equal(currentChecks, 1);
  const toolEnded = (await eventsFor(first.events, result.runId)).find(
    (event) => event.type === 'tool.ended'
  );
  assert.equal(toolEnded.observation.kind, 'failure');
  assert.match(toolEnded.observation.summary, /authorization denied/i);
});

test('process death after an approved effect without recovery proof remains uncertain without replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-approved-crash-'));
  const fixture = path.resolve('tests/fixtures/approval-crash.mjs');
  const initial = spawnSync(process.execPath, [fixture, 'suspend', root], { encoding: 'utf8' });
  assert.equal(initial.status, 0, initial.stderr);
  const approval = JSON.parse(initial.stdout);
  const crash = spawnSync(
    process.execPath,
    [fixture, 'crash', root, approval.runId, approval.approvalId, approval.fingerprint],
    { encoding: 'utf8' }
  );
  assert.equal(crash.status, 42, crash.stderr);
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');

  const recovered = spawnSync(
    process.execPath,
    [fixture, 'recover', root, approval.runId, approval.approvalId, approval.fingerprint],
    { encoding: 'utf8' }
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.state, 'suspended');
  assert.equal(result.reason, 'tool_outcome_unknown');
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');

  const eventRepository = new (await import('@agent-core/persistence/node')).JsonlEventRepository({
    rootDir: path.join(root, 'events'),
    codec: agentEventCodec
  });
  const records = await eventsFor(eventRepository, approval.runId);
  assert.equal(records.filter((event) => event.type === 'tool.started').length, 1);
  assert.equal(records.filter((event) => event.type === 'tool.ended').length, 0);
  assert.equal(records.filter((event) => event.type === 'run.ended').length, 0);
});

test('crashes while waiting for a lease or after acquisition but before tool.started remain safe to replay', async () => {
  const fixture = path.resolve('tests/fixtures/approval-crash.mjs');
  for (const [mode, exitStatus] of [
    ['crash_waiting_for_lease', 44],
    ['crash_before_started', 45]
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), `agent-${mode}-`));
    const initial = spawnSync(process.execPath, [fixture, 'suspend', root], { encoding: 'utf8' });
    assert.equal(initial.status, 0, initial.stderr);
    const approval = JSON.parse(initial.stdout);

    const crash = spawnSync(
      process.execPath,
      [fixture, mode, root, approval.runId, approval.approvalId, approval.fingerprint],
      { encoding: 'utf8' }
    );
    assert.equal(crash.status, exitStatus, crash.stderr);
    await assert.rejects(() => readFile(path.join(root, 'effect.txt'), 'utf8'), /ENOENT/u);

    const eventRepository = new (await import('@agent-core/persistence/node')).JsonlEventRepository(
      {
        rootDir: path.join(root, 'events'),
        codec: agentEventCodec
      }
    );
    let records = await eventsFor(eventRepository, approval.runId);
    assert.equal(records.filter((event) => event.type === 'tool.started').length, 0, mode);
    assert.equal(records.filter((event) => event.type === 'tool.ended').length, 0, mode);

    const recovered = spawnSync(
      process.execPath,
      [fixture, 'recover', root, approval.runId, approval.approvalId, approval.fingerprint],
      { encoding: 'utf8' }
    );
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).executionStatus, 'completed');
    assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');
    records = await eventsFor(eventRepository, approval.runId);
    assert.equal(records.filter((event) => event.type === 'tool.started').length, 1, mode);
    assert.equal(records.filter((event) => event.type === 'tool.ended').length, 1, mode);
  }
});

test('process death after tool completion records the durable observation without replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-completed-crash-'));
  const fixture = path.resolve('tests/fixtures/approval-crash.mjs');
  const initial = spawnSync(process.execPath, [fixture, 'suspend', root], { encoding: 'utf8' });
  assert.equal(initial.status, 0, initial.stderr);
  const approval = JSON.parse(initial.stdout);
  const crash = spawnSync(
    process.execPath,
    [fixture, 'crash_after_ended', root, approval.runId, approval.approvalId, approval.fingerprint],
    { encoding: 'utf8' }
  );
  assert.equal(crash.status, 43, crash.stderr);
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');

  const recovered = spawnSync(
    process.execPath,
    [fixture, 'recover', root, approval.runId, approval.approvalId, approval.fingerprint],
    { encoding: 'utf8' }
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');
  const eventRepository = new (await import('@agent-core/persistence/node')).JsonlEventRepository({
    rootDir: path.join(root, 'events'),
    codec: agentEventCodec
  });
  const records = await eventsFor(eventRepository, approval.runId);
  assert.equal(records.filter((event) => event.type === 'tool.ended').length, 1);
  assert.equal(records.filter((event) => event.type === 'observation.record.created').length, 1);
  const sessionRepository = new (await import('@agent-core/runtime/node')).JsonlSessionRepository({
    rootDir: path.join(root, 'sessions')
  });
  const crashSession = await sessionRepository.open('crash-recovery', SESSION_BINDING);
  const replay = await sessionRepository.loadReplayState(crashSession);
  assert.equal(
    replay.branch.filter((entry) => entry.type === 'observation' && entry.toolName === 'effect')
      .length,
    1
  );
});

test('process death after the tool audit event resumes separate observation delivery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-assembly-crash-'));
  const fixture = path.resolve('tests/fixtures/approval-crash.mjs');
  const initial = spawnSync(process.execPath, [fixture, 'suspend', root], { encoding: 'utf8' });
  assert.equal(initial.status, 0, initial.stderr);
  const approval = JSON.parse(initial.stdout);
  const crash = spawnSync(
    process.execPath,
    [
      fixture,
      'crash_before_recording',
      root,
      approval.runId,
      approval.approvalId,
      approval.fingerprint
    ],
    { encoding: 'utf8' }
  );
  assert.equal(crash.status, 47, crash.stderr);
  const recovered = spawnSync(
    process.execPath,
    [fixture, 'recover', root, approval.runId, approval.approvalId, approval.fingerprint],
    { encoding: 'utf8' }
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).executionStatus, 'completed');
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');
  const eventRepository = new (await import('@agent-core/persistence/node')).JsonlEventRepository({
    rootDir: path.join(root, 'events'),
    codec: agentEventCodec
  });
  const records = await eventsFor(eventRepository, approval.runId);
  assert.equal(records.filter((event) => event.type === 'tool.started').length, 1);
  assert.equal(records.filter((event) => event.type === 'tool.ended').length, 1);
  assert.equal(records.filter((event) => event.type === 'observation.record.created').length, 1);
});

test('interrupted preconditioned reads reexecute only while every captured version remains stable', async () => {
  const fixture = path.resolve('tests/fixtures/approval-crash.mjs');
  for (const sourceChanged of [false, true]) {
    const root = await mkdtemp(
      path.join(tmpdir(), `agent-preconditioned-${sourceChanged ? 'changed' : 'stable'}-`)
    );
    await writeFile(path.join(root, 'recovery-kind.txt'), 'preconditioned');
    await writeFile(path.join(root, 'source.txt'), 'original\n');
    const initial = spawnSync(process.execPath, [fixture, 'suspend', root], { encoding: 'utf8' });
    assert.equal(initial.status, 0, initial.stderr);
    const approval = JSON.parse(initial.stdout);
    const crash = spawnSync(
      process.execPath,
      [fixture, 'crash', root, approval.runId, approval.approvalId, approval.fingerprint],
      { encoding: 'utf8' }
    );
    assert.equal(crash.status, 42, crash.stderr);
    if (sourceChanged) await writeFile(path.join(root, 'source.txt'), 'changed\n');

    const recovered = spawnSync(
      process.execPath,
      [fixture, 'recover', root, approval.runId, approval.approvalId, approval.fingerprint],
      { encoding: 'utf8' }
    );
    assert.equal(recovered.status, 0, recovered.stderr);
    const result = JSON.parse(recovered.stdout);
    assert.equal(result.state ?? 'ended', sourceChanged ? 'suspended' : 'ended');
    if (sourceChanged) assert.equal(result.reason, 'tool_outcome_unknown');
    const eventRepository = new (await import('@agent-core/persistence/node')).JsonlEventRepository(
      {
        rootDir: path.join(root, 'events'),
        codec: agentEventCodec
      }
    );
    const records = await eventsFor(eventRepository, approval.runId);
    assert.deepEqual(
      records.filter((event) => event.type === 'tool.started').map((event) => event.toolAttempt),
      sourceChanged ? [1] : [1, 2]
    );
    assert.deepEqual(
      records.filter((event) => event.type === 'tool.ended').map((event) => event.toolAttempt),
      sourceChanged ? [] : [2]
    );
  }
});

test('an interrupted buffered mutation settles from its durable receipt without invoking again', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-buffered-recovery-'));
  await writeFile(path.join(root, 'recovery-kind.txt'), 'buffered');
  const fixture = path.resolve('tests/fixtures/approval-crash.mjs');
  const initial = spawnSync(process.execPath, [fixture, 'suspend', root], { encoding: 'utf8' });
  assert.equal(initial.status, 0, initial.stderr);
  const approval = JSON.parse(initial.stdout);
  const crash = spawnSync(
    process.execPath,
    [fixture, 'crash', root, approval.runId, approval.approvalId, approval.fingerprint],
    { encoding: 'utf8' }
  );
  assert.equal(crash.status, 42, crash.stderr);
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');

  const recovered = spawnSync(
    process.execPath,
    [fixture, 'recover', root, approval.runId, approval.approvalId, approval.fingerprint],
    { encoding: 'utf8' }
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).executionStatus, 'completed');
  assert.equal(await readFile(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');
  const eventRepository = new (await import('@agent-core/persistence/node')).JsonlEventRepository({
    rootDir: path.join(root, 'events'),
    codec: agentEventCodec
  });
  const records = await eventsFor(eventRepository, approval.runId);
  assert.deepEqual(
    records.filter((event) => event.type === 'tool.started').map((event) => event.toolAttempt),
    [1]
  );
  assert.deepEqual(
    records.filter((event) => event.type === 'tool.ended').map((event) => event.toolAttempt),
    [1]
  );
  assert.equal(records.filter((event) => event.type === 'observation.record.created').length, 1);
});

test('semantic tool audit events cannot advance authoritative per-call recovery state', async () => {
  const call = {
    id: 'effect-1',
    type: 'function',
    name: 'effect',
    input: { kind: 'json', value: {} }
  };
  const persistedCall = { id: call.id, name: call.name, input: call.input };
  const effects = {
    accesses: [{ mode: 'write', scope: 'state/effect' }],
    lockScopes: ['state/effect'],
    recovery: { kind: 'unknown' }
  };
  let invocations = 0;
  const tool = {
    name: 'effect',
    implementationId: 'tests/unknown-recovery@1',
    description: 'unknown recovery fixture',
    jsonSchema: { type: 'object' },
    outputSchema: z.unknown(),
    effectEnvelope: { accesses: effects.accesses, lockScopes: effects.lockScopes },
    decodeInput() {
      return { ok: true, input: {} };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return effects;
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke(context) {
          invocations += 1;
          assert.equal(context.invocation.toolAttempt, 1);
          return {
            kind: 'result',

            output: { retried: true },
            summary: 'must not retry',
            scope: { resources: ['state/effect'], coverage: 'complete' }
          };
        }
      };
    }
  };
  const provider = new ScriptedProvider([
    response('tool_calls', '', { toolCalls: [call] }),
    response('stop', 'after retry')
  ]);
  const run = await harness({
    provider,
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolAuthorizer: () => ({ decision: 'require_approval', reason: 'confirm' })
  });
  const suspended = await run.agent.run({ task: 'unknown recovery' }).result;
  const approval = suspended.pendingApprovals[0];
  const identity = {
    turnIndex: approval.turnIndex,
    turnId: approval.turnId,
    requestAttempt: approval.requestAttempt,
    toolBatchId: approval.toolBatchId,
    callIndex: approval.callIndex,
    callId: approval.callId,
    toolAttempt: 1
  };
  await run.events.append(
    suspended.runId,
    {
      type: 'tool.started',
      ...identity,
      toolName: tool.name,
      input: persistedCall,
      fingerprint: approval.fingerprint,
      effects
    },
    { idempotencyKey: toolStageKey(suspended.runId, identity, 'started') }
  );
  const runBeforeResolution = await run.agent.inspectRun(suspended.runId);
  assert.equal(runBeforeResolution.state.toolBatches[0].callStates[0].stage, 'approval');
  const result = ended(
    await (
      await run.agent.resolveApproval({
        runId: suspended.runId,
        approvalId: approval.approvalId,
        fingerprint: approval.fingerprint,
        decision: 'allow'
      })
    ).result
  );
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(invocations, 1);
  let records = await eventsFor(run.events, result.runId);
  assert.deepEqual(
    records.filter((event) => event.type === 'tool.started').map((event) => event.toolAttempt),
    [1]
  );
  assert.deepEqual(
    records.filter((event) => event.type === 'tool.ended').map((event) => event.toolAttempt),
    [1]
  );
  assert.equal(records.filter((event) => event.type === 'observation.record.created').length, 1);
});

test('a live stale runtime settles its exact permit while its unknown call continues to consume the durable concurrency cap', async () => {
  let releaseInvocation;
  let markInvocationStarted;
  const invocationStarted = new Promise((resolve) => {
    markInvocationStarted = resolve;
  });
  const invocationRelease = new Promise((resolve) => {
    releaseInvocation = resolve;
  });
  const invocations = [];
  const calls = [0, 1].map((index) => ({
    id: `effect-${String(index)}`,
    type: 'function',
    name: 'effect',
    input: { kind: 'json', value: { index } }
  }));
  const tool = adoptToolDefinition({
    name: 'effect',
    implementationId: 'tests/live-takeover-effect@1',
    description: 'controlled effect',
    jsonSchema: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
      additionalProperties: false
    },
    outputSchema: z.strictObject({ index: z.int() }),
    effectEnvelope: { accesses: [{ mode: 'read', scope: 'state' }], lockScopes: [] },
    decodeInput(input) {
      return Number.isInteger(input.value?.index)
        ? { ok: true, input: { index: input.value.index } }
        : { ok: false, issues: [] };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects(input) {
      return {
        accesses: [{ mode: 'read', scope: `state/effect-${String(input.index)}` }],
        lockScopes: [],
        recovery: { kind: 'unknown' }
      };
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          invocations.push(input.index);
          if (input.index === 0) {
            markInvocationStarted();
            await invocationRelease;
          }
          return {
            kind: 'result',

            output: { index: input.index },
            summary: `settled effect ${String(input.index)}`,
            scope: { resources: [`state/effect-${String(input.index)}`], coverage: 'complete' }
          };
        }
      };
    }
  });
  const provider = new ScriptedProvider([
    response('tool_calls', '', { toolCalls: calls }),
    response('stop', 'continued by replacement')
  ]);
  const first = await harness({
    provider,
    tools: [tool],
    limits: { maxConcurrentToolCalls: 1 },
    toolPolicy: { allowedRisks: ['read'] },
    toolAuthorizer: () => ({ decision: 'allow' }),
    withoutSession: true
  });
  const firstControl = first.agent.run({ task: 'live takeover' });
  await invocationStarted;
  const pending = await first.agent.inspectRun(firstControl.runId);
  assert.equal(pending.state.phase.kind, 'active');
  assert.equal(pending.state.toolBatches[0].callStates[0].stage, 'effect_pending');
  assert.equal(pending.state.toolBatches[0].callStates[1].stage, 'effect_ready');
  assert.equal(pending.state.toolBatches[0].maxConcurrency, 1);
  assert.deepEqual(pending.state.toolBatches[0].callStates[0].effect.intent.exposure, {
    quantities: [{ unit: 'tool_invocations', amount: 1 }]
  });

  const replacement = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: { events: first.events, artifacts: first.artifacts },
    tools: [tool],
    limits: { maxConcurrentToolCalls: 1 },
    toolPolicy: { allowedRisks: ['read'] },
    toolAuthorizer: () => ({ decision: 'allow' })
  });
  const waiting = await replacement.resume(firstControl.runId).result;
  assert.equal(waiting.state, 'suspended');
  assert.equal(waiting.reason, 'tool_outcome_unknown');
  assert.deepEqual(invocations, [0]);
  const unresolved = await replacement.inspectRun(firstControl.runId);
  assert.equal(unresolved.state.phase.kind, 'active');
  assert.deepEqual(
    unresolved.state.toolBatches[0].callStates.map((state) => state.stage),
    ['outcome_unknown', 'effect_ready']
  );
  releaseInvocation();
  await assert.rejects(firstControl.result, /replacement driver/u);
  const settled = await replacement.inspectRun(firstControl.runId);
  assert.equal(settled.state.phase.kind, 'active');
  assert.equal(settled.state.toolBatches[0].callStates[0].stage, 'settled');
  assert.equal(settled.state.toolBatches[0].callStates[1].stage, 'effect_ready');
  assert.deepEqual(settled.state.toolBatches[0].callStates[0].effect.settlement.exposure, {
    status: 'known',
    quantities: [{ unit: 'tool_invocations', amount: 1 }]
  });

  const completed = ended(await replacement.resume(firstControl.runId).result);
  assert.equal(completed.executionStatus, 'completed');
  assert.deepEqual(invocations, [0, 1]);
  const records = await eventsFor(first.events, firstControl.runId);
  assert.equal(records.filter((event) => event.type === 'tool.ended').length, 2);
  assert.equal(records.filter((event) => event.type === 'observation.record.created').length, 2);
});

test('consumed provider usage remains in the terminal snapshot when it crosses a limit', async () => {
  const run = await harness({
    script: [
      response('stop', 'over', {
        usage: { promptTokens: 4, completionTokens: 11, totalTokens: 15 }
      })
    ],
    limits: { completionTokens: 10 },
    withoutSession: true
  });
  const result = ended(await run.agent.run({ task: 'usage limit' }).result);
  assert.equal(result.terminationReason, 'limit_exhausted');
  assert.equal(result.exhaustedLimit, 'completion_tokens');
  assert.equal(result.budget.completionTokens, 11);
  const usage = (await eventsFor(run.events, result.runId)).find(
    (event) => event.type === 'run.ended'
  );
  assert.equal(usage.terminal.budget.completionTokens, 11);
});

test('elapsed limits use the injected monotonic clock even when the host timer fires first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const call = { id: '1', type: 'function', name: 'noop', input: { kind: 'json', value: {} } };
  const provider = new ScriptedProvider([
    (request) => {
      t.mock.timers.tick(6);
      assert.equal(
        request.signal.aborted,
        false,
        'Host scheduling cannot advance the injected run clock.'
      );
      now = 10;
      return response('tool_calls', '', { toolCalls: [call] });
    }
  ]);
  const noop = {
    name: 'noop',
    implementationId: 'tests/noop-elapsed@1',
    description: 'noop',
    jsonSchema: { type: 'object' },
    outputSchema: emptyOutputSchema,
    effectEnvelope: readEnvelope,
    decodeInput() {
      return { ok: true, input: {} };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return readEffects;
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          return { kind: 'result', output: {}, summary: 'ok', scope: completeScope };
        }
      };
    }
  };
  const run = await harness({
    provider,
    tools: [noop],
    limits: { elapsedMs: 5 },
    clock: { now: () => now },
    withoutSession: true
  });
  const result = ended(await run.agent.run({ task: 'elapsed' }).result);
  assert.equal(result.terminationReason, 'limit_exhausted');
  assert.equal(result.exhaustedLimit, 'elapsed_time');
  assert.equal(result.budget.elapsedMs, 10);
});

test('elapsed limits abort a live provider request without inventing a known outcome', async () => {
  let now = 0;
  const provider = new ScriptedProvider([
    (request) => {
      now = 21;
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true
        })
      );
    }
  ]);
  const run = await harness({
    provider,
    clock: { now: () => now },
    limits: { elapsedMs: 20 },
    withoutSession: true
  });
  const result = await run.agent.run({ task: 'stalled provider' }).result;
  assert.equal(provider.calls.length, 1);
  assert.equal(result.state, 'suspended');
  assert.equal(result.reason, 'provider_outcome_unknown');
});

test('an immediate abort is durably accepted before local execution is cancelled', async () => {
  const fixture = await harness({
    script: [
      (request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true
          })
        )
    ],
    withoutSession: true
  });
  const control = fixture.agent.run({ task: 'abort immediately' });
  await control.abort('stop before provider execution');
  const result = ended(await control.result);
  assert.equal(result.executionStatus, 'aborted');
  const inspection = await new AgentRunCoordinator(fixture.events, fixture.artifacts).inspect(
    control.runId
  );
  assert.equal(inspection.state.phase.kind, 'terminal');
  assert.equal(inspection.state.control.status, 'abort_requested');
});

test('tool planning and authorization are abortable and elapsed-deadline bounded', async () => {
  const callResponse = () =>
    response('tool_calls', '', {
      toolCalls: [
        { id: 'stall', type: 'function', name: 'stall', input: { kind: 'json', value: {} } }
      ]
    });
  const baseTool = {
    name: 'stall',
    implementationId: 'tests/stalled-boundary@1',
    description: 'stalled boundary',
    jsonSchema: { type: 'object' },
    outputSchema: emptyOutputSchema,
    effectEnvelope: readEnvelope,
    decodeInput() {
      return { ok: true, input: {} };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return readEffects;
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          return { kind: 'result', output: {}, summary: 'unexpected', scope: completeScope };
        }
      };
    }
  };
  const cases = [
    {
      name: 'canonicalizer',
      tool: {
        ...baseTool,
        canonicalizeInput() {
          return new Promise(() => {});
        }
      }
    },
    {
      name: 'effect derivation',
      tool: {
        ...baseTool,
        deriveEffects() {
          return new Promise(() => {});
        }
      }
    },
    { name: 'authorizer', tool: baseTool, toolAuthorizer: () => new Promise(() => {}) }
  ];
  for (const item of cases) {
    const controller = new AbortController();
    const run = await harness({
      script: [callResponse()],
      tools: [item.tool],
      withoutSession: true,
      ...(item.toolAuthorizer ? { toolAuthorizer: item.toolAuthorizer } : {})
    });
    setTimeout(() => controller.abort(`abort ${item.name}`), 10);
    const result = ended(
      await Promise.race([
        run.agent.run({ task: item.name, signal: controller.signal }).result,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error(`${item.name} ignored abort`)), 1_000)
        )
      ])
    );
    assert.equal(result.executionStatus, 'aborted', item.name);
  }

  const deadlineRun = await harness({
    script: [callResponse()],
    tools: [baseTool],
    toolAuthorizer: () => new Promise(() => {}),
    limits: { elapsedMs: 20 },
    withoutSession: true
  });
  const deadlineResult = ended(
    await Promise.race([
      deadlineRun.agent.run({ task: 'authorization deadline' }).result,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('authorizer ignored elapsed deadline')), 1_000)
      )
    ])
  );
  assert.equal(deadlineResult.executionStatus, 'failed');
  assert.equal(deadlineResult.terminationReason, 'limit_exhausted');
  assert.equal(deadlineResult.exhaustedLimit, 'elapsed_time');
});

test('completed tool failures with unknown recovery are not replayed automatically', async () => {
  const call = { id: '1', type: 'function', name: 'effect', input: { kind: 'json', value: {} } };
  const provider = new ScriptedProvider([
    response('tool_calls', '', { toolCalls: [call] }),
    response('stop', 'handled')
  ]);
  let invocations = 0;
  const effect = {
    name: 'effect',
    implementationId: 'tests/unknown-recovery-effect@1',
    description: 'effect',
    jsonSchema: { type: 'object' },
    outputSchema: emptyOutputSchema,
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'state' }], lockScopes: ['state'] },
    decodeInput() {
      return { ok: true, input: {} };
    },
    canonicalizeInput(input) {
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return {
        accesses: [{ mode: 'write', scope: 'state' }],
        lockScopes: ['state'],
        recovery: { kind: 'unknown' }
      };
    },
    bindExecution(input) {
      return {
        snapshot: this.snapshotInput(input),
        async invoke() {
          invocations += 1;
          return {
            kind: 'failure',

            execution: { state: 'settled' },
            output: { reason: 'runtime_error', error: 'failed' },
            summary: 'failed',
            scope: { resources: ['state'], coverage: 'partial', causes: ['failed'] }
          };
        }
      };
    }
  };
  const { agent } = await harness({
    provider,
    tools: [effect],
    toolPolicy: { allowedRisks: ['read', 'write'] }
  });
  const result = ended(await agent.run({ task: 'effect' }).result);
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(invocations, 1);
});

test('throwing terminal observer leaves one commit and records one delivery diagnostic', async () => {
  const { agent, events } = await harness({
    withoutSession: true,
    onProgress(event) {
      if (event.type === 'run.ended') throw new Error('renderer broke');
    }
  });
  const result = ended(await agent.run({ task: 'observer' }).result);
  const records = await eventsFor(events, result.runId);
  assert.equal(records.filter((event) => event.type === 'run.ended').length, 1);
  assert.equal(records.filter((event) => event.type === 'delivery.failed').length, 1);
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(result.deliveryDiagnostics.length, 1);
});

test('finalization is idempotent, rejects conflicts, and recovers faults after every write', async () => {
  const base = terminal();
  const events = new InMemoryEventRepository(agentEventCodec);
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({ binding: SESSION_BINDING });
  await sessions.appendInput(session, { runId: base.runId, task: 'finalize' });
  const finalizer = new AgentRunFinalizer({
    runId: base.runId,
    finalizationId: base.finalizationId,
    events,
    append: (event, idempotencyKey) => events.append(base.runId, event, { idempotencyKey }),
    session: { repository: sessions, descriptor: session }
  });
  const first = finalizer.finalize(base);
  assert.equal(first, finalizer.finalize(base));
  const result = ended(await first);
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.throws(
    () =>
      finalizer.finalize({ ...base, modelOutput: { ...base.modelOutput, message: 'conflict' } }),
    /Conflicting terminal decision/
  );
  assert.equal(
    (await eventsFor(events, base.runId)).filter((event) => event.type === 'run.ended').length,
    1
  );

  for (const point of ['plan', 'session', 'committed']) {
    const durableEvents = new InMemoryEventRepository(agentEventCodec);
    const durableSessions = new InMemorySessionRepository();
    const durableSession = await durableSessions.create({ binding: SESSION_BINDING });
    await durableSessions.appendInput(durableSession, { runId: base.runId, task: 'recover' });
    let thrown = false;
    const faultEvents = {
      ...durableEvents,
      append: async (runId, event, options) => {
        const record = await durableEvents.append(runId, event, options);
        if (
          !thrown &&
          ((point === 'plan' && event.type === 'run.finalization.staged') ||
            (point === 'committed' && event.type === 'run.ended'))
        ) {
          thrown = true;
          throw new Error(`fault ${point}`);
        }
        return record;
      },
      read: (runId) => durableEvents.read(runId),
      listRunIds: () => durableEvents.listRunIds(),
      verifyIntegrity: (runId) => durableEvents.verifyIntegrity(runId)
    };
    const faultSessions =
      point === 'session'
        ? {
            ...durableSessions,
            recordRunFinalization: async (sessionId, value) => {
              const assembly = await durableSessions.recordRunFinalization(sessionId, value);
              if (!thrown) {
                thrown = true;
                throw new Error('fault session');
              }
              return assembly;
            },
            loadReplayState: (sessionId, leafId) =>
              durableSessions.loadReplayState(sessionId, leafId)
          }
        : durableSessions;
    const broken = new AgentRunFinalizer({
      runId: base.runId,
      finalizationId: base.finalizationId,
      events: faultEvents,
      append: (event, idempotencyKey) => faultEvents.append(base.runId, event, { idempotencyKey }),
      session: { repository: faultSessions, descriptor: durableSession }
    });
    await assert.rejects(broken.finalize(base), (error) => {
      assert.equal(error instanceof AgentFinalizationError, true);
      assert.equal(error.progress.reconciliation, 'verified');
      assert.equal(error.progress.staged, true);
      assert.equal(error.progress.sessionRecorded, point !== 'plan');
      assert.equal(error.progress.committed, point === 'committed');
      return true;
    });
    const recovered = new AgentRunFinalizer({
      runId: base.runId,
      finalizationId: base.finalizationId,
      events: durableEvents,
      append: (event, idempotencyKey) =>
        durableEvents.append(base.runId, event, { idempotencyKey }),
      session: { repository: durableSessions, descriptor: durableSession }
    });
    await recovered.finalize(base);
    assert.deepEqual(await readCommittedTerminal(durableEvents, base.runId), base);
    assert.equal(
      (await eventsFor(durableEvents, base.runId)).filter((event) => event.type === 'run.ended')
        .length,
      1
    );
    assert.equal(
      (await durableSessions.loadReplayState(durableSession)).runFinalizations.length,
      1
    );
  }
});

function terminal() {
  return decodeAgentTerminalSnapshot({
    runId: 'run-final',
    finalizationId: 'final-1',
    phase: 'ended',
    executionStatus: 'completed',
    terminationReason: 'model_completed',
    modelTerminationReason: 'stop',
    modelOutput: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 },
    turnCount: 1,
    budget: {
      modelTurns: 1,
      totalToolCalls: 0,
      elapsedMs: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      knownCosts: {},
      pricingStatus: 'unknown',
      unknownPricedTokens: 0
    }
  });
}

test('process loss before terminal staging leaves the settled provider response available for recovery', async () => {
  const events = new InMemoryEventRepository(agentEventCodec);
  const append = events.appendConditional.bind(events);
  let interrupt = true;
  events.appendConditional = async (runId, event, options) => {
    if (interrupt && event.type === 'run.finalization.staged') {
      interrupt = false;
      throw new Error('process loss before terminal staging');
    }
    return append(runId, event, options);
  };
  const provider = new ScriptedProvider([response('stop', 'original final answer')]);
  const first = await harness({ events, provider, withoutSession: true });
  const handle = first.agent.run({ task: 'Preserve the final answer.' });
  await assert.rejects(handle.result, /process loss before terminal staging/);
  const resumed = createRuntime({
    provider,
    model: 'scripted',
    toolBoundary,
    repositories: { events, artifacts: first.artifacts }
  });
  const result = ended(await resumed.resume(handle.runId).result);
  assert.equal(provider.calls.length, 1);
  assert.equal(result.executionStatus, 'completed', JSON.stringify(result));
  assert.equal(result.modelOutput.message, 'original final answer');
  const records = await eventsFor(events, handle.runId);
  assert.equal(records.filter((event) => event.type === 'run.ended').length, 1);
});

test('runtime terminal diagnostics preserve the underlying preparation release error', async () => {
  const { defineTool } = await import('@agent-core/tools');
  const tool = defineTool({
    name: 'release_failure',
    implementationId: 'tests/release-failure@1',
    description: 'Exercises resource release.',
    schema: z.strictObject({}),
    outputSchema: emptyOutputSchema,
    effectEnvelope: readEnvelope,
    canonicalizeInput: (input) => input,
    deriveEffects: () => readEffects,
    async bindExecution(input, context) {
      await context.lifetime.own({
        release() {
          throw new Error('Cancellation has not reached terminal publication.');
        }
      });
      return {
        snapshot: input,
        async invoke() {
          return { kind: 'result', output: {}, summary: 'Observed.', scope: completeScope };
        }
      };
    }
  });
  const run = await harness({
    tools: [tool],
    script: [
      response('tool_calls', '', {
        toolCalls: [
          { id: 'release-1', type: 'function', name: tool.name, input: { kind: 'json', value: {} } }
        ]
      })
    ]
  });
  const result = await run.agent.run({ task: 'Inspect.' }).result;
  assert.equal(result.state, 'ended');
  assert.equal(result.terminal.executionStatus, 'failed');
  assert.match(result.terminal.errorMessage, /Tool lifetime resource release failed/);
  assert.match(result.terminal.errorMessage, /Cancellation has not reached terminal publication/);
  const terminal = await readCommittedTerminal(run.events, result.terminal.runId);
  assert.equal(terminal.errorMessage, result.terminal.errorMessage);
});
