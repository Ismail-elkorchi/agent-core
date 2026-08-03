import type { AgentTerminalSnapshot } from '@agent-core/runtime';
import type { StatusBarStatus } from '@ismail-elkorchi/terminal-ui/components';

export interface AgentTuiTerminalPresentation {
  readonly status: StatusBarStatus;
  readonly headline: string;
  readonly message: string;
}

export function terminalPresentation(terminal: AgentTerminalSnapshot): AgentTuiTerminalPresentation {
  if (terminal.executionStatus === 'aborted') {
    return {
      status: 'warning',
      headline: 'Aborted',
      message: terminal.candidate.status === 'absent' ? terminal.errorMessage : terminal.candidate.message
    };
  }
  if (terminal.executionStatus === 'failed') {
    return {
      status: 'error',
      headline: failureHeadline(terminal.terminationReason),
      message: terminal.candidate.status === 'absent' ? terminal.errorMessage : terminal.candidate.message
    };
  }
  if (terminal.verificationStatus === 'passed') {
    return { status: 'success', headline: 'Verified', message: terminal.candidate.message };
  }
  if (terminal.verificationStatus === 'failed') {
    return { status: 'warning', headline: 'Verification failed', message: terminal.candidate.message };
  }
  if (terminal.verificationStatus === 'inconclusive') {
    return { status: 'warning', headline: 'Verification inconclusive', message: terminal.candidate.message };
  }
  return { status: 'success', headline: 'Completed', message: terminal.candidate.message };
}

function failureHeadline(reason: AgentTerminalSnapshot['terminationReason']): string {
  switch (reason) {
    case 'model_output_limit': return 'Output limit reached';
    case 'content_filtered': return 'Output filtered';
    case 'stream_interrupted': return 'Stream interrupted';
    case 'request_too_large': return 'Request too large';
    case 'provider_error': return 'Provider failed';
    case 'runtime_error': return 'Runtime failed';
    case 'empty_response': return 'No answer';
    case 'malformed_response': return 'Malformed answer';
    case 'limit_exhausted': return 'Run limit reached';
    case 'uncertain_tool_effect': return 'Unsafe retry refused';
    default: return 'Run failed';
  }
}
