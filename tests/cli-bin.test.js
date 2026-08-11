import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createCliToolPolicy, resultExitCode } from '@agent-core/cli';
import { decodeAgentTerminalSnapshot } from '@agent-core/runtime';

test('CLI exposes explicit risk policy', () => {
  assert.deepEqual(createCliToolPolicy({ apply: true, dryRun: false, allowShell: true, allowUnsafeShell: false }).allowedRisks, ['read', 'write', 'destructive', 'execute']);
  assert.deepEqual(createCliToolPolicy({ apply: true, dryRun: false, allowShell: false, allowUnsafeShell: false }).allowedRisks, ['read', 'write', 'destructive'], 'patch writes do not grant shell execution');
  assert.deepEqual(createCliToolPolicy({ apply: false, dryRun: false, allowShell: true, allowUnsafeShell: false }).allowedRisks, ['read', 'execute'], 'shell execution does not grant apply_patch writes');
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
  assert.match(output.stdout + output.stderr, /ambient shell authority runs with this Agent Core process's permissions/iu);
  assert.match(output.stdout + output.stderr, /read, write, or delete files, access the network, and start child processes/iu);
  assert.match(output.stdout + output.stderr, /Persistent ambient processes block conflicting workspace tools until they exit or stop/iu);
  assert.match(output.stdout + output.stderr, /--apply\s+Allow apply_patch add, update, move, and delete operations/iu);
});

function result(overrides = {}) { return { state: 'ended', terminal: decodeAgentTerminalSnapshot({ ...base(), ...overrides }), deliveryDiagnostics: [] }; }
function failed() { const { modelTerminationReason: _reason, ...input } = base(); return { state: 'ended', terminal: decodeAgentTerminalSnapshot({ ...input, executionStatus: 'failed', verificationStatus: 'not_run', terminationReason: 'runtime_error', errorMessage: 'failed', candidate: { status: 'absent' } }), deliveryDiagnostics: [] }; }
function aborted() { const { modelTerminationReason: _reason, ...input } = base(); return { state: 'ended', terminal: decodeAgentTerminalSnapshot({ ...input, executionStatus: 'aborted', verificationStatus: 'not_run', terminationReason: 'aborted', errorMessage: 'stopped', candidate: { status: 'absent' } }), deliveryDiagnostics: [] }; }
function base() { return { runId: 'run', finalizationId: 'final', phase: 'ended', executionStatus: 'completed', verificationStatus: 'not_required', terminationReason: 'model_completed', modelTerminationReason: 'stop', candidate: { status: 'complete', message: 'done', source: 'content', turnIndex: 1 }, turnCount: 1, checkResults: [], budget: { modelTurns: 1, totalToolCalls: 0, repeatedIdenticalToolCalls: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, knownCosts: {}, pricingStatus: 'unknown', unknownPricedTokens: 0, consecutiveProviderFailures: 0, consecutiveToolFailures: 0, providerRetries: 0 } }; }
function run(file, args) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); }); }
