import * as z from 'zod';
import { parseJsonObject } from '@agent-core/json';
import { decodeOwnedArtifactRef, hashArtifactBytes, hashJson } from '@agent-core/persistence';
import { historyCutSchema, sourceSchema } from '../history/schema.js';

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().refine(value => !/[\uD800-\uDFFF]/u.test(value), 'Shared text must be well-formed Unicode.');
export const peerEndpointSchema = z.strictObject({ participantId: id, sessionId: id }).readonly();
export const scopedShareRangeSchema = z.strictObject({ offset: z.int().nonnegative(), bytes: z.int().positive().max(1024 * 1024) }).readonly();
export const publicShareArtifactInputSchema = z.strictObject({ artifactId: id, sha256: digest, size: z.int().nonnegative(), mediaType: id, visibility: z.literal('public', { error: 'Only explicitly authorized public artifacts can be shared.' }), label: z.string().optional(), description: z.string().optional() });
/** References describe a scope; possession of a reference never authorizes access. */
export const scopedShareSourceInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('history'), cut: historyCutSchema, source: sourceSchema, range: scopedShareRangeSchema }).readonly(),
  z.strictObject({ kind: z.literal('session_state'), cut: historyCutSchema, itemId: id, revisionId: id, contentSha256: digest, range: scopedShareRangeSchema }).readonly(),
  z.strictObject({ kind: z.literal('public_artifact'), artifact: publicShareArtifactInputSchema, range: scopedShareRangeSchema }).readonly()
]);
/** Own canonical artifact references at the runtime boundary without duplicating tool schemas. */
export const scopedShareSourceSchema = scopedShareSourceInputSchema.transform(value => {
  if (value.kind !== 'public_artifact') return value;
  const artifact = decodeOwnedArtifactRef(parseJsonObject(value.artifact));
  if (artifact.visibility !== 'public') throw new Error('Only explicitly authorized public artifacts can be shared.');
  return Object.freeze({ ...value, artifact: Object.freeze(artifact) });
});
export const scopedShareGrantSchema = z.strictObject({
  grantId: id, revision: z.int().positive(), groupId: id,
  sender: peerEndpointSchema, recipient: peerEndpointSchema,
  correctionEpoch: z.int().nonnegative(), source: scopedShareSourceSchema
}).readonly();
export type PeerEndpoint = z.infer<typeof peerEndpointSchema>;
export type ScopedShareSource = z.infer<typeof scopedShareSourceSchema>;
export type ScopedShareGrant = z.infer<typeof scopedShareGrantSchema>;
export type ScopedShareAuthorizationStage = 'read' | 'materialize' | 'admit' | 'publish';
export const scopedShareMaterialBodySchema = z.strictObject({
  grant: scopedShareGrantSchema, text, mediaType: id,
  sourceType: z.enum(['input', 'steering', 'assistant', 'tool_call', 'observation', 'session_state', 'public_artifact']),
  sourceRole: z.enum(['user', 'assistant', 'tool', 'control']), contentSha256: digest
}).readonly();
export const scopedShareMaterialSchema = scopedShareMaterialBodySchema.unwrap().extend({ fingerprint: digest }).readonly();
export type ScopedShareMaterial = z.infer<typeof scopedShareMaterialSchema>;
export interface ScopedShareLimits { readonly maxBytes: number; readonly maxSourceBytes?: number }
export function ownScopedShareMaterial(value: unknown): ScopedShareMaterial {
  const material = scopedShareMaterialSchema.parse(value);
  const { fingerprint, ...body } = material;
  if (hashJson(body) !== fingerprint || hashArtifactBytes(Buffer.from(material.text)) !== material.contentSha256)
    throw new Error('Shared material fingerprint does not match its exact content and scope.');
  if (Buffer.byteLength(material.text) !== material.grant.source.range.bytes)
    throw new Error('Shared material does not cover its exact authorized range.');
  return material;
}
