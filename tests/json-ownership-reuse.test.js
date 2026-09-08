import { canonicalJsonString } from '@agent-core/json';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isOwnedJsonValue, parseJsonValue } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';

test('owned JSON can be reused while fresh mutable input still crosses the ownership boundary', () => {
  const input = { nested: { value: 'before' } };
  const owned = parseJsonValue(input);
  assert.equal(parseJsonValue(owned), owned);
  assert.equal(isOwnedJsonValue(owned), true);
  assert.equal(isOwnedJsonValue(input), false);
  input.nested.value = 'after';
  assert.equal(owned.nested.value, 'before');
  assert.equal(parseJsonValue(input).nested.value, 'after');
  assert.throws(() => { owned.nested.value = 'mutated'; }, TypeError);
});

test('ownership reuse never bypasses a subsequently tighter bound', () => {
  const owned = parseJsonValue({ nested: { values: ['é'.repeat(10), true] } });
  assert.throws(() => parseJsonValue(owned, { maxDepth: 1 }), /depth/u);
  assert.throws(() => parseJsonValue(owned, { maxCollectionEntries: 1 }), /collection/u);
  assert.throws(() => parseJsonValue(owned, { maxStringBytes: 5 }), /string/u);
  assert.throws(() => parseJsonValue(owned, { maxTotalBytes: 10 }), /byte/u);
  assert.equal(parseJsonValue(owned), owned);
});

test('nested owned values share storage while contributing their full shape to limits', () => {
  const child = parseJsonValue({ values: ['é'.repeat(10), true] });
  const parent = parseJsonValue({ child });
  assert.equal(parent.child, child);
  assert.throws(() => parseJsonValue({ child }, { maxDepth: 2 }), /depth/u);
  assert.throws(() => parseJsonValue({ first: child, second: child }, { maxCollectionEntries: 6 }), /collection/u);
  assert.throws(() => parseJsonValue({ child }, { maxStringBytes: 5 }), /string/u);
  assert.throws(() => parseJsonValue({ child }, { maxTotalBytes: 30 }), /byte/u);
});

test('UTF-8 limits remain exact across chunk boundaries, escapes, and surrogate pairs', () => {
  for (const text of ['é😀\uD800', 'x'.repeat(65_535) + '😀', '"\\\n'.repeat(24_000)]) {
    const rawBytes = Buffer.byteLength(text);
    const jsonBytes = Buffer.byteLength(JSON.stringify(text));
    assert.equal(parseJsonValue(text, { maxStringBytes: rawBytes, maxTotalBytes: jsonBytes }), text);
    assert.throws(() => parseJsonValue(text, { maxStringBytes: rawBytes - 1 }), /string/u);
    assert.throws(() => parseJsonValue(text, { maxStringBytes: rawBytes, maxTotalBytes: jsonBytes - 1 }), /byte/u);
  }
});

test('canonical reuse cannot be forged by freezing a mutable object or an accessor', () => {
  const child = { count: 1 };
  const shallow = Object.freeze({ child });
  assert.equal(isOwnedJsonValue(shallow), false);
  const before = hashJson(shallow);
  child.count = 2;
  assert.notEqual(hashJson(shallow), before);

  let accessed = 0;
  const accessor = Object.freeze(Object.defineProperty({}, 'value', {
    enumerable: true,
    get() { accessed++; return 'untrusted'; }
  }));
  assert.equal(isOwnedJsonValue(accessor), false);
  assert.throws(() => hashJson(accessor), /accessor/u);
  assert.throws(() => parseJsonValue(accessor), /accessor/u);
  assert.equal(accessed, 0);
});

test('captured snapshots remain immutable and canonical identities are locale independent', () => {
  const source = { z: [{ value: 1 }], 'é': 'accent', a: 'first' };
  const normalized = parseJsonValue(source);
  assert.equal(isOwnedJsonValue(normalized), true);
  const before = canonicalJsonString(normalized);
  source.z[0].value = 2;
  assert.equal(canonicalJsonString(normalized), before);
  assert.equal(before, '{"a":"first","z":[{"value":1}],"é":"accent"}');
  assert.equal(hashJson(parseJsonValue(normalized)), hashJson(normalized));
});
