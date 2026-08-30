import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectToolEvidence,
  parseToolEvidenceDelta,
  toEvidenceJsonObject
} from '@agent-core/evidence';
import { normalizeJsonSafe, parseJsonObject } from '@agent-core/json';

test('safe JSON parsing rejects accessors, cycles, prototypes, and limits while returning an owned frozen copy', () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { getterCalls += 1; return 'value'; } });
  assert.throws(() => parseJsonObject(accessor), /accessor/u);
  assert.equal(getterCalls, 0);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => parseJsonObject(cyclic), /cycle/u);
  assert.throws(() => parseJsonObject(new (class Custom {})()), /prototype/u);
  assert.throws(() => parseJsonObject({ value: 'too long' }, { maxStringBytes: 2 }), /string byte limit/u);
  const source = { nested: { list: ['value'] } };
  const parsed = parseJsonObject(source);
  source.nested.list[0] = 'changed';
  assert.deepEqual(parsed, { nested: { list: ['value'] } });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.nested), true);
  assert.equal(Object.isFrozen(parsed.nested.list), true);
});

test('JSON normalization is total for hostile values and preserves unsafe property names as data', () => {
  const throwingGetter = Object.defineProperty({}, 'boom', {
    enumerable: true,
    get() { throw new Error('getter must not run'); }
  });
  const protoKey = Object.create(null);
  Object.defineProperty(protoKey, '__proto__', { enumerable: true, value: { injected: true } });
  Object.defineProperty(protoKey, 'constructor', { enumerable: true, value: 'data' });
  const throwingOwnKeys = new Proxy({}, { ownKeys() { throw new Error('ownKeys failed'); } });
  const hostileError = new Error('safe message');
  Object.defineProperty(hostileError, 'details', { enumerable: true, get() { throw new Error('details failed'); } });

  const result = normalizeJsonSafe({
    throwingGetter,
    invalidDate: new Date(Number.NaN),
    protoKey,
    throwingOwnKeys,
    hostileError
  });

  assert.equal(result.status, 'normalized_with_diagnostics');
  assert.equal(Object.getPrototypeOf(result.value), null);
  assert.equal(Object.getPrototypeOf(result.value.protoKey), null);
  assert.equal(Object.hasOwn(result.value.protoKey, '__proto__'), true);
  assert.equal(result.value.protoKey.__proto__.injected, true);
  assert.equal(result.value.protoKey.constructor, 'data');
  assert.match(JSON.stringify(result.value), /__proto__/u);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'accessor'));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'invalid_date'));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'access_error'));
});

test('JSON normalization duplicates shared values without misclassifying them as cycles', () => {
  const shared = { value: 1 };
  const result = normalizeJsonSafe({ left: shared, right: shared });
  assert.equal(result.status, 'clean');
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), { left: { value: 1 }, right: { value: 1 } });
});

test('decoded evidence deltas project into observation-scoped records', () => {
  const delta = parseToolEvidenceDelta(parseJsonObject({ items: [
    {
      action: 'read',
      resources: [{
        uri: 'rooted-file:///notes/a.txt',
        range: { kind: 'line', start: 1, end: 3 },
        sha256: 'a'.repeat(64),
        mediaType: 'text/plain'
      }],
      scope: {
        filters: toEvidenceJsonObject({ hidden: 'exclude', ignored: undefined }),
        limits: toEvidenceJsonObject({ maxBytes: 1200 }),
        omitted: toEvidenceJsonObject({ bytes: 0 }),
        truncated: false,
        confidence: 'verified'
      },
      summary: 'Read a window.',
      outcome: 'success'
    }
  ] }));
  const records = projectToolEvidence(delta, {
    observationId: 'obs-1',
    toolName: 'read_files',
    createdAt: '2026-06-23T00:00:00.000Z'
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'obs-1:evidence:1');
  assert.equal(records[0].observationId, 'obs-1');
  assert.equal(records[0].toolName, 'read_files');
  assert.equal(records[0].action, 'read');
  assert.deepEqual(records[0].resources[0], {
    uri: 'rooted-file:///notes/a.txt',
    range: { kind: 'line', start: 1, end: 3 },
    sha256: 'a'.repeat(64),
    mediaType: 'text/plain'
  });
  assert.deepEqual(records[0].scope.filters, { hidden: 'exclude' });
  assert.equal(records[0].scope.confidence, 'verified');
  assert.throws(() => parseToolEvidenceDelta(parseJsonObject({ items: [{ action: 'not-real', outcome: 'success', resources: [] }] })), /action/u);
  assert.throws(() => parseToolEvidenceDelta(parseJsonObject({ items: [{ action: 'read', outcome: 'success', resources: [{ uri: '' }] }] })), /URI/u);
  assert.throws(() => parseToolEvidenceDelta(parseJsonObject({ items: [{ action: 'read', outcome: 'success', resources: [], scope: { coverage: 'complete', truncated: true } }] })), /complete and truncated/u);
  assert.throws(() => parseToolEvidenceDelta(parseJsonObject({ items: [{ action: 'read', outcome: 'failure', resources: [], unexpected: true }] })), /unsupported fields/u);
});
