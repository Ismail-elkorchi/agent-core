import * as z from 'zod';
import { hashJson, PersistenceConflictError } from '@agent-core/persistence';
import { peerEndpointSchema, scopedShareMaterialSchema, ownScopedShareMaterial } from '../collaboration/share-contracts.js';
import type { SessionPeerContributionEntry } from './contracts.js';

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const bodySchema = z.strictObject({
  deliveryId: id, groupId: id, sender: peerEndpointSchema, recipient: peerEndpointSchema,
  assignmentId: id, assignmentRevision: z.int().positive(), senderRunId: id,
  correctionEpoch: z.int().nonnegative(),
  content: z.string().max(1024 * 1024).refine(value => !/[\uD800-\uDFFF]/u.test(value), 'Peer content must be well-formed Unicode.'),
  shares: z.array(scopedShareMaterialSchema).max(64).readonly()
}).readonly();
export const peerContributionInputSchema = bodySchema.unwrap().extend({ fingerprint: digest }).readonly();
export type PeerContributionInput = z.infer<typeof peerContributionInputSchema>;
export function peerContributionFingerprint(value: Omit<PeerContributionInput, 'fingerprint'>): string {
  return hashJson(bodySchema.parse(value));
}
export function ownPeerContributionInput(value: unknown): PeerContributionInput {
  const input = peerContributionInputSchema.parse(value);
  const { fingerprint, ...body } = input;
  if (peerContributionFingerprint(body) !== fingerprint) throw new Error('Peer contribution fingerprint disagrees with its content and attribution.');
  for (const raw of input.shares) {
    const share = ownScopedShareMaterial(raw);
    if (share.grant.groupId !== input.groupId || hashJson(share.grant.sender) !== hashJson(input.sender) ||
        hashJson(share.grant.recipient) !== hashJson(input.recipient) || share.grant.correctionEpoch !== input.correctionEpoch)
      throw new Error('Shared material does not belong to this peer contribution scope.');
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new RangeError('Peer contribution exceeds its full envelope byte allowance.');
  return input;
}
export function decodePeerContributionEntry(value: unknown): SessionPeerContributionEntry {
  const entry = z.strictObject({
    id, parentId: id.nullable(), timestamp: id, type: z.literal('peer_contribution'),
    authorship: z.literal('model'), contribution: peerContributionInputSchema
  }).readonly().parse(value);
  return Object.freeze({ ...entry, contribution: ownPeerContributionInput(entry.contribution) });
}
export function samePeerContribution(existing: SessionPeerContributionEntry, input: PeerContributionInput): SessionPeerContributionEntry {
  if (existing.contribution.fingerprint !== input.fingerprint || hashJson(existing.contribution) !== hashJson(input))
    throw new PersistenceConflictError(`Conflicting peer delivery ${input.deliveryId}.`);
  return existing;
}
/** The envelope is attributable model-authored reference material, never recipient instructions. */
export function peerContributionText(entry: SessionPeerContributionEntry): string {
  return JSON.stringify({ authorship: 'model', ...entry.contribution });
}
