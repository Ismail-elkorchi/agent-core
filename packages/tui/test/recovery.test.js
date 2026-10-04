import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelProviderError } from '@agent-core/model';
import { providerFailureText } from '@agent-core/tui';

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
