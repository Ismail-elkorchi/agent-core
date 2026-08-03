import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRuntime, agentEventCodec } from '@agent-core/runtime';
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/evidence';
import { InMemorySessionRepository } from '@agent-core/runtime';
import {
  applyPatchTool,
  listDirectoryTreeTool,
  readTextFilesTool,
  searchFileTextTool,
  shellCommandTool,
  ShellRunner
} from '@agent-core/tools-local';

const tools = [listDirectoryTreeTool, readTextFilesTool, searchFileTextTool, applyPatchTool, shellCommandTool];
const toolCalls = [
  call('list', 'list_directory_tree', {}),
  call('read', 'read_text_files', { files: [{ path: 'note.txt' }] }),
  call('search', 'search_file_text', { query: 'alpha', resultMode: 'matches' }),
  call('patch', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: note.txt\n@@\n-alpha\n+beta\n*** End Patch' }),
  call('shell', 'shell_command', { command: 'test -f note.txt && printf shell-ok', workdir: '.' })
];

test('scripted self-hosting run survives approvals, restart, verification, session reopen, and one terminal commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-self-host-'));
  await writeFile(path.join(root, 'AGENTS.md'), '# Local rules\nUse structured tools and verify the result.\n');
  await writeFile(path.join(root, 'note.txt'), 'alpha\n');

  const provider = new ScriptedProvider([
    response('tool_calls', '', { toolCalls }),
    response('stop', 'Changed note.txt from alpha to beta and verified the workspace.')
  ]);
  const events = new InMemoryEventRepository(agentEventCodec);
  const sessions = new InMemorySessionRepository();
  const artifacts = new InMemoryArtifactRepository();
  const session = await sessions.create({ id: 'self-host', workspaceRoot: root, provider: 'scripted', model: 'scripted' });
  const shellRunner = new ShellRunner({ artifactStore: artifacts });
  const authorizationRequests = [];
  const verificationContexts = [];
  const options = {
    provider,
    model: 'scripted',
    toolBoundary: { authorizationPolicyId: 'tests/self-host-policy@1', executionTargetId: root },
    repositories: { events, session: { repository: sessions, sessionId: session.id }, artifacts },
    instructions: [{ id: 'root-agents', content: await readFile(path.join(root, 'AGENTS.md'), 'utf8'), role: 'workspace', sourceUri: 'file:AGENTS.md' }],
    tools,
    toolPolicy: { allowedRisks: ['read', 'write', 'execute'] },
    toolContext: { services: { workspaceRoot: root, shellRunner, patchTransactionDirectory: path.join(root, '.agent-core', 'transactions', 'patch') } },
    toolAuthorizer(request) {
      authorizationRequests.push(request);
      return request.tool.risk === 'write' || request.tool.risk === 'execute'
        ? { decision: 'require_approval', reason: `Self-host policy requires approval for ${request.tool.risk}.` }
        : { decision: 'allow', reason: 'Read-only structured operation.' };
    },
    checks: [{
      id: 'workspace-result',
      requirement: 'required',
      async run(context) {
        verificationContexts.push(context);
        const content = await readFile(path.join(root, 'note.txt'), 'utf8');
        return content === 'beta\n' && context.candidate.message.includes('verified')
          ? { verdict: 'passed', summary: 'Structured edit and candidate are consistent.' }
          : { verdict: 'failed', summary: 'Workspace or candidate is inconsistent.' };
      }
    }]
  };

  const first = await new AgentRuntime(options).run({ task: 'Use every local coding tool to change alpha to beta.' });
  assert.equal(first.state, 'suspended');
  assert.deepEqual(first.pendingApprovals.map((approval) => approval.toolName), ['apply_patch', 'shell_command']);
  assert.equal((await sessions.open(session.id)).id, session.id, 'session reopens at the durable approval boundary');

  const patchApproval = first.pendingApprovals[0];
  const afterPatchApproval = await new AgentRuntime(options).resolveApproval({
    runId: first.runId,
    approvalId: patchApproval.approvalId,
    fingerprint: patchApproval.fingerprint,
    decision: 'allow'
  });
  assert.equal(afterPatchApproval.state, 'suspended');
  assert.deepEqual(afterPatchApproval.pendingApprovals.map((approval) => approval.toolName), ['shell_command']);

  const shellApproval = afterPatchApproval.pendingApprovals[0];
  const terminal = await new AgentRuntime(options).resolveApproval({
    runId: first.runId,
    approvalId: shellApproval.approvalId,
    fingerprint: shellApproval.fingerprint,
    decision: 'allow'
  });
  assert.equal(terminal.state, 'ended');
  const snapshot = terminal.terminal;
  assert.equal(snapshot.executionStatus, 'completed');
  assert.equal(snapshot.verificationStatus, 'passed');
  assert.equal(snapshot.candidate.status, 'complete');
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'beta\n');

  assert.deepEqual(authorizationRequests.map((request) => request.tool.name), [
    ...tools.map((tool) => tool.name),
    ...tools.map((tool) => tool.name)
  ], 'resuming the first approval re-evaluates the complete pending batch against current authorization');
  assert.deepEqual(authorizationRequests[1].input.files.map((file) => file.path), ['note.txt']);
  assert.deepEqual(authorizationRequests[6].input.files.map((file) => file.path), ['note.txt']);
  assert.deepEqual(first.pendingApprovals[0].effects.resourceScopes, ['workspace/files/note.txt']);
  assert.equal(verificationContexts.length, 1);
  assert.deepEqual(verificationContexts[0].instructions.map((instruction) => instruction.provenance), ['application']);
  assert.equal(verificationContexts[0].instructions[0].sourceUri, 'file:AGENTS.md');

  const replay = await sessions.loadReplayState(session.id);
  assert.equal(replay.branch.filter((entry) => entry.type === 'observation').length, 5);
  assert.equal(replay.terminalProjections.length, 1);
  assert.equal(replay.terminalProjections[0].terminal.finalizationId, snapshot.finalizationId);
  const ledger = [];
  for await (const envelope of events.read(first.runId)) ledger.push(envelope.event);
  assert.equal(ledger.filter((event) => event.type === 'run.ended').length, 1);
  assert.equal(ledger.filter((event) => event.type === 'approval.requested').length, 2);
  assert.equal(ledger.filter((event) => event.type === 'approval.resolved').length, 2);
  assert.deepEqual(ledger.filter((event) => event.type === 'tool.ended').map((event) => event.toolName), tools.map((tool) => tool.name));
});

class ScriptedProvider {
  id = 'scripted';
  constructor(script) { this.script = [...script]; }
  describe() { return { id: this.id, displayName: 'Scripted self-host provider', defaultModel: 'scripted' }; }
  async describeModel() {
    return {
      id: 'scripted',
      provider: this.id,
      capabilities: {
        streaming: false,
        toolCalling: true,
        supportedToolInputs: [{ kind: 'json' }, { kind: 'text' }, { kind: 'grammar', syntax: 'lark' }],
        jsonMode: false,
        jsonSchema: false,
        logprobs: false,
        temperature: false,
        topP: false,
        reasoning: undefined
      },
      modalities: { input: ['text'], output: ['text'] },
      limits: { contextTokens: 64_000, outputTokens: 4_000 },
      supportedParameters: ['tools', 'maxOutputTokens']
    };
  }
  async complete(request) {
    const next = this.script.shift();
    if (!next) throw new Error('Scripted provider was called after its script ended.');
    return { ...next, model: request.model, provider: this.id };
  }
}

function call(id, name, value) { return { id, type: 'function', name, input: { kind: 'json', value } }; }
function response(terminationReason, content, extra = {}) { return { content, model: 'scripted', provider: 'scripted', terminationReason, ...extra }; }
