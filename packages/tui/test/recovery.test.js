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


test('conversation loading presentation keeps automatic maintenance invisible', () => {
  for (const phase of ['started', 'progress'])
    assert.equal(historyRecoveryMessage({ phase, sessionId: 'selected', records: 20, bytes: 512, totalBytes: 1024 }), 'Opening conversation…');
  for (const phase of ['completed', 'cancelled', 'failed'])
    assert.equal(historyRecoveryMessage({ phase, sessionId: 'selected', message: 'Private diagnostic.' }), '');
});

test('quick conversation opening and completed housekeeping are silent', () => {
  let now = 0;
  const messages = [];
  const renderer = new HistoryRecoveryProgressRenderer(message => messages.push(message), () => now);
  renderer.handle({ phase: 'started', sessionId: 'quick' });
  now = 500;
  renderer.handle({ phase: 'progress', sessionId: 'quick', records: 1000, bytes: 100_000, totalBytes: 100_000 });
  renderer.handle({ phase: 'completed', sessionId: 'quick' });
  renderer.handle({ phase: 'failed', sessionId: 'unrelated', message: 'Private diagnostic.' });
  renderer.handle({ phase: 'cancelled', sessionId: 'cancelled', message: 'Private diagnostic.' });
  assert.deepEqual(messages, []);
});

test('slow opening emits one generic line across arbitrarily many progress events and sessions', () => {
  let now = 0;
  const messages = [];
  const renderer = new HistoryRecoveryProgressRenderer(message => messages.push(message), () => now);
  for (let session = 0; session < 20; session++) {
    const sessionId = `session-${session}`;
    renderer.handle({ phase: 'started', sessionId });
    for (let records = 1; records <= 1000; records++) {
      now++;
      renderer.handle({ phase: 'progress', sessionId, records, bytes: records * 100, totalBytes: 100_000 });
    }
    renderer.handle({ phase: 'completed', sessionId });
  }
  assert.deepEqual(messages, ['Opening conversation…']);
});


test('a finished opening does not lend elapsed time to a later conversation', () => {
  let now = 0;
  const messages = [];
  const renderer = new HistoryRecoveryProgressRenderer(message => messages.push(message), () => now);
  renderer.handle({ phase: 'started', sessionId: 'first' });
  now = 50;
  renderer.handle({ phase: 'completed', sessionId: 'first' });
  now = 20_000;
  renderer.handle({ phase: 'started', sessionId: 'later' });
  now += 500;
  renderer.handle({ phase: 'progress', sessionId: 'later', records: 10, bytes: 100, totalBytes: 200 });
  assert.deepEqual(messages, []);
  now += 500;
  renderer.handle({ phase: 'progress', sessionId: 'later', records: 20, bytes: 200, totalBytes: 200 });
  assert.deepEqual(messages, ['Opening conversation…']);
});
