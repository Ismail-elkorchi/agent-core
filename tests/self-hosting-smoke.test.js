import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRuntime, agentEventCodec, InMemorySessionRepository } from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/evidence';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  LocalCommandExecution,
  WorkspaceFileSelector,
  applyPatchTool,
  execCommandTool,
  findFilesTool,
  listDirectoryTool,
  readFilesTool,
  searchTextTool
} from '@agent-core/tools-local';
import { testPatchJournal, testWorkspaceFileRoot } from './workspace-file-root-helper.js';

const tools = [listDirectoryTool, findFilesTool, readFilesTool, searchTextTool, applyPatchTool, execCommandTool];
const binding = Object.freeze({ schemaId: 'agent-core.tests/self-hosting', schemaVersion: 1, subject: Object.freeze({ application: 'self-hosting-smoke' }) });

test('scripted self-hosting run survives approvals, structured tools, verification, and one terminal commit', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-self-host-'));
  await writeFile(path.join(root, 'note.txt'), 'alpha\n');
  const calls = [
    call('list', 'list_directory', {}),
    call('find', 'find_files', { patterns: ['*.txt'] }),
    call('read', 'read_files', { files: [{ path: 'note.txt' }] }),
    call('search', 'search_text', { query: 'alpha' }),
    call('patch', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: note.txt\n@@\n-alpha\n+beta\n*** End Patch' }),
    call('exec', 'exec_command', { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').accessSync('note.txt'); process.stdout.write('command-ok')")}`, yieldMs: 1_000 })
  ];
  const provider = new ScriptedProvider([
    response('tool_calls', '', { toolCalls: calls }),
    response('stop', 'Changed alpha to beta and verified the workspace.')
  ]);
  const events = new InMemoryEventRepository(agentEventCodec);
  const sessions = new InMemorySessionRepository();
  const artifacts = new InMemoryArtifactRepository();
  const session = await sessions.create({ id: 'self-host', provider: 'scripted', model: 'scripted', binding });
  const workspaceFileRoot = testWorkspaceFileRoot(root);
  const commandExecution = new LocalCommandExecution({
    artifactRepository: artifacts,
    workspaceFileRoot,
    maxCapturedBytes: DEFAULT_LOCAL_TOOL_CONFIGURATION.process.maxCapturedBytes,
    tailBytes: DEFAULT_LOCAL_TOOL_CONFIGURATION.process.tailBytes
  });
  const services = {
    workspaceFileRoot,
    artifactRepository: artifacts,
    localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION,
    patchJournal: testPatchJournal(workspaceFileRoot),
    commandExecution,
    workspaceFileSelector: new WorkspaceFileSelector(workspaceFileRoot, DEFAULT_LOCAL_TOOL_CONFIGURATION.fileSelection)
  };
  const options = {
    provider,
    model: 'scripted',
    toolBoundary: { authorizationPolicyId: 'tests/self-host-policy@1', executionTargetId: root },
    repositories: { events, session: { repository: sessions, descriptor: session }, artifacts },
    tools,
    toolPolicy: { allowedRisks: ['read', 'write', 'execute'] },
    toolContext: { services },
    toolAuthorizer(request) {
      return request.effects.accesses.some((access) => access.mode !== 'read')
        ? { decision: 'require_approval', reason: 'Confirm side effect.' }
        : { decision: 'allow' };
    },
    checks: [{ id: 'workspace', implementationId: 'agent-core.test.check.v1', kind: 'deterministic', requirement: 'required', async run() {
      return await readFile(path.join(root, 'note.txt'), 'utf8') === 'beta\n'
        ? { verdict: 'passed', summary: 'Workspace updated.' }
        : { verdict: 'failed', summary: 'Workspace mismatch.' };
    } }]
  };

  let result = await new AgentRuntime(options).run({ task: 'Change alpha to beta.' }).result;
  assert.equal(result.state, 'suspended');
  assert.deepEqual(result.pendingApprovals.map((approval) => approval.toolName), ['apply_patch']);
  for (;;) {
    const approval = result.pendingApprovals[0];
    result = await (await new AgentRuntime(options).resolveApproval({ runId: result.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint, decision: 'allow' })).result;
    if (result.state === 'ended') break;
  }
  const ledger = [];
  for await (const envelope of events.read(result.terminal.runId)) ledger.push(envelope.event);
  const failedObservations = ledger.filter((event) =>
    (event.type === 'tool.ended' && !event.observation.ok)
    || (event.type === 'check.ended' && event.result.verdict !== 'passed'));
  assert.equal(result.terminal.executionStatus, 'completed', failureDiagnostic(result.terminal, failedObservations));
  assert.equal(result.terminal.verificationStatus, 'passed');
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'beta\n');
  assert.equal(ledger.filter((event) => event.type === 'run.ended').length, 1);
  const endedTools = ledger.filter((event) => event.type === 'tool.ended').map((event) => event.toolName);
  assert.equal(endedTools.length, tools.length);
  assert.deepEqual(endedTools.toSorted(), tools.map((tool) => tool.name).toSorted());
});

class ScriptedProvider {
  id = 'scripted';
  implementationId = 'agent-core.tests.self-hosting-provider@1';
  constructor(script) { this.script = [...script]; }
  describe() { return { id: this.id, displayName: 'Scripted', defaultModel: 'scripted' }; }
  async describeModel() {
    return {
      id: 'scripted', provider: this.id,
      capabilities: { streaming: false, toolCalling: true, supportedToolInputs: [{ kind: 'json' }, { kind: 'text' }, { kind: 'grammar', syntax: 'lark' }], jsonMode: false, jsonSchema: false, logprobs: false, temperature: false, topP: false, reasoning: undefined },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 64_000, outputTokens: 4_000 },
      supportedParameters: ['tools', 'maxOutputTokens']
    };
  }
  async complete(request) { return { ...this.script.shift(), model: request.model, provider: this.id }; }
}

function call(id, name, value) { return { id, type: 'function', name, input: { kind: 'json', value } }; }
function response(terminationReason, content, extra = {}) { return { content, model: 'scripted', provider: 'scripted', terminationReason, ...extra }; }
function failureDiagnostic(terminal, failedObservations) {
  return `Self-hosting run failed.\nTerminal:\n${JSON.stringify(terminal, null, 2)}\nFailed observations:\n${JSON.stringify(failedObservations, null, 2)}`;
}
