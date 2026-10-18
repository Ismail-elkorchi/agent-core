import * as z from 'zod';
import { ToolInputError, type ResourceLeaseCoordinator } from '@agent-core/tools';
import { fitBoundedJsonPage } from './bounded-result.js';
import { parseContextControlPolicy, type ContextControlPolicy, type OutputReservationPolicy } from '../context/recovery.js';
import type { ModelProfile } from '@agent-core/model';
import type { InferenceService } from '../inference/service.js';
import { CAPABILITY_INSPECTION_LIMITS, inspectCapabilitySnapshot, type EffectiveCapabilitySnapshot } from '../run/capabilities.js';

export interface ContextOperationalInspectionPage {
  readonly target?: 'configured' | 'last_admitted' | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
  readonly expectedRevision?: string | undefined;
  /** Bounds the complete operational projection, including its fixed metadata. */
  readonly maxBytes?: number | undefined;
}
export const contextOperationalInspectionPageSchema = z.strictObject({
  target: z.enum(['configured', 'last_admitted']).optional(), offset: z.int().nonnegative().optional(),
  limit: z.int().min(1).max(CAPABILITY_INSPECTION_LIMITS.maxLimit).optional(),
  expectedRevision: z.string().min(1).max(512).optional(),
  maxBytes: z.int().positive().max(262144).optional()
});
export interface ContextAdmittedCapabilities {
  readonly inputIdentity: string;
  readonly protocolCapabilityRevision: string;
  readonly snapshot: EffectiveCapabilitySnapshot;
}
/** Assemble the same observational contract during a run and while the session is idle. */
export async function inspectSessionOperational(input: {
  readonly configured: EffectiveCapabilitySnapshot;
  readonly profile: ModelProfile;
  readonly outputReservation: number;
  readonly configuredOutputReservation?: number;
  readonly contextControlPolicy?: Partial<ContextControlPolicy>;
  readonly outputReservationPolicy?: OutputReservationPolicy;
  readonly inference: InferenceService;
  readonly ownerId?: string;
  readonly contextAdmission?: ContextAdmittedCapabilities;
  readonly resources?: ReturnType<ResourceLeaseCoordinator['inspect']>;
  readonly page?: ContextOperationalInspectionPage;
}) {
  const durable = input.ownerId ? await input.inference.inspectLatestAdmission(input.ownerId) : null;
  const latest = input.contextAdmission ?? durable;
  const invocation = durable && durable.inputIdentity === latest?.inputIdentity ? durable : null;
  const target = input.page?.target ?? 'configured';
  const selected = target === 'last_admitted' ? latest?.snapshot : input.configured;
  const result = Object.freeze({
    capabilityTarget: target,
    capabilities: selected ? inspectCapabilitySnapshot(selected, input.page) : null,
    configuredRevision: input.configured.revision,
    lastAdmittedCoverage: latest?.snapshot ? 'available' as const : latest ? 'catalog_not_recorded' as const : 'none_recorded' as const,
    admissionEvidence: input.contextAdmission ? 'live_context_admission' as const : durable ? 'durable_invocation' as const : 'none' as const,
    lastAdmittedRequest: latest ? Object.freeze({ inputIdentity: latest.inputIdentity,
      protocolCapabilityRevision: latest.protocolCapabilityRevision, catalogRevision: latest.snapshot?.revision ?? null,
      bindingId: latest.snapshot?.bindingId ?? null, contextAdmission: 'admitted' as const,
      invocation: invocation ? { invocationId: invocation.invocationId, runId: invocation.runId,
        status: invocation.invocationStatus, dispatch: invocation.dispatch, purpose: invocation.purpose } : null }) : null,
    contextControlPolicy: parseContextControlPolicy(input.contextControlPolicy),
    generation: Object.freeze({ outputReservation: input.outputReservation,
      configuredOutputReservation: input.configuredOutputReservation ?? input.outputReservation,
      policy: input.outputReservationPolicy ?? { fixed: input.configuredOutputReservation ?? input.outputReservation },
      enforcement: input.profile.supportedParameters.includes('maxOutputTokens') ? 'provider-cap' as const : 'reservation-only' as const }),
    allowance: input.ownerId ? await input.inference.inspectOwnerAllowance(input.ownerId) : null,
    resources: input.resources ?? null,
    meaning: 'Configured eligibility, context admission, invocation lifecycle, owner allowance and resources are independent observations, not an atomic snapshot or permission. Transactional admission and per-call authorization still apply.'
  });
  const maxBytes = input.page?.maxBytes ?? 32768;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144)
    throw new RangeError('Operational inspection maxBytes must be between 1 and 262144.');
  return fitBoundedJsonPage(result.capabilities?.items ?? [], items => Object.freeze({ ...result,
    capabilities: selected && result.capabilities ? inspectCapabilitySnapshot(selected, {
      offset: result.capabilities.offset, limit: Math.max(1, items.length), expectedRevision: result.capabilities.revision
    }) : null
  }), maxBytes, requiredBytes => {
    throw new ToolInputError('Operational inspection cannot fit its minimum complete page; increase maxBytes to the measured requiredBytes.', {
      code: 'runtime_inspection_max_bytes', requiredBytes, requestedMaxBytes: maxBytes,
      retry: requiredBytes <= 262144 ? { maxBytes: requiredBytes, limit: 1,
        offset: input.page?.offset ?? 0, target, ...(selected ? { expectedRevision: selected.revision } : {}) } : null
    });
  });
}
export type SessionOperationalInspection = Awaited<ReturnType<typeof inspectSessionOperational>>;
