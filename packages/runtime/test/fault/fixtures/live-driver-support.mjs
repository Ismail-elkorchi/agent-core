import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { JsonlEventRepository } from '@agent-core/evidence/node';
import { AgentRuntime, agentEventCodec } from '@agent-core/runtime';
import { adoptToolDefinition } from '@agent-core/tools';

const WAIT_LIMIT_MS = 10_000;

export function createLiveDriverRuntime({ root, mode, role, onCheckpoint = () => undefined }) {
  const events = new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: agentEventCodec });
  const provider = {
    id: 'live-driver-fixture',
    implementationId: 'agent-core.tests.live-driver-provider@1',
    describe() {
      return { id: this.id, displayName: 'Live driver fixture', defaultModel: 'fixture' };
    },
    async describeModel() {
      return {
        id: 'fixture',
        provider: this.id,
        modalities: { input: ['text'], output: ['text'] },
        capabilities: {
          streaming: false,
          toolCalling: true,
          supportedToolInputs: [{ kind: 'json' }],
          jsonMode: false,
          jsonSchema: false,
          logprobs: false,
          temperature: false,
          topP: false
        },
        limits: { contextTokens: 8_000, outputTokens: 1_000 },
        supportedParameters: ['maxOutputTokens']
      };
    },
    async complete(request) {
      const hasToolResult = request.messages.some((message) => message.role === 'tool');
      return hasToolResult
        ? { content: 'replacement completed', model: request.model, provider: this.id, terminationReason: 'stop' }
        : {
            content: '',
            model: request.model,
            provider: this.id,
            terminationReason: 'tool_calls',
            toolCalls: [{ id: 'live-call', type: 'function', name: 'live_effect', input: { kind: 'json', value: {} } }]
          };
    }
  };
  const observation = () => ({
    kind: 'result',
    ok: true,
    output: { value: 'one external completion' },
    summary: 'one external completion',
    scope: { resources: ['fixture/external-effect'], coverage: 'complete' }
  });
  const tool = adoptToolDefinition({
    name: 'live_effect',
    implementationId: 'agent-core.tests.live-driver-effect@1',
    description: 'A queryable effect controlled by a live-process test.',
    jsonSchema: { type: 'object', additionalProperties: false },
    outputSchema: z.strictObject({ value: z.string() }),
    effectEnvelope: { accesses: [{ mode: 'write', scope: 'fixture/external-effect' }], lockScopes: ['fixture/external-effect'] },
    decodeInput(input) {
      return input.kind === 'json' && Object.keys(input.value).length === 0
        ? { ok: true, input: {} }
        : { ok: false, issues: [{ path: [], message: 'Expected an empty object.' }] };
    },
    async canonicalizeInput(input) {
      if (role === 'old' && mode === 'before_start') await checkpoint(root, mode, onCheckpoint);
      return input;
    },
    snapshotInput(input) {
      return input;
    },
    deriveEffects() {
      return {
        accesses: [{ mode: 'write', scope: 'fixture/external-effect' }],
        lockScopes: ['fixture/external-effect'],
        recovery: {
          kind: 'queryable',
          service: 'live-driver-fixture',
          reconcilerId: 'agent-core.tests.live-driver-reconciler@1',
          externalExecutionId: 'live-external-effect',
          expiresAt: '2099-01-01T00:00:00.000Z'
        }
      };
    },
    async recover() {
      const receipt = await readFile(path.join(root, 'external-receipt.json'), 'utf8').then(JSON.parse, () => undefined);
      if (receipt?.value === 'one external completion') return { status: 'settled', observation: observation() };
      const started = await readFile(path.join(root, 'external-started'), 'utf8').then(() => true, () => false);
      return started ? { status: 'running' } : { status: 'not_found' };
    },
    async invoke() {
      await appendFile(path.join(root, 'external-invocations'), 'invoke\n');
      await writeFile(path.join(root, 'external-started'), 'started\n');
      if (role === 'old' && mode === 'inside_effect') await checkpoint(root, mode, onCheckpoint);
      await writeFile(path.join(root, 'external-receipt.json'), JSON.stringify({ value: 'one external completion' }));
      if (role === 'old' && mode === 'after_completion') await checkpoint(root, mode, onCheckpoint);
      return observation();
    }
  });
  return new AgentRuntime({
    provider,
    model: 'fixture',
    toolBoundary: {
      authorizationPolicyId: 'agent-core.tests.live-driver-policy@1',
      executionTargetId: root
    },
    repositories: { events },
    tools: [tool],
    toolPolicy: { allowedRisks: ['read', 'write'] },
    toolAuthorizer: () => ({ decision: 'allow' })
  });
}

async function checkpoint(root, mode, onCheckpoint) {
  await writeFile(path.join(root, 'old-ready'), `${mode}\n`);
  onCheckpoint(mode);
  const release = path.join(root, 'release-old');
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (Date.now() < deadline) {
    if (await readFile(release, 'utf8').then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting to release old driver at ${mode}.`);
}
