import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJsonString, isOwnedJsonValue, parseJsonValue } from '@agent-core/json';
import { renderDiagnostic } from '@agent-core/json/diagnostics';
import { hashJson } from '@agent-core/persistence';

test('identities include full strings, collections, and deeply nested data', () => {
  const values = [
    ['x'.repeat(100_000) + 'a', 'x'.repeat(100_000) + 'b'],
    [Array.from({ length: 200 }, (_, i) => i), Array.from({ length: 200 }, (_, i) => i === 199 ? -1 : i)],
    [{ a: { b: { c: { d: { e: { f: { g: { h: { i: 'a' } } } } } } } } }, { a: { b: { c: { d: { e: { f: { g: { h: { i: 'b' } } } } } } } } }]
  ];
  for (const [left, right] of values) {
    assert.notEqual(hashJson(left), hashJson(right));
    assert.deepEqual(JSON.parse(canonicalJsonString(left)), left);
  }
});

test('strict decoding and encoding reject unsupported values without invoking accessors', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1; } });
  const sparse = []; sparse[1] = 1;
  const extra = [1]; extra.description = 'lost';
  const symbolic = [1]; symbolic[Symbol('lost')] = 2;
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  for (const value of [undefined, 1n, NaN, Infinity, new Date(), accessor, sparse, extra, symbolic, hidden, { absent: undefined }]) {
    assert.throws(() => parseJsonValue(value), TypeError);
    assert.throws(() => canonicalJsonString(value), TypeError);
  }
  assert.equal(calls, 0);
});

test('every captured subtree reuses ownership and accounts for exact encoded bytes and keys', () => {
  const owned = parseJsonValue({ child: { nested: ['é', '\n'] } });
  assert.equal(isOwnedJsonValue(owned.child), true);
  assert.equal(parseJsonValue(owned.child), owned.child);
  for (const value of [owned, { a: owned.child, b: owned.child }, { 'long-key': 1 }]) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    assert.deepEqual(parseJsonValue(value, { maxTotalBytes: bytes }), value);
    assert.throws(() => parseJsonValue(value, { maxTotalBytes: bytes - 1 }), /byte/u);
  }
  assert.throws(() => parseJsonValue({ 'long-key': 1 }, { maxStringBytes: 3 }), /string/u);
});

test('diagnostic text obeys even tiny UTF-8 budgets without presenting itself as JSON data', () => {
  for (const maxBytes of [1, 2, 3, 4, 16, 32]) {
    const result = renderDiagnostic('😀é'.repeat(100_000), { maxBytes });
    assert.ok(result.bytes <= maxBytes);
    assert.equal(Buffer.byteLength(result.text), result.bytes);
    assert.equal(result.truncated, true);
    assert.equal('value' in result, false);
  }
});

test('diagnostics never read getters or function names and handle cyclic errors', () => {
  let calls = 0;
  const fn = () => {};
  Object.defineProperty(fn, 'name', { get() { calls++; return 'unsafe'; } });
  const error = new Error('failure'); error.cause = error;
  Object.defineProperty(error, 'details', { enumerable: true, get() { calls++; return 1; } });
  const proxy = new Proxy({}, { ownKeys() { throw new Error('inspection denied'); } });
  const result = renderDiagnostic({ fn, error, proxy });
  assert.equal(calls, 0);
  assert.match(result.text, /\[function\]/u);
  assert.match(result.text, /\[circular\]/u);
  assert.match(result.text, /\[accessor\]/u);
  assert.match(result.text, /\[inspection failed\]/u);
});

test('diagnostic property reads share a global entry budget across nested collections', () => {
  let reads = 0;
  const nested = () => new Proxy({ one: 1, two: 2, three: 3 }, {
    getOwnPropertyDescriptor(target, key) { reads++; return Reflect.getOwnPropertyDescriptor(target, key); }
  });
  const result = renderDiagnostic({ a: nested(), b: nested(), c: nested() }, { maxEntries: 5 });
  assert.equal(result.truncated, true);
  assert.ok(reads <= 3);
});
