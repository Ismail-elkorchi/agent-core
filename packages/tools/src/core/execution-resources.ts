import type { JsonObject } from '@agent-core/json';
import type { ResourceLeaseCoordinator } from './resource-leases.js';

/** A release result remains available until its owning ledger acknowledges it. */
export interface ResourceReleaseReport {
  readonly resourceId: string;
  readonly outcome: 'released' | 'unknown';
  readonly details: JsonObject;
}

/** Application-granted resources; causal call identity and lifetime ownership are independent. */
export type ResourceLifetime =
  | { readonly kind: 'run' }
  | { readonly kind: 'owner'; readonly ownerId: string };

export interface ExecutionResources {
  readonly lifetime: ResourceLifetime;
  readonly capabilities: readonly string[];
  readonly resourceLeases: ResourceLeaseCoordinator;
  release(ownerId: string): Promise<readonly ResourceReleaseReport[]>;
  acknowledge(resourceId: string): Promise<void>;
}
