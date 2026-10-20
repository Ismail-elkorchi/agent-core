import path from 'node:path';
import { JsonlEventRepository, withPersistenceFileLock } from '@agent-core/persistence/node';
import { EventIntentionRepository, intentionEventCodec, intentionStreamKey } from './repository.js';
export interface JsonlIntentionRepositoryOptions { readonly rootDir: string }
export class JsonlIntentionRepository extends EventIntentionRepository {
  constructor(options: JsonlIntentionRepositoryOptions) {
    const root = path.resolve(options.rootDir);
    super(new JsonlEventRepository({ rootDir: path.join(root, 'events'), codec: intentionEventCodec }),
      (ownerId, intentionId, operation) => withPersistenceFileLock(path.join(root, 'intentions', intentionStreamKey(ownerId, intentionId)), 10000, operation));
  }
}
