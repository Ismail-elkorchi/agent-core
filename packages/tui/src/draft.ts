import { ownSessionSubmissionInput, type SessionSubmissionInput } from '@agent-core/runtime';
import { createTextAreaState, type TextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import { textCaretAt, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';

export type DraftAttachment =
  | {
      readonly id: string;
      readonly label: string;
      readonly kind: 'image';
      readonly image: NonNullable<SessionSubmissionInput['images']>[number];
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly kind: 'context';
      readonly item: NonNullable<SessionSubmissionInput['contextItems']>[number];
    };
export interface ComposerDraft extends Pick<SessionSubmissionInput, 'instructions' | 'relationship'> {
  readonly input: TextAreaState;
  readonly attachments: readonly DraftAttachment[];
}
export function createDraft(text = '', attachments: readonly DraftAttachment[] = []): ComposerDraft {
  return { input: createTextAreaState({ value: text, caret: textCaretAt(text.length) }), attachments };
}
export function draftSubmission(draft: ComposerDraft): SessionSubmissionInput {
  const images = draft.attachments.flatMap((entry) => (entry.kind === 'image' ? [entry.image] : []));
  const contextItems = draft.attachments.flatMap((entry) => (entry.kind === 'context' ? [entry.item] : []));
  return ownSessionSubmissionInput({
    ...(draft.instructions === undefined ? {} : { instructions: draft.instructions }),
    ...(draft.relationship === undefined ? {} : { relationship: draft.relationship }),
    task: textDocumentText(draft.input.document),
    ...(images.length ? { images } : {}),
    ...(contextItems.length ? { contextItems } : {})
  });
}
export function draftFromSubmission(input: SessionSubmissionInput): ComposerDraft {
  return {
    ...createDraft(input.task, [
      ...(input.images?.map(
        (image, index): DraftAttachment => ({
          id: crypto.randomUUID(),
          label: `Image ${String(index + 1)} · ${image.artifact.mediaType}`,
          kind: 'image',
          image
        })
      ) ?? []),
      ...(input.contextItems?.map(
        (item): DraftAttachment => ({ id: crypto.randomUUID(), label: item.title, kind: 'context', item })
      ) ?? [])
    ]),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.relationship === undefined ? {} : { relationship: input.relationship })
  };
}
/** A late receipt cannot clear a draft edited back to the same text, or another session's draft. */
export function sameDraft(current: ComposerDraft, submitted: ComposerDraft): boolean {
  return (
    current.input === submitted.input &&
    current.attachments === submitted.attachments &&
    current.instructions === submitted.instructions &&
    current.relationship === submitted.relationship
  );
}

export interface DraftStorage {
  recover(sessionId: string, draft: ComposerDraft): Promise<void>;
  readRecovered(sessionId: string): Promise<readonly ComposerDraft[]>;
  read(sessionId: string): Promise<ComposerDraft | undefined>;
  write(sessionId: string, draft: ComposerDraft): Promise<void>;
}

export type DraftMessage =
  | {
      readonly type: 'draft.loaded';
      readonly sessionId: string;
      readonly original: ComposerDraft;
      readonly draft: ComposerDraft | undefined;
    }
  | { readonly type: 'draft.failed'; readonly sessionId: string; readonly message: string };
export function loadDraft(
  storage: DraftStorage,
  sessionId: string,
  original: ComposerDraft
): import('@ismail-elkorchi/terminal-ui/tui').TuiEffect<DraftMessage> {
  return {
    id: 'draft-load',
    concurrency: 'replace',
    async run({ signal }) {
      const draft = await storage.read(sessionId);
      signal.throwIfAborted();
      return { kind: 'message', message: { type: 'draft.loaded', sessionId, original, draft } };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: { type: 'draft.failed', sessionId, message: diagnostic.message }
    })
  };
}
