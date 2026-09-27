import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySessionRepository, HistoryReader, ContextService, createHistoryTools, createContextTools
} from '@agent-core/runtime';
import { continuityProvider, model, providerIds } from './continuity-provider-fixtures.js';
import { invokeToolCall, jsonToolCall } from './tool-call-helpers.js';

test('all adapters preserve optional history references through search, read and context selection', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    id: 'roundtrip', binding: { schemaId: 'test', schemaVersion: 1, subject: {} }
  });
  await sessions.appendInput(session, { runId: 'run', task: 'original request' });
  const history = new HistoryReader({ repository: sessions, session });
  const context = new ContextService({ repository: sessions, session, history, policy: { maxSourceBytes: 8192 } });
  const tools = [...createHistoryTools({ history }), ...createContextTools({ context })];
  const policy = { allowedRisks: ['read', 'write'] };
  const search = await invokeToolCall(jsonToolCall('history_search', { query: 'original' }), tools, { policy });
  assert.equal(search.kind, 'result', search.summary);
  const source = search.output.items[0].source;
  assert.equal(source.event, undefined);
  const read = await invokeToolCall(jsonToolCall('history_read', { source }), tools, { policy });
  assert.equal(read.output.status, 'available');
  assert.equal(read.output.item.text, 'original request');
  const transition = tools.find(t => t.name === 'context_transition');
  const selection = { strategy: 'sources', retained: [source], notes: [] };
  assert.equal(transition.decodeInput({ kind: 'json', value: { reason: 'retain', selection } }).ok, true);
  const input = {
    model,
    messages: [{ role: 'user', content: 'inspect history' }],
    tools: tools.map(t => ({ type: 'function', function: {
      name: t.name, description: t.description, parameters: t.jsonSchema
    } }))
  };
  for (const id of providerIds) {
    const provider = continuityProvider(id);
    const compiled = await provider.compileRequest(input, { outputReservation: 100 });
    const schemas = new Map();
    for (const wire of compiled.body.tools) {
      const definition = wire.function ?? wire;
      const schema = definition.input_schema ?? definition.parameters;
      if (id === 'openai' || id === 'openai-codex') assert.equal(wire.strict, false);
      assert.deepEqual(schema, tools.find(t => t.name === definition.name).jsonSchema, id);
      schemas.set(definition.name, schema);
    }
    const readSchema = schemas.get('history_read');
    assert.ok(!readSchema.properties.source.required.includes('event'));
  }
  const presented = JSON.parse(tools.find(t => t.name === 'history_search').buildModelContent({
    observation: search, input: {}, call: jsonToolCall('history_search')
  })[0].text);
  assert.deepEqual(presented.items, search.output.items);
  assert.equal(presented.coverage, search.output.coverage);
  assert.equal(presented.cut, undefined);
  assert.equal(presented.indexWatermark, undefined);
});

test('search cursors carry one cut and retain pagination, query and scope fencing', async () => {
  const sessions = new InMemorySessionRepository();
  const binding = { schemaId: 'test', schemaVersion: 1, subject: {} };
  const session = await sessions.create({ id: 'pagination', binding });
  for (let i = 0; i < 5; i++)
    await sessions.appendInput(session, { runId: `run-${i}`, task: `input ${i}` });
  const history = new HistoryReader({ repository: sessions, session });
  const first = await history.search({ query: 'input', limit: 1 });
  const encoded = JSON.parse(Buffer.from(first.cursor, 'base64url').toString());
  assert.equal(encoded.format, 'agent-core.history-cursor/1');
  assert.equal(typeof encoded.position, 'object');
  assert.equal(encoded.position.cut, undefined);
  await sessions.appendInput(session, { runId: 'later', task: 'input later' });
  const seen = [...first.items];
  let cursor = first.cursor;
  while (cursor) {
    const page = await history.search({ query: 'input', limit: 1, cursor });
    seen.push(...page.items);
    cursor = page.cursor;
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen.map(i => i.source.entryId)).size, 5);
  await assert.rejects(history.search({ query: 'changed', cursor: first.cursor }), /query mismatch/);
  const other = new HistoryReader({ repository: sessions, session: await sessions.create({ id: 'other', binding }) });
  await assert.rejects(other.search({ query: 'input', cursor: first.cursor }), /scope|branch|session/i);
  await assert.rejects(history.search({ query: 'input', cursor: Buffer.from(JSON.stringify({
    ...encoded, position: 'superseded-nested-cursor'
  })).toString('base64url') }), /object/i);
});
