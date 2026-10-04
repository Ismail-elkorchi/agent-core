import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySessionRepository,
  HistoryReader,
  ContextService,
  createHistoryTools,
  createContextTools,
  InferenceService,
  InMemoryInferenceRepository
} from '@agent-core/runtime';
import { continuityProvider, model, providerIds } from './continuity-provider-fixtures.js';
import { modelOutputToInput } from '@agent-core/model';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { serializeToolModelContent } from '@agent-core/tools';
import { invokeToolCall, jsonToolCall } from './tool-call-helpers.js';

test('all adapters preserve optional history references through search, read and context selection', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    id: 'roundtrip',
    binding: { schemaId: 'test', schemaVersion: 1, subject: {} }
  });
  await sessions.appendInput(session, { runId: 'run', task: 'original request' });
  const history = new HistoryReader({ repository: sessions, session });
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    policy: { maxSourceBytes: 8192 }
  });
  const tools = [...createHistoryTools({ history }), ...createContextTools({ context })];
  const policy = { allowedRisks: ['read', 'write'] };
  const search = await invokeToolCall(
    jsonToolCall('history_search', { query: 'original' }),
    tools,
    { policy }
  );
  assert.equal(search.kind, 'result', search.summary);
  const source = search.output.items[0].source;
  assert.equal(source.event, undefined);
  const read = await invokeToolCall(jsonToolCall('history_read', { source }), tools, { policy });
  assert.equal(read.output.status, 'available');
  assert.equal(read.output.item.text, 'original request');
  assert.equal(Object.hasOwn(read.output, 'text'), false);
  const readContent = tools
    .find((t) => t.name === 'history_read')
    .buildModelContent({ observation: read });
  assert.equal(serializeToolModelContent(readContent).split('original request').length - 1, 1);
  const transition = tools.find((t) => t.name === 'context_transition');
  const selection = { strategy: 'sources', retained: [source] };
  assert.equal(
    transition.decodeInput({ kind: 'json', value: { reason: 'retain', selection } }).ok,
    true
  );
  const input = {
    model,
    messages: [{ role: 'user', content: 'inspect history' }],
    tools: tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.jsonSchema
      }
    }))
  };
  for (const id of providerIds) {
    const provider = continuityProvider(id);
    const compiled = await provider.compileRequest(input, { outputReservation: 100 });
    const schemas = new Map();
    for (const wire of compiled.body.tools) {
      const definition = wire.function ?? wire;
      const schema = definition.input_schema ?? definition.parameters;
      if (id === 'openai' || id === 'openai-codex') assert.equal(wire.strict, false);
      assert.deepEqual(schema, tools.find((t) => t.name === definition.name).jsonSchema, id);
      schemas.set(definition.name, schema);
    }
    const readSchema = schemas.get('history_read');
    assert.ok(!readSchema.properties.source.required.includes('event'));
  }
  const presented = JSON.parse(
    tools
      .find((t) => t.name === 'history_search')
      .buildModelContent({
        observation: search,
        input: {},
        call: jsonToolCall('history_search')
      })[0].text
  );
  assert.equal(presented.items, undefined);
  const searchContent = tools
    .find((t) => t.name === 'history_search')
    .buildModelContent({ observation: search });
  assert.deepEqual(JSON.parse(searchContent[1].text).source, source);
  assert.equal(searchContent[2].text, search.output.items[0].text);
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
  assert.equal(new Set(seen.map((i) => i.source.entryId)).size, 5);
  await assert.rejects(
    history.search({ query: 'changed', cursor: first.cursor }),
    /query mismatch/
  );
  const other = new HistoryReader({
    repository: sessions,
    session: await sessions.create({ id: 'other', binding })
  });
  await assert.rejects(
    other.search({ query: 'input', cursor: first.cursor }),
    /scope|branch|session/i
  );
  await assert.rejects(
    history.search({
      query: 'input',
      cursor: Buffer.from(
        JSON.stringify({
          ...encoded,
          position: 'superseded-nested-cursor'
        })
      ).toString('base64url')
    }),
    /object/i
  );
});

test('a bounded empty history search does not imply absence from unscanned history', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    id: 'bounded-empty',
    binding: { schemaId: 'test', schemaVersion: 1, subject: {} }
  });
  for (const [i, task] of ['needle', 'unrelated', 'unrelated'].entries())
    await sessions.appendInput(session, { runId: `r-${i}`, task });
  const history = new HistoryReader({ repository: sessions, session });
  const tools = createHistoryTools({ history });
  const result = await invokeToolCall(
    jsonToolCall('history_search', { query: 'absent', maxScanned: 1 }),
    tools,
    { policy: { allowedRisks: ['read'] } }
  );
  assert.equal(result.output.coverage, 'partial');
  assert.equal(result.output.items.length, 0);
  const parts = tools
    .find((t) => t.name === 'history_search')
    .buildModelContent({ observation: result });
  assert.match(serializeToolModelContent(parts), /No match in the scanned portion/);
  assert.equal(JSON.parse(parts[0].text).cursor, result.output.cursor);
});

