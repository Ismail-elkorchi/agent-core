import type { AgentRunState } from './contracts.js';

/** Validate relationships in a composition of already decoded run values. */
export function assertAgentRunStateInvariants(state: AgentRunState): void {
  const { providerRequests, toolBatches, phase, revision, control, runId } = state;
  if (
    new Set(
      providerRequests.map(
        (request) => `${request.identity.turnId}:${String(request.identity.requestAttempt)}`
      )
    ).size !== providerRequests.length
  ) {
    throw new TypeError('Provider request identities must be unique.');
  }
  if (new Set(toolBatches.map((batch) => batch.toolBatchId)).size !== toolBatches.length) {
    throw new TypeError('Tool batch identities must be unique.');
  }
  const effectIds = new Set<string>();
  for (const effect of [
    ...providerRequests.flatMap((request) => (request.stage === 'ready' ? [] : [request.effect])),
    ...toolBatches.flatMap((batch) =>
      batch.callStates.flatMap((call) =>
        call.stage === 'ready' || call.stage === 'approval' || !call.effect ? [] : [call.effect]
      )
    )
  ]) {
    if (effect.intent.ownerId !== state.runId || effectIds.has(effect.intent.effectId)) {
      throw new TypeError('Effect identity must be unique and belong to the run.');
    }
    effectIds.add(effect.intent.effectId);
  }
  if (phase.kind === 'suspended' && phase.reason === 'user_decision') {
    if (
      phase.decisionRequest.runRevision > revision ||
      (control.status !== 'abort_requested' && phase.decisionRequest.runRevision !== revision)
    ) {
      throw new TypeError('Decision request revision does not match the run revision.');
    }
    if (phase.continuation.blockedProvider.effect.intent.ownerId !== runId)
      throw new TypeError('Decision continuation does not belong to this run.');
  }
}

