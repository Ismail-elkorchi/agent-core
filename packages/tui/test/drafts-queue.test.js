import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDraft,
  draftFromSubmission,
  draftSubmission,
  sameDraft,
  rememberPrompt,
  navigatePromptHistory,
  emptyPromptHistory,
  createQueue,
  updateQueue
} from '@agent-core/tui';
import { FileDraftStorage } from '@agent-core/tui/node';
import { textAreaReducer } from '@ismail-elkorchi/terminal-ui/behavior';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';

const attachment = {
  id: 'image',
  kind: 'image',
  label: 'Screen capture',
  image: {
    artifact: {
      artifactId: 'image',
      visibility: 'public',
      mediaType: 'image/png',
      sha256: 'a'.repeat(64),
      size: 4
    }
  }
};
test('native drafts retain source, caret, selection and images across a private-store restart', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-drafts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = createDraft('Literal\ttext\r\n🙂\n', [attachment]);
  const draft = {
    ...original,
    input: {
      ...original.input,
      caret: { position: { offset: 7, affinity: 'upstream' } },
      selection: {
        anchor: { offset: 0, affinity: 'downstream' },
        focus: { offset: 7, affinity: 'upstream' }
      }
    }
  };
  await new FileDraftStorage(directory).write('session/one', draft);
  const restored = await new FileDraftStorage(directory).read('session/one');
  assert.equal(textDocumentText(restored.input.document), 'Literal\ttext\r\n🙂\n');
  assert.deepEqual(restored.input.caret, draft.input.caret);
  assert.deepEqual(restored.input.selection, draft.input.selection);
  assert.deepEqual(restored.attachments, [attachment]);
  assert.equal(await new FileDraftStorage(directory).read('session/two'), undefined);
  assert.deepEqual(draftSubmission(restored).images, [attachment.image]);
});

test('an admission receipt cannot erase a draft edited back to the submitted text', () => {
  const draft = createDraft('Original', [attachment]);
  const edited = textAreaReducer(draft.input, {
    kind: 'edit',
    operation: { kind: 'insert', text: '!' }
  }).state;
  const undone = textAreaReducer(edited, { kind: 'undo' }).state;
  assert.equal(textDocumentText(undone.document), 'Original');
  assert.equal(sameDraft({ ...draft, input: undone }, draft), false);
  const history = rememberPrompt(emptyPromptHistory, draft);
  const unsent = createDraft('Unsent');
  const previous = navigatePromptHistory(history, unsent, 'previous');
  assert.deepEqual(previous.draft.attachments, [attachment]);
  assert.equal(navigatePromptHistory(previous.history, previous.draft, 'next').draft, unsent);
});

test('queue revision preserves native input, and a claimed input cannot be returned as unsent', async () => {
  const input = draftSubmission(createDraft('Original', [attachment]));
  const submission = { submissionId: 'submission', runId: 'run', state: 'queued', input };
  const changes = [];
  let claimed = false;
  const operations = {
    readPendingSubmissions: async () => [submission],
    updateQueuedSubmission: async (id, change) => {
      if (claimed) throw new Error('Submission is no longer queued');
      changes.push({ id, change });
    }
  };
  let state = createQueue(operations, 'session').state;
  state = updateQueue(
    state,
    { type: 'queue.loaded', id: state.id, submissions: [submission] },
    operations
  ).state;
  state = updateQueue(
    state,
    { type: 'queue.select', submissionId: submission.submissionId },
    operations
  ).state;
  const result = updateQueue(state, { type: 'queue.save' }, operations);
  await result.effects[0].run({ signal: new AbortController().signal });
  assert.deepEqual(changes[0].change.input.images, [attachment.image]);
  assert.deepEqual(changes[0].change.expectedInput, input);
  claimed = true;
  const withdraw = updateQueue(state, { type: 'queue.withdraw' }, operations);
  await assert.rejects(
    withdraw.effects[0].run({ signal: new AbortController().signal }),
    /no longer queued/
  );
  assert.deepEqual(draftSubmission(draftFromSubmission(input)), input);
});
