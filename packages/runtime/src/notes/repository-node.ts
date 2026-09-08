import type { JsonValue } from '@agent-core/json';
import type { ArtifactRepository } from '@agent-core/persistence';
import { JsonlEventRepository } from '@agent-core/persistence/node';
import type { NoteQuotas } from './contracts.js';
import { EventNoteRepository, noteEventCodec } from './repository.js';
export interface JsonlNoteRepositoryOptions {
  readonly rootDir: string;
  readonly artifacts: ArtifactRepository;
  readonly quotas?: Partial<NoteQuotas>;
  readonly jsonSchemas?: Readonly<Record<string, (value: JsonValue) => JsonValue>>;
}
export class JsonlNoteRepository extends EventNoteRepository {
  constructor(options: JsonlNoteRepositoryOptions) {
    super({
      events: new JsonlEventRepository({ rootDir: options.rootDir, codec: noteEventCodec }),
      artifacts: options.artifacts,
      ...(options.quotas ? { quotas: options.quotas } : {}),
      ...(options.jsonSchemas ? { jsonSchemas: options.jsonSchemas } : {})
    });
  }
}
