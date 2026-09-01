import {
  createToolCall,
  POLICY_TOOL_AUTHORIZER,
  invokeToolCallPlan,
  policyBlockedObservation,
  planToolCall,
  releaseToolCallPlan,
  releaseToolInvocation,
  startToolCallPlan
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
  const planningContext = {
    ...context,
    ...(services ? { services } : {}),
    signal: context.signal ?? controller.signal,
    boundary: context.boundary ?? {
      authorizationPolicyId: 'tests/tool-policy@1',
      executionTargetId: String(context.services?.rootedFileAuthority?.displayPath ?? 'tests')
    }
  };
  const planning = await planToolCall(ownedCall, tools, planningContext);
  if (!planning.ok) return planning.observation;
  const authorization = await POLICY_TOOL_AUTHORIZER({
    call: ownedCall,
    toolImplementationId: planning.plan.toolImplementationId,
    input: planning.plan.canonicalSnapshot,
    effects: planning.plan.effects,
    fingerprint: planning.plan.fingerprint,
    context: planningContext
  });
  if (authorization.decision !== 'allow') {
    await releaseToolCallPlan(planning.plan);
    return policyBlockedObservation(`Tool authorization denied: ${call.name}`, {
      tool: call.name,
      policyReason: authorization.decision,
      recovery: authorization.reason
    });
  }
  return invokePlannedForTest(planning.plan, planningContext);
}

let nextInvocation = 1;

export async function invokePlannedForTest(plan, context) {
  const identity = String(nextInvocation++);
  const issued = issueEffectStartTicket({
    intent: {
      effectId: `test-effect-${identity}`,
      ownerId: 'test-operation',
      implementationId: plan.toolImplementationId,
      parametersDigest: plan.fingerprint,
      recovery: plan.effects.recovery,
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
  const invocation = await startToolCallPlan(plan, started.state);
  try { return await invokeToolCallPlan(invocation, context); }
  finally { await releaseToolInvocation(invocation); }
}

export async function presentToolObservation(tool, call, observation, context, maxTokens) {
  const ownedCall = createToolCall(call);
  const controller = new AbortController();
  const planningContext = {
    ...context,
    signal: context.signal ?? controller.signal,
    boundary: context.boundary ?? {
      authorizationPolicyId: 'tests/tool-policy@1',
      executionTargetId: String(context.services?.rootedFileAuthority?.displayPath ?? 'tests')
    }
  };
  const planning = await planToolCall(ownedCall, [tool], planningContext);
  if (!planning.ok) {
    if (observation.kind !== 'failure') throw new Error(`Cannot present a result for an invalid tool call: ${planning.observation.summary}`);
    return tool.presentObservation({ call, input: undefined, observation, mode: 'immediate', maxTokens });
  }
  try {
    return tool.presentObservation({
      call,
      input: planning.plan.canonicalSnapshot,
      observation,
      mode: 'immediate', maxTokens
    });
  } finally {
    await releaseToolCallPlan(planning.plan);
  }
}
