import {
  POLICY_TOOL_AUTHORIZER,
  invokePreparedToolCall,
  policyBlockedObservation,
  prepareToolCall
} from '@agent-core/tools';
import path from 'node:path';

export function jsonToolCall(name, value = {}, id) {
  return { ...(id ? { id } : {}), name, input: { kind: 'json', value } };
}

export function textToolCall(name, value, id) {
  return { ...(id ? { id } : {}), name, input: { kind: 'text', value } };
}

export async function invokeToolCall(call, tools, context) {
  const controller = new AbortController();
  const workspaceRoot = context.services?.workspaceRoot;
  const services = typeof workspaceRoot === 'string'
    ? { ...context.services, patchTransactionDirectory: path.join(workspaceRoot, '.agent-core', 'transactions', 'patch') }
    : context.services;
  const preparationContext = {
    ...context,
    ...(services ? { services } : {}),
    signal: context.signal ?? controller.signal,
    boundary: context.boundary ?? {
      authorizationPolicyId: 'tests/tool-policy@1',
      executionTargetId: String(context.services?.workspaceRoot ?? 'tests')
    }
  };
  const preparation = await prepareToolCall(call, tools, preparationContext);
  if (!preparation.ok) return preparation.observation;
  const authorization = await POLICY_TOOL_AUTHORIZER({
    call,
    tool: preparation.prepared.tool,
    input: preparation.prepared.canonicalInput,
    effects: preparation.prepared.effects,
    fingerprint: preparation.prepared.fingerprint,
    context: preparationContext
  });
  if (authorization.decision !== 'allow') {
    return policyBlockedObservation(`Tool authorization denied: ${call.name}`, {
      tool: call.name,
      policyReason: authorization.decision,
      recovery: authorization.reason
    });
  }
  return invokePreparedToolCall(preparation.prepared, preparationContext);
}

export async function presentToolObservation(tool, call, observation, context, maxTokens) {
  const controller = new AbortController();
  const preparationContext = {
    ...context,
    signal: context.signal ?? controller.signal,
    boundary: context.boundary ?? {
      authorizationPolicyId: 'tests/tool-policy@1',
      executionTargetId: String(context.services?.workspaceRoot ?? 'tests')
    }
  };
  const preparation = await prepareToolCall(call, [tool], preparationContext);
  if (!preparation.ok) {
    if (observation.kind !== 'failure') throw new Error(`Cannot present a result for an invalid tool call: ${preparation.observation.summary}`);
    return tool.presentObservation({ call, input: undefined, observation, limit: { maxTokens } });
  }
  return tool.presentObservation({
    call,
    input: preparation.prepared.canonicalInput,
    observation,
    limit: { maxTokens }
  });
}
