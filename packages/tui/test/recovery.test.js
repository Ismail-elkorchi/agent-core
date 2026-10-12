import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelProviderError } from '@agent-core/model';
import { HistoryRecoveryProgressRenderer, historyRecoveryMessage, providerFailureText } from '@agent-core/tui';

test('provider failure presentation exposes direct and nested transport causes', () => {
  for (const nested of [false, true]) {
    const transport = Object.assign(new Error('connection closed'), { code: 'ECONNRESET' });
    const failure = new ModelProviderError({
      provider: 'fixture', code: 'provider_unavailable', message: 'Request failed.',
      cause: nested ? new TypeError('fetch failed', { cause: transport }) : transport
    });
    const diagnostic = {
      ...failure.diagnostic,
      causeSummary: { ...failure.diagnostic.causeSummary, message: failure.message }
    };
    assert.equal(providerFailureText(diagnostic), 'Request failed.\nCause: ECONNRESET: connection closed');
    assert.equal(providerFailureText({
      ...diagnostic,
      causeSummary: { ...diagnostic.causeSummary, message: 'Request failed: connection closed' }
    }), 'Request failed: connection closed\nCause: ECONNRESET');
  }
});

test('a wrapper error code is not attributed to its nested cause', () => {
  const failure = new ModelProviderError({
    provider: 'fixture', code: 'provider_unavailable', message: 'Request failed.',
    cause: Object.assign(new Error('request interrupted', { cause: new Error('connection closed') }), {
      code: 'EWRAPPED'
    })
  });
  assert.equal(providerFailureText({
    ...failure.diagnostic,
    causeSummary: { ...failure.diagnostic.causeSummary, message: failure.message }
  }), 'Request failed.\nCause: connection closed');
});


test('history recovery presentation distinguishes rebuilding, completion and terminal failures', () => {
  assert.match(historyRecoveryMessage({ phase: 'started', sessionId: 'selected' }), /Restoring history index.*selected/u);
  assert.match(historyRecoveryMessage({ phase: 'progress', sessionId: 'selected', records: 20, bytes: 512, totalBytes: 1024 }), /20 records, 512\/1024 bytes/u);
  assert.match(historyRecoveryMessage({ phase: 'completed', sessionId: 'selected' }), /Original history is unchanged/u);
  for (const phase of ['cancelled', 'failed']) {
    const message = phase === 'cancelled' ? 'Cancelled before publication.' : 'Original history is corrupt.';
    assert.equal(historyRecoveryMessage({ phase, sessionId: 'selected', message }), message);
  }
});


test('history recovery CLI presentation samples large scans while always showing terminal outcomes', () => {
  let now = 0;
  const messages = [];
  const renderer = new HistoryRecoveryProgressRenderer(message => messages.push(message), () => now);
  renderer.handle({ phase: 'started', sessionId: 'large' });
  for (let records = 1; records <= 10_000; records++) {
    now++;
    renderer.handle({ phase: 'progress', sessionId: 'large', records, bytes: records * 100, totalBytes: 1_000_000 });
  }
  renderer.handle({ phase: 'completed', sessionId: 'large' });
  assert.equal(messages.length, 12);
  assert.match(messages[0], /Restoring history index/u);
  assert.match(messages.at(-2), /10000 records, 1000000\/1000000 bytes/u);
  assert.match(messages.at(-1), /History index restored/u);
  for (const phase of ['cancelled', 'failed']) {
    renderer.handle({ phase: 'started', sessionId: phase });
    renderer.handle({ phase: 'progress', sessionId: phase, records: 1, bytes: 1, totalBytes: 100 });
    renderer.handle({ phase, sessionId: phase, message: phase });
    assert.equal(messages.at(-1), phase);
  }
});
