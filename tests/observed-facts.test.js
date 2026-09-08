import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordObservedFacts,
  parseToolResultFacts
} from '@agent-core/tools';
import { parseJsonObject } from '@agent-core/json';

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

test('decoded observedFacts deltas become observation-scoped records', () => {
  const delta = parseToolResultFacts(parseJsonObject({ items: [
    {
      action: 'read',
      resources: [{
        uri: 'rooted-file:///notes/a.txt',
        range: { kind: 'line', start: 1, end: 3 },
        sha256: 'a'.repeat(64),
        mediaType: 'text/plain'
      }],
      scope: {
        filters: parseJsonObject({ hidden: 'exclude' }),
        limits: parseJsonObject({ maxBytes: 1200 }),
        omitted: parseJsonObject({ bytes: 0 }),
        truncated: false,
        actuality: 'observed'
      },
      summary: 'Read a window.',
      outcome: 'success'
    }
  ] }));
  const records = recordObservedFacts(delta, {
    observationId: 'obs-1',
    toolName: 'read_files',
    createdAt: '2026-06-23T00:00:00.000Z'
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'obs-1:fact:1');
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
  assert.equal(records[0].scope.actuality, 'observed');
  assert.throws(() => parseToolResultFacts(parseJsonObject({ items: [{ action: 'not-real', outcome: 'success', resources: [] }] })), /action/u);
  assert.throws(() => parseToolResultFacts(parseJsonObject({ items: [{ action: 'read', outcome: 'success', resources: [{ uri: '' }] }] })), /URI/u);
  assert.throws(() => parseToolResultFacts(parseJsonObject({ items: [{ action: 'read', outcome: 'success', resources: [], scope: { coverage: 'complete', truncated: true } }] })), /complete and truncated/u);
  assert.throws(() => parseToolResultFacts(parseJsonObject({ items: [{ action: 'read', outcome: 'failure', resources: [], unexpected: true }] })), /unsupported fields/u);
});
