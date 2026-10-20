import type { JsonObject } from '@agent-core/json';
import type { EventLedgerTail } from '@agent-core/persistence';
import type { AgentSession } from '../session/agent-session.js';
import type { SessionSubmissionInput, SessionTriggeredSubmissionReceipt } from '../session/contracts.js';

export type IntentionCondition =
  | { readonly kind: 'time'; readonly notBefore: string }
  | { readonly kind: 'event'; readonly topic: string; readonly condition: JsonObject };
/** Only embedding hosts accept intentions; conversational suggestions are not acceptance. */
export interface AcceptIntentionInput {
  readonly ownerId: string;
  readonly intentionId: string;
  readonly sessionId: string;
  readonly authorizationRef: string;
  readonly condition: IntentionCondition;
  readonly input: Omit<SessionSubmissionInput, 'origin' | 'relationship'>;
}
export interface HostWakeTrigger {
  readonly key: string;
  readonly evidence: JsonObject;
}
export interface RecordedIntentionTrigger extends HostWakeTrigger {
  readonly intentionRevision: number;
}
interface IntentionIdentity extends AcceptIntentionInput {
  readonly revision: number;
  readonly acceptedAt: string;
  readonly updatedAt: string;
}
export type DurableIntention = IntentionIdentity & (
  | { readonly status: 'pending' }
  | { readonly status: 'triggered'; readonly trigger: RecordedIntentionTrigger }
  | { readonly status: 'admitted'; readonly trigger: RecordedIntentionTrigger; readonly receipt: SessionTriggeredSubmissionReceipt }
  | { readonly status: 'completed'; readonly trigger: RecordedIntentionTrigger; readonly receipt: SessionTriggeredSubmissionReceipt; readonly outcome: 'completed' | 'failed' | 'cancelled' }
  | { readonly status: 'cancelled'; readonly reason: string }
);
export interface IntentionCursor {
  readonly ownerId: string;
  readonly afterSequence: number;
  readonly through: EventLedgerTail;
}
export interface IntentionPageRequest {
  readonly cursor?: IntentionCursor;
  readonly limit?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}
export interface IntentionPage {
  readonly intentions: readonly DurableIntention[];
  readonly coverage: 'complete' | 'partial';
  readonly cursor?: IntentionCursor;
}
export interface IntentionRepository {
  accept(input: AcceptIntentionInput, acceptedAt: string): Promise<DurableIntention>;
  read(ownerId: string, intentionId: string): Promise<DurableIntention | undefined>;
  list(ownerId: string, request?: IntentionPageRequest): Promise<IntentionPage>;
  withIntention<T>(ownerId: string, intentionId: string, operation: (publication: {
    readonly current: DurableIntention;
    assertOwned(): Promise<void>;
    /** Publish the next revision while retaining the cancellation/admission fence. */
    replace(next: DurableIntention): Promise<DurableIntention>;
  }) => Promise<T>): Promise<T>;
}
export interface HostWakeAdapter {
  now(): string;
  /** Bounded host clock/event lookup. No inference loop or timer is installed by Core. */
  evaluate(intention: DurableIntention, options: { readonly signal?: AbortSignal }): Promise<HostWakeTrigger | undefined>;
  /** Recheck original authorization and live condition under the host's current authority/correction
   * fence, and retain that fence until operation commits. Throw when either is false or stale.
   * Evidence and remembered approval text cannot grant authority.
   */
  withAdmission<T>(intention: DurableIntention, trigger: RecordedIntentionTrigger, operation: () => Promise<T>): Promise<T>;
}
export type HostWakeSession = Pick<AgentSession, 'submitTriggered' | 'readTriggeredSubmissionReceipt' | 'readSubmission' | 'updateQueuedSubmission'>;
export interface HostWakeServiceOptions {
  readonly repository: IntentionRepository;
  readonly adapter: HostWakeAdapter;
  readonly resolveSession: (sessionId: string) => Promise<HostWakeSession>;
}
export interface HostWakeRecoveryPage {
  readonly intentions: readonly DurableIntention[];
  readonly failures: readonly { readonly intentionId: string; readonly message: string }[];
  readonly coverage: 'complete' | 'partial';
  readonly cursor?: IntentionCursor;
}
