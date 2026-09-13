import type { AgentProgressEvent, AgentSessionSuspensionDescriptor } from '@agent-core/runtime';

export function suspensionPresentation(reason: AgentSessionSuspensionDescriptor['reason']): {
  readonly title: string;
  readonly explanation: string;
} {
  switch (reason) {
    case 'provider_outcome_unknown':
      return {
        title: 'Response interrupted',
        explanation:
          'The provider did not return a complete, recorded response. Check for a recorded result, or stop this run and send a new message. Checking does not resend the request.'
      };
    case 'tool_outcome_unknown':
      return {
        title: 'Tool result unavailable',
        explanation:
          'A tool may have executed, but its result is not recorded. Check for a recorded result before deciding what to do next. Stopping this run does not undo its effects.'
      };
    case 'missing_implementation':
      return {
        title: 'Required capability unavailable',
        explanation:
          'This run needs a capability that is unavailable in the current configuration. Restore that capability and continue, or stop this run.'
      };
    case 'user_decision':
      return { title: 'Decision required', explanation: 'This run is paused for your decision.' };
    case 'approval_required':
      return {
        title: 'Approval required',
        explanation: 'Review the proposed operation before allowing it.'
      };
  }
}

export function providerFailureText(
  diagnostic: Extract<AgentProgressEvent, { readonly type: 'model.failed' }>['diagnostic']
): string {
  const message = diagnostic.causeSummary?.message;
  return typeof message === 'string'
    ? message
    : `${diagnostic.provider}: ${diagnostic.code.replaceAll('_', ' ')}`;
}
