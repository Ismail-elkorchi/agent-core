import * as z from 'zod';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import { materialRevocationSchema } from '../material/repository.js';
import type { MaterialOwner, MaterialRevocation, MaterialRevocationReceipt, MaterialAuthorityBoundary } from '../material/contracts.js';
import type { SessionStateItemRef } from './session-state.js';
import type { SessionMaterialRevocationEntry } from './contracts.js';
export const sessionMaterialRevocationSchema=materialRevocationSchema.unwrap().extend({type:z.literal('session_material_revocation'),id:z.string().min(1),parentId:z.string().nullable(),timestamp:z.string().min(1),revision:z.int().positive()}).readonly();
export function decodeSessionMaterialRevocation(value:unknown):SessionMaterialRevocationEntry {
  const record=sessionMaterialRevocationSchema.parse(value);
  if(record.owner.kind!=='session'||record.revision!==record.expectedRevision+1)throw new Error('Invalid session material revocation owner or revision.');
  if(new Set(record.refs.map(localMaterialRevocationKey)).size!==record.refs.length)throw new Error('Duplicate session material revocation target.');
  return record;
}
/** Revocation follows the immutable revision through inherited branches. */
export function localMaterialRevocationKey(ref:SessionStateItemRef):string {return hashJson({itemId:ref.itemId,revisionId:ref.revisionId});}
export function assertLocalMaterialOwner(sessionId:string,owner:MaterialOwner):asserts owner is Extract<MaterialOwner,{kind:'session'}> {if(owner.kind!=='session'||owner.sessionId!==sessionId)throw new Error('Local material owner belongs to another session.');}
export function assertLocalMaterialBoundaries(sessionId:string,revision:number,boundaries:readonly MaterialAuthorityBoundary[],branchId:string):void {
  if(boundaries.length>256)throw new RangeError('Local material boundary set exceeds 256 owners.');
  for(const boundary of boundaries){assertLocalMaterialOwner(sessionId,boundary.owner);if(boundary.owner.branchId!==branchId)throw new PersistenceConflictError('Session material branch authority changed.');if(boundary.revocationRevision!==revision)throw new PersistenceConflictError('Session material revocation boundary changed.');}
}
export function localMaterialRevocationReceipt(record:SessionMaterialRevocationEntry):MaterialRevocationReceipt {return Object.freeze({owner:record.owner,operationId:record.operationId,revision:record.revision,refs:record.refs});}
export function assertLocalMaterialRevocationRetry(record:SessionMaterialRevocationEntry,input:MaterialRevocation):MaterialRevocationReceipt {
  if(hashJson({owner:record.owner,operationId:record.operationId,expectedRevision:record.expectedRevision,refs:record.refs})!==hashJson(input))throw new PersistenceConflictError('Session material revocation operation changed.');
  return localMaterialRevocationReceipt(record);
}
