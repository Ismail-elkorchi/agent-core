import type { CompiledModelRequest } from '@agent-core/model';
import { effectiveCapabilitySnapshotSchema, type EffectiveCapabilitySnapshot } from '../run/capabilities.js';

// Exact compiled-object association; never exported from the package API or used as admission authority.
const captured = new WeakMap<CompiledModelRequest, EffectiveCapabilitySnapshot>();
export function captureRequestCapabilities(compiled: CompiledModelRequest, snapshot: EffectiveCapabilitySnapshot): void {
  captured.set(compiled, effectiveCapabilitySnapshotSchema.parse(snapshot));
}
export function capturedRequestCapabilities(compiled: CompiledModelRequest): EffectiveCapabilitySnapshot | undefined {
  return captured.get(compiled);
}
