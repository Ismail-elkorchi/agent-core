import path from 'node:path';
import { JsonlEventRepository, withPersistenceFileLock } from '@agent-core/persistence/node';
import { EventMaterialRepository, materialEventCodec } from './repository.js';
export interface JsonlMaterialRepositoryOptions { readonly rootDir:string; readonly lockTimeoutMs?:number }
export class JsonlMaterialRepository extends EventMaterialRepository {
  constructor(options:JsonlMaterialRepositoryOptions){
    const root=path.resolve(options.rootDir);
    super(new JsonlEventRepository({rootDir:path.join(root,'events'),codec:materialEventCodec}),
      {withOwner:(key,operation)=>withPersistenceFileLock(path.join(root,'publication',key),options.lockTimeoutMs??5000,operation)});
  }
}
