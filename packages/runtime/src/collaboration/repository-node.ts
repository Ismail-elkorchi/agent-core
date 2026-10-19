import path from 'node:path';
import { JsonlEventRepository, tryAcquirePersistenceFileLock } from '@agent-core/persistence/node';
import { EventCollaborationRepository, collaborationEventCodec, collaborationGroupKey } from './repository.js';
export interface JsonlCollaborationRepositoryOptions { readonly rootDir:string }
/** The lifetime guard is separate from append locks and survives gaps between participant runs. */
export class JsonlCollaborationRepository extends EventCollaborationRepository {
  constructor(options:JsonlCollaborationRepositoryOptions) {
    const root=path.resolve(options.rootDir);
    super(new JsonlEventRepository({rootDir:path.join(root,'events'),codec:collaborationEventCodec}),groupId=>tryAcquirePersistenceFileLock(path.join(root,'hosts',collaborationGroupKey(groupId))));
  }
}
