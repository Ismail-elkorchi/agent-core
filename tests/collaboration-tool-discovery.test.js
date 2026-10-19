import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolCatalog, InMemoryToolCatalogSelectionStore } from '@agent-core/tools';
import { createCollaborationToolHost, createCollaborationTools, createCollaborationToolSource } from '@agent-core/runtime';

function source(capabilities = { toolNames: ['read_files'] }) {
  const host = createCollaborationToolHost({ groupId: 'discovery-group', actorSessionId: 'supervisor',
    coordinator: () => { throw new Error('Discovery must not activate a collaboration group.'); },
    capabilities, profiles: [{ id: 'review', capabilityRevision: 'review-1', capabilities }] });
  return createCollaborationToolSource(createCollaborationTools(host).filter(tool => tool.name !== 'collaboration_inspect'));
}

test('collaboration catalog loads only exact selected schemas and restores the same host binding', async () => {
  const store = new InMemoryToolCatalogSelectionStore('session/branch');
  const original = source();
  const catalog = new ToolCatalog({ sources: [original], selectionStore: store });
  assert.deepEqual(await catalog.refresh(), []);
  const discovery = await catalog.discover({ query: 'collaboration_start', limit: 1 });
  assert.equal(discovery.items.length, 1);
  assert.equal(discovery.items[0].loaded, false);
  assert.equal('jsonSchema' in discovery.items[0], false);
  assert.match(discovery.items[0].description, /review/);
  for (const query of ['delegate', 'review', 'investigation'])
    assert((await catalog.discover({ query })).items.some(item => item.name === 'collaboration_start'));
  const reference = discovery.items[0].reference;
  await catalog.select([reference], { expectedOwnerId: (await store.read()).ownerId,
    expectedSelectionRevision: discovery.selectionRevision, operationId: 'select-start' });
  assert.deepEqual(catalog.current().map(tool => tool.name), ['collaboration_start']);
  assert.ok(catalog.current()[0].jsonSchema.properties.sources, 'Selected source input retains the complete exact-sharing schema');
  const restored = new ToolCatalog({ sources: [source()], selectionStore: store });
  assert.deepEqual((await restored.refresh()).map(tool => tool.name), ['collaboration_start']);
  const changed = source({ toolNames: [] });
  assert.equal(changed.id, original.id);
  await assert.rejects(changed.load(reference), /different definition or host grant/);
  assert.deepEqual(await new ToolCatalog({ sources: [changed], selectionStore: store }).refresh(), []);
});

test('collaboration source refuses mixed host grants and copied unowned definitions', async () => {
  const options = { groupId: 'discovery-group', actorSessionId: 'supervisor',
    coordinator: () => { throw new Error('unused'); }, profiles: [] };
  const first = createCollaborationTools(createCollaborationToolHost({ ...options, capabilities: { toolNames: [] } }));
  const second = createCollaborationTools(createCollaborationToolHost({ ...options, capabilities: { toolNames: ['read_files'] } }));
  assert.throws(() => createCollaborationToolSource([first[0], second[1]]), /one exact host binding/);
  assert.throws(() => createCollaborationToolSource([{ ...first[0] }]), /one exact host binding/);
});
