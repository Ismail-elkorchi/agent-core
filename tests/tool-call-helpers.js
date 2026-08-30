import {
  createToolCall,
  POLICY_TOOL_AUTHORIZER,
  invokePreparedToolCall,
  policyBlockedObservation,
  prepareToolCall,
  releasePreparedToolCall,
  releaseToolInvocation,
  startPreparedToolCall
} from '@agent-core/tools';
import { issueEffectStartTicket, NO_EFFECT_EXPOSURE, startExternalEffect } from '@agent-core/effects';
import { testPatchJournal } from './rooted-file-authority-helper.js';

export function jsonToolCall(name, value = {}, id) {
  return createToolCall({ ...(id ? { id } : {}), name, input: { kind: 'json', value } });
}

export function textToolCall(name, value, id) {
  return createToolCall({ ...(id ? { id } : {}), name, input: { kind: 'text', value } });
}

export async function invokeToolCall(call, tools, context) {
  const ownedCall = createToolCall(call);
  const controller = new AbortController();
  const rootedFileAuthority = context.services?.rootedFileAuthority;
  const services = rootedFileAuthority
    ? { ...context.services, patchJournal: context.services.patchJournal ?? testPatchJournal(rootedFileAuthority) }
    : context.services;
  const preparationContext = {
    ...context,
    ...(services ? { services } : {}),
    signal: context.signal ?? controller.signal,
    boundary: context.boundary ?? {
      authorizationPolicyId: 'tests/tool-policy@1',
      executionTargetId: String(context.services?.rootedFileAuthority?.displayPath ?? 'tests')
    }
  };
  const preparation = await prepareToolCall(ownedCall, tools, preparationContext);
  if (!preparation.ok) return preparation.observation;
  const authorization = await POLICY_TOOL_AUTHORIZER({
    call: ownedCall,
    toolImplementationId: preparation.prepared.toolImplementationId,
    input: preparation.prepared.canonicalSnapshot,
    effects: preparation.prepared.effects,
    fingerprint: preparation.prepared.fingerprint,
    context: preparationContext
  });
  if (authorization.decision !== 'allow') {
    await releasePreparedToolCall(preparation.prepared);
    return policyBlockedObservation(`Tool authorization denied: ${call.name}`, {
      tool: call.name,
      policyReason: authorization.decision,
      recovery: authorization.reason
    });
  }
  return invokePreparedForTest(preparation.prepared, preparationContext);
}

let nextInvocation = 1;

export async function invokePreparedForTest(prepared, context) {
  const identity = String(nextInvocation++);
  const issued = issueEffectStartTicket({
    intent: {
      effectId: `test-effect-${identity}`,
      operationId: 'test-operation',
      implementationId: prepared.toolImplementationId,
      parametersDigest: prepared.fingerprint,
      recovery: prepared.effects.recovery,
      exposure: NO_EFFECT_EXPOSURE
    },
    ticketId: `test-ticket-${identity}`,
    settlementPermitId: `test-permit-${identity}`,
    driverGeneration: 1,
    currentDriverGeneration: 1
  });
  if (issued.status !== 'issued') throw new Error('Test effect ticket was rejected.');
  const started = startExternalEffect(issued.state, issued.state.ticket, 1);
  if (started.status !== 'started') throw new Error('Test effect start was rejected.');
  const invocation = await startPreparedToolCall(prepared, started.state);
  try { return await invokePreparedToolCall(invocation, context); }
  finally { await releaseToolInvocation(invocation); }
}

export async function presentToolObservation(tool, call, observation, context, maxTokens) {
  const ownedCall = createToolCall(call);
  const controller = new AbortController();
  const preparationContext = {
    ...context,
    signal: context.signal ?? controller.signal,
    boundary: context.boundary ?? {
      authorizationPolicyId: 'tests/tool-policy@1',
      executionTargetId: String(context.services?.rootedFileAuthority?.displayPath ?? 'tests')
    }
  };
  const preparation = await prepareToolCall(ownedCall, [tool], preparationContext);
  if (!preparation.ok) {
    if (observation.kind !== 'failure') throw new Error(`Cannot present a result for an invalid tool call: ${preparation.observation.summary}`);
    return tool.presentObservation({ call, input: undefined, observation, mode: 'immediate', maxTokens });
  }
  try {
    return tool.presentObservation({
      call,
      input: preparation.prepared.canonicalSnapshot,
      observation,
      mode: 'immediate', maxTokens
    });
  } finally {
    await releasePreparedToolCall(preparation.prepared);
  }
}
