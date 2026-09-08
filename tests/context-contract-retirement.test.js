import assert from 'node:assert/strict';
import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import * as model from '@agent-core/model';
import { AgentSession } from '@agent-core/runtime';

const root = path.resolve(import.meta.dirname, '..');
const retired = /\b(?:SessionCompactionEntry|AgentSessionCompactionRequest|appendCompaction|summarizeConversation|SimpleTokenEstimator|TokenEstimator|ModelMessage|ModelProviderState|normalizeStreamedFinalResponse|installCheckpoint|checkpointHistorySummary|renderTurnCheckpoint|renderSessionHistory|renderSemanticCompaction|renderInterruptedTurnCheckpoint|executeAssistantToolCalls|nextObservationIndex)\b/u;

test('the context redesign has one production path and no retired contract aliases', async () => {
  const remaining = [];
  for await (const file of glob(['packages/*/src/**/*.ts', 'packages/providers/*/src/**/*.ts'], { cwd: root })) {
    const match = retired.exec(await readFile(path.join(root, file), 'utf8'));
    if (match) remaining.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(remaining, [], 'Remove superseded implementation and exports at the same cutover.');
  assert.equal('compact' in AgentSession.prototype, false);
  assert.equal('SimpleTokenEstimator' in model, false);
});
