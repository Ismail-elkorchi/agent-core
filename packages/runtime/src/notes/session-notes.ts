import type { HistoryReader } from '../history/reader.js';
import type { NoteReadRequest, NoteRepository } from './contracts.js';

export type SessionNoteRead = Pick<NoteReadRequest, 'noteId' | 'revisionId' | 'offset'>;

/** Scope comes from the selected history, never from a caller's claimed session. */
export class SessionNotes {
  constructor(
    private readonly history: HistoryReader,
    private readonly notes: NoteRepository
  ) {}

  async list(cursor?: string) {
    const scope = await this.scope();
    return this.notes.list({ scope, cursor });
  }

  async read(request: SessionNoteRead) {
    return this.notes.read({ ...request, scope: await this.scope() });
  }

  private async scope() {
    const { sessionId, branchId } = await this.history.capture();
    return { sessionId, branchId };
  }
}
