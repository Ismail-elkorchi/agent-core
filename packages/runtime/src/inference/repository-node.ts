import { JsonlEventRepository } from '@agent-core/persistence/node';
import { EventInferenceRepository, inferenceEventCodec } from './repository.js';
export interface JsonlInferenceRepositoryOptions {
  readonly rootDir: string;
}
export class JsonlInferenceRepository extends EventInferenceRepository {
  constructor(options: JsonlInferenceRepositoryOptions) {
    super(
      new JsonlEventRepository({
        rootDir: options.rootDir,
        codec: inferenceEventCodec
      })
    );
  }
}
