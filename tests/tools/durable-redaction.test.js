import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { AgentRuntime, agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/evidence/node';
import { defineTool } from '@agent-core/tools';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, ProcessManager, execCommandTool } from '@agent-core/tools-local';

const secrets = ['tok_live_1234567890', 'bearer-secret-123456', 'password-value-789', 'environment-value-456', 'process-value-123'];
const profile = {
  id: 'scripted', provider: 'scripted', capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }], jsonMode: false, jsonSchema: false, logprobs: false, temperature: true, topP: true },
  modalities: { input: ['text'], output: ['text'] }, limits: { contextTokens: 16_000, outputTokens: 2_000 }, supportedParameters: ['tools', 'maxOutputTokens']
};
class Provider {
  id = 'scripted'; calls = 0;
  describe() { return { id: this.id, displayName: 'Scripted', defaultModel: 'scripted' }; }
  async describeModel() { return profile; }
  async complete(request) {
    this.calls += 1;
    if (this.calls > 1) return { content: 'done', provider: 'scripted', model: request.model, terminationReason: 'stop' };
    const script = "console.log('PROCESS_SECRET=' + process.env.AGENT_CORE_TEST_PROCESS_SECRET + ' Authorization: Bearer ' + process.env.AGENT_CORE_TEST_BEARER_SECRET)";
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    return {
      content: '', provider: 'scripted', model: request.model, terminationReason: 'tool_calls',
      toolCalls: [
        { id: 'secret-result', type: 'function', name: 'secret_result', input: { kind: 'json', value: {} } },
        { id: 'secret-failure', type: 'function', name: 'secret_failure', input: { kind: 'json', value: {} } },
        { id: 'secret-process', type: 'function', name: 'exec_command', input: { kind: 'json', value: { command, yieldMs: 1_000 } } }
      ]
    };
  }
}
const base = { accesses: [{ mode: 'read', scope: 'memory/secrets' }], lockScopes: [] };
const secretResult = defineTool({
  name: 'secret_result', implementationId: 'tests/secret-result@1', description: 'secret', schema: z.strictObject({}), outputSchema: z.record(z.string(), z.string()), effectEnvelope: base,
  canonicalizeInput: (input) => input, deriveEffects: () => ({ ...base, idempotency: 'pure' }),
  invoke: async () => ({ kind: 'result', ok: true, summary: 'secret output', scope: { resources: ['memory/secrets'], coverage: 'complete' }, output: { token: secrets[0], authorization: `Bearer ${secrets[1]}`, password: secrets[2], environment: `APP_SECRET=${secrets[3]}` }, metadata: { apiKey: secrets[0], nested: { password: secrets[2] } } })
});
const secretFailure = defineTool({
  name: 'secret_failure', implementationId: 'tests/secret-failure@1', description: 'secret failure', schema: z.strictObject({}), outputSchema: z.strictObject({}), effectEnvelope: base,
  canonicalizeInput: (input) => input, deriveEffects: () => ({ ...base, idempotency: 'pure' }),
  invoke: async () => ({ kind: 'failure', ok: false, summary: 'failed safely', scope: { resources: ['memory/secrets'], coverage: 'partial', causes: ['runtime_error'] }, output: { blocked: true, reason: 'runtime_error', recovery: 'retry without secrets', error: `Authorization: Bearer ${secrets[1]}`, details: { password: secrets[2], token: secrets[0] } } })
});

test('durable event and session JSONL redact tool, metadata, failure, and process secrets', async () => {
  process.env.AGENT_CORE_TEST_PROCESS_SECRET = secrets[4];
  process.env.AGENT_CORE_TEST_BEARER_SECRET = secrets[1];
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-redaction-'));
  const runsDir = path.join(root, 'runs'); const sessionsDir = path.join(root, 'sessions'); const artifactsDir = path.join(root, 'artifacts');
  await Promise.all([mkdir(runsDir), mkdir(sessionsDir), mkdir(artifactsDir)]);
  const events = new JsonlEventRepository({ rootDir: runsDir, codec: agentEventCodec });
  const sessions = new JsonlSessionRepository({ rootDir: sessionsDir });
  const session = await sessions.create({ workspaceRoot: root, provider: 'scripted', model: 'scripted' });
  const artifacts = new LocalArtifactRepository({ rootDir: artifactsDir });
  const manager = new ProcessManager({ artifactRepository: artifacts, ...DEFAULT_LOCAL_TOOL_CONFIGURATION.process });
  const agent = new AgentRuntime({
    provider: new Provider(), model: 'scripted', toolBoundary: { authorizationPolicyId: 'tests/redaction@1', executionTargetId: root },
    repositories: { events, session: { repository: sessions, sessionId: session.id }, artifacts }, tools: [secretResult, secretFailure, execCommandTool],
    toolPolicy: { allowedRisks: ['read', 'execute'] }, toolContext: { services: { workspaceRoot: root, artifactRepository: artifacts, localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION, processManager: manager } }
  });
  const result = await agent.run({ runId: 'redaction-run', task: 'redact' });
  assert.equal(result.state, 'ended');
  const durableText = `${await readFile(events.location('redaction-run'), 'utf8')}\n${await readFile(sessions.location(session.id), 'utf8')}`;
  for (const secret of secrets) assert.equal(durableText.includes(secret), false, secret);
  assert.match(durableText, /\[REDACTED\]/u);
  delete process.env.AGENT_CORE_TEST_PROCESS_SECRET;
  delete process.env.AGENT_CORE_TEST_BEARER_SECRET;
});
