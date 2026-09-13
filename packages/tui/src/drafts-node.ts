import { parseJsonObject, type JsonObject } from '@agent-core/json';
import { atomicWritePrivateJson } from '@agent-core/persistence/node';
import {
  decodePromptContextItemInput,
  decodeSessionInputRelationship,
  parseSessionImages
} from '@agent-core/runtime';
import { createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import { textDocumentText, type TextPosition } from '@ismail-elkorchi/terminal-ui/text';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ComposerDraft, DraftAttachment, DraftStorage } from './draft.js';

/** Application-scoped draft storage; keys are opaque session identities, never filesystem paths. */
export class FileDraftStorage implements DraftStorage {
  constructor(private readonly directory: string) {}
  async read(sessionId: string): Promise<ComposerDraft | undefined> {
    return this.readFile(this.file(sessionId));
  }
  private async readFile(file: string): Promise<ComposerDraft | undefined> {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    const value = parseJsonObject(JSON.parse(content), {
      maxStringBytes: 8 * 1024 * 1024,
      maxTotalBytes: 16 * 1024 * 1024
    });
    exact(value, ['text', 'caret', 'selection', 'attachments', 'instructions', 'relationship']);
    if (typeof value.text !== 'string' || !Array.isArray(value.attachments))
      throw new Error('Invalid saved draft.');
    const text = value.text;
    const instructions = value.instructions;
    if (
      instructions !== undefined &&
      (!Array.isArray(instructions) ||
        !instructions.every((item): item is string => typeof item === 'string'))
    )
      throw new Error('Invalid saved draft instructions.');
    const caret = position(value.caret, text);
    const selection = value.selection === undefined ? undefined : object(value.selection);
    if (selection !== undefined) exact(selection, ['anchor', 'focus']);
    return {
      input: createTextAreaState({
        value: text,
        caret: { position: caret },
        ...(selection === undefined
          ? {}
          : {
              selection: {
                anchor: position(selection.anchor, text),
                focus: position(selection.focus, text)
              }
            })
      }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(value.relationship === undefined
        ? {}
        : { relationship: decodeSessionInputRelationship(value.relationship) }),
      attachments: value.attachments.map(attachment)
    };
  }
  write(sessionId: string, draft: ComposerDraft): Promise<void> {
    return atomicWritePrivateJson(
      this.file(sessionId),
      parseJsonObject(
        {
          text: textDocumentText(draft.input.document),
          caret: draft.input.caret.position,
          ...(draft.input.selection === undefined ? {} : { selection: draft.input.selection }),
          attachments: draft.attachments,
          ...(draft.instructions === undefined ? {} : { instructions: draft.instructions }),
          ...(draft.relationship === undefined ? {} : { relationship: draft.relationship })
        },
        { maxStringBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 }
      )
    );
  }
  async recover(sessionId: string, draft: ComposerDraft): Promise<void> {
    const store = new FileDraftStorage(`${this.file(sessionId)}.recovered`);
    await store.write(randomUUID(), draft);
  }
  async readRecovered(sessionId: string): Promise<readonly ComposerDraft[]> {
    const directory = `${this.file(sessionId)}.recovered`;
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const drafts: ComposerDraft[] = [];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
      const draft = await this.readFile(path.join(directory, file));
      if (draft !== undefined) drafts.push(draft);
    }
    return drafts;
  }
  private file(sessionId: string): string {
    return path.join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  }
}
function attachment(value: unknown): DraftAttachment {
  const input = object(value);
  if (typeof input.id !== 'string' || typeof input.label !== 'string')
    throw new Error('Invalid saved attachment identity.');
  const base = { id: input.id, label: input.label };
  if (input.kind === 'context') {
    exact(input, ['id', 'label', 'kind', 'item']);
    return { ...base, kind: 'context', item: decodePromptContextItemInput(input.item) };
  }
  if (input.kind !== 'image') throw new Error('Unsupported saved attachment.');
  exact(input, ['id', 'label', 'kind', 'image']);
  const [image] = parseSessionImages([input.image]);
  if (image === undefined) throw new Error('Saved image is missing.');
  return { ...base, kind: 'image', image };
}
function position(value: unknown, text: string): TextPosition {
  const input = object(value);
  exact(input, ['offset', 'affinity']);
  if (
    typeof input.offset !== 'number' ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > text.length ||
    (input.affinity !== 'upstream' && input.affinity !== 'downstream')
  )
    throw new Error('Invalid saved draft position.');
  return { offset: input.offset, affinity: input.affinity };
}
function object(value: unknown): JsonObject {
  return parseJsonObject(value, { maxStringBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 });
}
function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Unsupported saved draft field.');
}