test('an insufficient history result budget is an actionable settled read failure', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'test', schemaVersion: 1, subject: {} }
  });
  await sessions.appendInput(session, { runId: 'run', task: 'needle' });
  const history = new HistoryReader({ repository: sessions, session });
  const result = await invokeToolCall(
    jsonToolCall('history_search', { query: 'needle', maxBytes: 1 }),
    createHistoryTools({ history }),
    { policy: { allowedRisks: ['read'] } }
  );
  assert.equal(result.kind, 'failure');
  assert.equal(result.execution.state, 'settled');
  assert.equal(result.output.reason, 'invalid_arguments');
  assert.equal(result.output.details.maxBytes, 1);
  assert(result.output.details.requiredBytes > 1);
});

test('context inspection explains adjusted capacity and does not expose the accounting component ledger', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    id: 'inspect-capacity',
    binding: { schemaId: 'test', schemaVersion: 1, subject: {} }
  });
  const history = new HistoryReader({ repository: sessions, session });
  const context = new ContextService({
    repository: sessions,
    session,
    history,
    policy: { maxSourceBytes: 8192 }
  });
  const provider = continuityProvider('openai');
  const compiled = await provider.compileRequest({
    model,
    messages: [{ role: 'user', content: 'Inspect capacity.' }],
    maxOutputTokens: 100
  });
  context.recordAdmission({
    status: 'admitted',
    inputIdentity: compiled.inputIdentity,
    accounting: compiled.accounting
  });
  const tools = createContextTools({ context });
  const result = await invokeToolCall(jsonToolCall('context_inspect'), tools, {
    policy: { allowedRisks: ['read'] }
  });
  const presented = JSON.parse(tools[0].buildModelContent({ observation: result })[0].text);
  assert.equal(presented.admission.status, 'admitted');
  assert.equal(
    presented.capacity.inputTokens,
    Math.ceil(
      compiled.accounting.estimatedInputTokens * (1 + compiled.accounting.uncertainty.headroomRatio)
    )
  );
  assert.equal(presented.accounting.uncertainty.calibrated, false);
  assert.match(presented.accounting.inputTokensMeaning, /uncertainty.headroomRatio/);
  assert.equal(presented.accounting.components, undefined);
  assert.equal(presented.admission.inputIdentity, undefined);
  assert.match(tools[1].description, /removes all optional history/);
});

test('all provider adapters continue with original reasoning using observed request-level usage', async () => {
  for (const id of providerIds) {
    const bodies = [];
    const provider = continuityProvider(id, { bodies, opaqueReasoning: true, countTokens: false });
    const repositories = {
      provider,
      repository: new InMemoryInferenceRepository(),
      artifacts: new InMemoryArtifactRepository()
    };
    let service = new InferenceService(repositories);
    const profile = await provider.describeModel(model);
    const initial = {
      model,
      messages: [{ role: 'user', content: 'Investigate the failure.' }],
      ...(id === 'openai-codex' ? {} : { maxOutputTokens: 100 })
    };
    const firstCompiled = await service.compile(initial, profile, { outputReservation: 100 });
    const firstInput = {
      ownerId: id,
      invocationId: 'first',
      purpose: 'test',
      request: initial,
      compiled: firstCompiled,
      profile,
      outputReservation: 100
    };
    const first = await service.invoke(firstInput);
    service = new InferenceService(repositories);
    assert.equal((await service.invoke(firstInput)).replayed, true, id);
    const next = {
      ...initial,
      messages: [
        ...initial.messages,
        ...modelOutputToInput(first.response.output),
        { role: 'user', content: 'Continue.' }
      ]
    };
    const compiled = await service.compile(next, profile, { outputReservation: 100 });
    assert.equal(compiled.accounting.method.name, 'provider-usage-prefix', id);
    assert.equal(compiled.accounting.components[0].tokens, 30, id);
    assert.equal(compiled.accounting.unknownComponents.length, 0, id);
    const original = first.response.output.find((item) => item.type === 'protocol').state;
    assert.deepEqual(compiled.logicalRequest.messages[1].state, original, id);
    await service.invoke({
      ownerId: id,
      invocationId: 'second',
      purpose: 'test',
      request: next,
      compiled,
      profile,
      outputReservation: 100
    });
    assert.equal(bodies.length, 2, id);
    const invalidated = await service.compile(
      { ...next, messages: [{ role: 'user', content: 'A different selected window.' }] },
      profile,
      { outputReservation: 100 }
    );
    assert.equal(invalidated.accounting.method.name, 'serialized-request-estimate', id);
  }
});
