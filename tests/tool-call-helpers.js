import {
  createToolCall,
  POLICY_TOOL_AUTHORIZER,
  invokePreparedToolCall,
  policyBlockedObservation,
  prepareToolCall
} from '@agent-core/tools';
import { testPatchJournal } from './workspace-file-root-helper.js';

export function jsonToolCall(name, value = {}, id) {
  return createToolCall({ ...(id ? { id } : {}), name, input: { kind: 'json', value } });
}

export function textToolCall(name, value, id) {
  return createToolCall({ ...(id ? { id } : {}), name, input: { kind: 'text', value } });
}

export async function invokeToolCall(call, tools, context) {
  const ownedCall = createToolCall(call);
  const controller = new AbortController();
  const workspaceFileRoot = context.services?.workspaceFileRoot;
  const services = workspaceFileRoot
    ? { ...context.services, patchJournal: context.services.patchJournal ?? testPatchJournal(workspaceFileRoot) }
    : context.services;
  const preparationContext = {
    ...context,
    ...(services ? { services } : {}),
    signal: context.signal ?? controller.signal,
    boundary: context.boundary ?? {
      authorizationPolicyId: 'tests/tool-policy@1',
      executionTargetId: String(context.services?.workspaceFileRoot?.displayPath ?? 'tests')
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
    return policyBlockedObservation(`Tool authorization denied: ${call.name}`, {
      tool: call.name,
      policyReason: authorization.decision,
      recovery: authorization.reason
    });
  }
  return invokePreparedToolCall(preparation.prepared, preparationContext);
}

export async function presentToolObservation(tool, call, observation, context, maxTokens) {
  const ownedCall = createToolCall(call);
  const controller = new AbortController();
  const preparationContext = {
    ...context,
    signal: context.signal ?? controller.signal,
    boundary: context.boundary ?? {
      authorizationPolicyId: 'tests/tool-policy@1',
      executionTargetId: String(context.services?.workspaceFileRoot?.displayPath ?? 'tests')
    }
  };
  const preparation = await prepareToolCall(ownedCall, [tool], preparationContext);
  if (!preparation.ok) {
    if (observation.kind !== 'failure') throw new Error(`Cannot present a result for an invalid tool call: ${preparation.observation.summary}`);
    return tool.presentObservation({ call, input: undefined, observation, mode: 'immediate', maxTokens });
  }
  return tool.presentObservation({
    call,
    input: preparation.prepared.canonicalSnapshot,
    observation,
    mode: 'immediate', maxTokens
  });
}
