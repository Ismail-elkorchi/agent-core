import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createCliDefaultTools, createCliToolPolicy, resultExitCode } from '@agent-core/cli';
import { parseAgentTerminalSnapshot } from '@agent-core/runtime';

test('CLI exposes local coding tools and explicit risk policy', () => {
  assert.deepEqual(createCliDefaultTools().map(tool => tool.name), ['list_directory', 'find_files', 'read_files', 'search_text', 'apply_patch', 'exec_command', 'write_stdin', 'stop_process', 'view_image', 'read_artifact']);
  assert.throws(() => createCliDefaultTools(['unknown_tool']), /Unknown configured local tools/u);
  assert.deepEqual(createCliToolPolicy({ apply: true, dryRun: false, allowShell: true, allowUnsafeShell: false }).allowedRisks, ['read', 'write', 'execute']);
});

test('CLI exit codes distinguish success, candidate completeness, verification, failure, and abort', () => {
  assert.equal(resultExitCode(result()), 0);
  assert.equal(resultExitCode(result({ candidate: { status: 'partial', message: 'part', source: 'content', turnIndex: 1 }, terminationReason: 'model_output_limit', modelTerminationReason: 'output_limit' })), 2);
  assert.equal(resultExitCode(result({ verificationStatus: 'failed' })), 3);
  assert.equal(resultExitCode(result({ verificationStatus: 'inconclusive' })), 4);
  assert.equal(resultExitCode(failed()), 1);
  assert.equal(resultExitCode(aborted()), 130);
});

test('CLI binary help works through the published executable', async () => {
  const output = await run(path.resolve('packages/cli/dist/index.js'), ['--help']);
  assert.equal(output.code, 0);
  assert.match(output.stdout + output.stderr, /agent-core/i);
  assert.match(output.stdout + output.stderr, /approval <allow\|deny> <run-id> <approval-id> <fingerprint>/u);
});

function result(overrides = {}) { return { state: 'ended', terminal: parseAgentTerminalSnapshot({ ...base(), ...overrides }), deliveryDiagnostics: [] }; }
function failed() { return { state: 'ended', terminal: parseAgentTerminalSnapshot({ ...base(), executionStatus: 'failed', verificationStatus: 'not_run', terminationReason: 'runtime_error', errorMessage: 'failed', candidate: { status: 'absent' }, modelTerminationReason: undefined }), deliveryDiagnostics: [] }; }
function aborted() { return { state: 'ended', terminal: parseAgentTerminalSnapshot({ ...base(), executionStatus: 'aborted', verificationStatus: 'not_run', terminationReason: 'aborted', errorMessage: 'stopped', candidate: { status: 'absent' }, modelTerminationReason: undefined }), deliveryDiagnostics: [] }; }
function base() { return { runId: 'run', finalizationId: 'final', phase: 'ended', executionStatus: 'completed', verificationStatus: 'not_required', terminationReason: 'model_completed', modelTerminationReason: 'stop', candidate: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }, turnCount: 1, checkResults: [], budget: { modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0, providerRetries: 0 } }; }
function run(file, args) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); }); }
