import { parseModelRequest, type ModelRequest } from '@agent-core/model';
import {
  decodeOwnedArtifactRef,
  type ArtifactRepository,
  type ProtectedArtifactRef
} from '@agent-core/persistence';
import { parseJsonObject } from '@agent-core/json';
import * as z from 'zod';

const contextPresentationSchema = z.strictObject({
  kind: z.enum(['host-context', 'runtime-notice']),
  applicability: z.literal('current-request'),
  update: z.literal('replace'),
  items: z.array(z.strictObject({ id: z.string().min(1), revision: z.string().min(1) }).readonly()).readonly(),
  fingerprint: z.string().min(1)
});

/** Exact current material selection whose placement is fixed by an admitted native prefix. */
export const requestPresentationSchema = z.strictObject({
  runtimeControl: z.strictObject({ kind: z.literal('context-recovery'), id: z.string().min(1), revision: z.string().min(1) }).readonly().optional(),
  authority: z.string(),
  context: contextPresentationSchema.extend({ kind: z.literal('host-context') }).readonly(),
  capacityNotice: contextPresentationSchema.extend({ kind: z.literal('runtime-notice') }).readonly(),
  runInstructions: z.string()
}).readonly();
export type RequestPresentation = z.infer<typeof requestPresentationSchema>;
export interface AdmittedModelInput {
  readonly runId: string;
  readonly request: ModelRequest;
  readonly presentation: RequestPresentation;
}

export function protectedInferenceInput(value: unknown): ProtectedArtifactRef {
  const ref = decodeOwnedArtifactRef(parseJsonObject(value));
  if (ref.visibility !== 'protected') throw new Error('Inference input must be protected.');
  return ref;
}

/** Read the original inference artifact, not a reconstructed conversation or display transcript. */
export async function readAdmittedModelInput(
  artifacts: ArtifactRepository,
  ref: ProtectedArtifactRef
): Promise<AdmittedModelInput> {
  const record = z
    .object({
      runId: z.string().min(1),
      logical: z.unknown(),
      presentation: requestPresentationSchema
    })
    .parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.readVerified(ref))
      ) as unknown
    );
  return {
    runId: record.runId,
    request: parseModelRequest(record.logical),
    presentation: record.presentation
  };
}

export class NativeContextTransitionRequired extends Error {
  constructor(
    readonly request: ModelRequest,
    reason: string
  ) {
    super(`Native context transition required: ${reason}`);
    this.name = 'NativeContextTransitionRequired';
  }
}
