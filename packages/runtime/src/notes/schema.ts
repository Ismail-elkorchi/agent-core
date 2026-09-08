import * as z from 'zod';
import { parseJsonValue } from '@agent-core/json';
import { scopeSchema, sourceSchema } from '../history/schema.js';
const identifier = z.string().min(1).max(512);
const mutation = {
  scope: scopeSchema,
  noteId: identifier,
  expectedRevision: identifier.nullable(),
  idempotencyKey: identifier,
  authorId: identifier,
  invocationId: identifier
};
export const noteRemoveSchema = z.strictObject(mutation);
export const noteWriteSchema = z.strictObject({
  ...mutation,
  title: identifier,
  mediaType: z.enum(['text/plain', 'text/markdown', 'application/json']),
  content: z.json().transform((value) =>
    parseJsonValue(value, {
      maxDepth: 64,
      maxCollectionEntries: 100_000,
      maxStringBytes: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024
    })
  ),
  schemaId: identifier.optional(),
  sources: z.array(sourceSchema).max(1000).readonly().optional()
});
