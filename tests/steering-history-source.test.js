import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventRepository } from '@agent-core/persistence';
import {
  HistoryReader,
  InMemorySessionRepository,
  agentEventCodec,
  sourceRef
} from '@agent-core/runtime';

test('accepted steering remains an original history source when its session copy is absent', async () => {
  const sessions = new InMemorySessionRepository();
  const session = await sessions.create({
    binding: { schemaId: 'tests/steering-history', schemaVersion: 1, subject: {} }
  });
  await sessions.appendInput(session, { runId: 'original-run', task: 'Continue the task.' });
  const events = new InMemoryEventRepository(agentEventCodec);
  const accepted = await events.append('original-run', {
    type: 'input.steering.accepted',
    deliveryId: 'correction',
    content: 'The corrected identifier is ORCHID-492.'
  });
  await events.append('original-run', {
    type: 'input.steering.local_applied',
    deliveryId: 'correction'
  });

  const reader = new HistoryReader({ repository: sessions, session, events });
  const view = await reader.page();
  const original = view.entries.find((entry) => entry.type === 'steering');
  assert.ok(original, 'The committed run ledger must fill the missing session copy.');
  const source = sourceRef(session.id, original);
  assert.equal(source.event.eventId, accepted.eventId);
  assert.equal(source.event.hash, accepted.hash);
  const reopened = new HistoryReader({ repository: sessions, session, events });
  const result = await reopened.read({ source });
  assert.equal(result.status, 'available');
  assert.match(result.item.text, /ORCHID-492/u);
  assert.equal(
    (await reopened.page()).entries.filter((entry) => entry.type === 'steering').length,
    1
  );
});
