import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import { text } from '@ismail-elkorchi/terminal-ui/components';
import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { configurationState, configurationView, updateConfiguration } from '@agent-core/tui';

const profile = {
  id: 'available-model',
  provider: 'neutral',
  limits: { contextTokens: 10000 },
  capabilities: { reasoning: { strategies: ['effort'], efforts: ['low', 'high'], canDisable: false } }
};
const key = (key, modifiers = {}) => ({
  kind: 'key',
  key,
  eventType: 'press',
  location: 'standard',
  modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...modifiers }
});

for (const columns of [48, 80, 120])
  test(`model review keeps complete actions reachable at ${columns} columns`, async (t) => {
    const operations = { providers: [{ id: 'neutral', label: 'Neutral' }] };
    const selected = {
      ...configurationState({ provider: 'neutral', model: 'available-model' }, operations.providers),
      stage: 'review',
      profile: { ...profile, capabilities: { ...profile.capabilities, temperature: true } }
    };
    const host = createMemoryTerminalHost({ terminalSize: { columns, rows: 18 } });
    const runtime = createTuiRuntime({
      host,
      app: defineTui({
        id: 'neutral-review',
        init: () => ({ state: selected }),
        update: (state, message) => updateConfiguration(state, message, operations),
        view: (state) => configurationView(state, operations, columns - 4, 14)
      })
    });
    t.after(() => runtime.dispose());
    await runtime.start();
    for (const label of ['Close', 'Provider', 'Refresh', 'Model ID', 'Endpoint', 'Save'])
      assert.ok(renderFramePlain(runtime.frame()).includes(label), label);
    const reached = new Set();
    for (let step = 0; step < 18; step++) {
      reached.add(runtime.frame().focusPath.at(-1));
      await runtime.handleInput(key('tab'));
    }
    for (const id of [
      'configuration-save',
      'configuration-model',
      'configuration-reasoning',
      'configuration-temperature',
      'configuration:close'
    ])
      assert.ok(reached.has(id), id);
  });
async function settle(condition) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), 'configuration effect should settle');
}

test('a neutral consumer discovers, reviews and saves a model without typing its ID', async (t) => {
  const saved = [];
  const adapter = { describeModel: async () => profile, listModels: async () => [{ id: profile.id }] };
  const operations = {
    providers: [{ id: 'neutral', label: 'Neutral service' }],
    connect: async () => adapter,
    save: async (selection, provider) => saved.push({ selection, provider })
  };
  const host = createMemoryTerminalHost({ terminalSize: { columns: 80, rows: 24 } });
  const runtime = createTuiRuntime({
    host,
    app: defineTui({
      id: 'neutral-configuration',
      init: () => ({ state: configurationState(undefined, operations.providers) }),
      update: (state, message) =>
        message.type === 'overlay.close'
          ? { state, exit: { reason: 'closed' } }
          : updateConfiguration(state, message, operations),
      view: (state) => configurationView(state, operations, 76, 20)
    })
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  await runtime.handleInput(key('enter'));
  await settle(() => runtime.state().models.length === 1);
  await runtime.handleInput(key('enter'));
  await settle(() => runtime.state().stage === 'review');
  assert.equal(saved.length, 0, 'highlighting and review do not commit configuration');
  await runtime.dispatch({ type: 'configuration.save' });
  await settle(() => saved.length === 1);
  assert.deepEqual(saved[0].selection, { provider: 'neutral', model: 'available-model' });
  assert.equal(saved[0].provider, adapter);
});

test('a dismissed configuration cannot accept the response of an earlier picker', async () => {
  const providers = [{ id: 'neutral', label: 'Neutral' }];
  const old = configurationState(undefined, providers);
  const current = configurationState(undefined, providers);
  const result = updateConfiguration(
    current,
    { type: 'configuration.catalog', id: old.id, request: 'old', adapter: {}, models: [{ id: 'stale' }] },
    { providers }
  );
  assert.equal(result.state, current);
});

test('an empty panel closes on a raw Escape without a dummy focus target', async (t) => {
  const { panel } = await import('@agent-core/tui');
  const host = createMemoryTerminalHost();
  const runtime = createTuiRuntime({
    host,
    app: defineTui({
      id: 'empty-panel',
      init: () => ({ state: true }),
      update: () => ({ state: false }),
      view: (open) =>
        open
          ? panel({
              id: 'panel',
              title: 'No results',
              width: 48,
              height: 10,
              slots: { content: text({ content: 'No matching items.' }) },
              onClose: () => ({ type: 'close' })
            })
          : text({ content: 'Closed' })
    })
  });
  t.after(() => runtime.dispose());
  await runtime.start();
  const input = await runtime.handleInputChunk({ data: '\x1b' });
  host.clock.advance(100);
  await input.pending;
  assert.equal(runtime.state(), false);
});
