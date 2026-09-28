import test from 'node:test';
import assert from 'node:assert/strict';
import { redactJson, redactTextPreservingLength } from '@agent-core/persistence';

test('redaction preserves source identifiers and is idempotent across durable and egress boundaries', () => {
  const source = "new Provider({ apiKey: 'test' });\nconst token = nextToken;\ninterface Input { privateKey: string }";
  assert.deepEqual(redactJson(source), { value: source, redactions: 0 });
  const input = { content: source, token: 'identifier', tokenCount: 'twelve', apiKey: 'private-value', log: 'API_TOKEN=private-value' };
  const redacted = redactJson(input);
  assert.equal(redacted.value.content, source);
  assert.equal(redacted.value.tokenCount, 'twelve');
  assert.equal(redacted.value.token, 'identifier');
  assert.equal(JSON.stringify(redacted.value).includes('private-value'), false);
  assert.deepEqual(redactJson(redacted.value), { value: redacted.value, redactions: 0 });
});

test('all shared credential patterns remove values, including bare keys, without changing stream offsets', () => {
  const credentials = [
    'sk-' + 'a'.repeat(24), 'ghp_' + 'b'.repeat(24), 'AKIA' + 'C'.repeat(16),
    'bearer-credential', 'YmFzaWM6Y3JlZGVudGlhbA==', 'environment-credential',
    '-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----'
  ];
  const text = `${credentials.slice(0, 3).join('\n')}\nAuthorization: Bearer ${credentials[3]}\nAuthorization: Basic ${credentials[4]}\nAPP_SECRET=${credentials[5]}\n${credentials[6]}`;
  for (const redacted of [redactJson(text).value, redactTextPreservingLength(text).text]) {
    for (const secret of credentials) assert.ok(!redacted.includes(secret));
    assert.equal(redactJson(redacted).redactions, 0);
  }
  assert.equal(redactTextPreservingLength(text).text.length, text.length);
});

test('environment credentials include spaces and Unicode without changing byte-oriented output boundaries', () => {
  const source = 'API_TOKEN=Рassword with spaces\nordinary output';
  assert.equal(redactJson(source).value, 'API_TOKEN=[REDACTED]\nordinary output');
  const bytes = Buffer.from(source);
  const masked = Buffer.from(redactTextPreservingLength(bytes.toString('latin1')).text, 'latin1');
  assert.equal(masked.length, bytes.length);
  assert.doesNotMatch(masked.toString('utf8'), /assword|with spaces/);
  assert.match(masked.toString('utf8'), /ordinary output$/);
});
