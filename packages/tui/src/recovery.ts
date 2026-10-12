import type { HistoryIndexRecoveryProgress } from '@agent-core/runtime/node';
import type {
  AgentProgressEvent, AgentRunSuspension, AgentSessionSuspensionDescriptor
} from '@agent-core/runtime';

export function suspensionPresentation(reason: AgentSessionSuspensionDescriptor['reason']): {
  readonly title: string;
  readonly explanation: string;
  readonly resumeLabel?: string;
  readonly waitingMessage: string;
} {
  switch (reason) {
    case 'context_admission':
      return {
        title: 'Context needs adjustment',
        resumeLabel: 'Retry admission',
        waitingMessage: 'The request still does not fit. Inspect context and adjust the selected sources, model, or output reservation.',
        explanation:
          'Inspect the request conflict and adjust its source selection, model, or optional reservation before continuing.'
      };
    case 'provider_outcome_unknown':
      return {
        title: 'Response interrupted',
        resumeLabel: 'Check for a recorded result',
        waitingMessage: 'No recorded response is available yet. Checking does not resend the request.',
        explanation:
          'The provider did not return a complete, recorded response. Check for a recorded result, or stop this run and send a new message. Checking does not resend the request.'
      };
    case 'tool_outcome_unknown':
      return {
        title: 'Tool execution uncertain',
        resumeLabel: 'Check for a recorded result',
        waitingMessage: 'Execution remains uncertain. Checking only queries existing evidence.',
        explanation:
          'Tool execution could not be confirmed. Inspect its diagnostic and recorded evidence before deciding what to do next. Checking does not execute the tool again; stopping this run does not undo its effects.'
      };
    case 'missing_implementation':
      return {
        title: 'Required capability unavailable',
        resumeLabel: 'Continue',
        waitingMessage: 'The required capability is still unavailable. Restore it before continuing.',
        explanation:
          'This run needs a capability that is unavailable in the current configuration. Restore that capability and continue, or stop this run.'
      };
    case 'runtime_failed':
      return {
        title: 'Run needs recovery',
        resumeLabel: 'Resume recorded work',
        waitingMessage: 'The run could not resume. Its recorded work remains available for recovery.',
        explanation: 'Run dispatch failed. Resume from recorded execution state, or stop this run; uncertain effects are not replayed.'
      };
    case 'approval_required':
      return {
        title: 'Approval required',
        waitingMessage: 'Review the proposed operation before allowing it.',
        explanation: 'Review the proposed operation before allowing it.'
      };
  }
}

export function suspensionMessage(
  suspension: Pick<AgentSessionSuspensionDescriptor, 'reason' | 'contextAdmission' | 'diagnostic'> &
    Pick<AgentRunSuspension, 'cleanupDiagnostic'>
): string {
  return suspension.contextAdmission?.message ?? suspension.diagnostic ??
    suspension.cleanupDiagnostic?.message ?? suspensionPresentation(suspension.reason).explanation;
}

export function providerFailureText(
  diagnostic: Extract<AgentProgressEvent, { readonly type: 'model.failed' }>['diagnostic']
): string {
  const message = diagnostic.causeSummary?.message;
  const description = typeof message === 'string'
    ? message
    : `${diagnostic.provider}: ${diagnostic.code.replaceAll('_', ' ')}`;
  const cause = diagnostic.causeSummary?.rootCauseMessage ?? diagnostic.causeSummary?.causeMessage;
  const code = typeof diagnostic.causeSummary?.rootCauseMessage === 'string'
    ? diagnostic.causeSummary.rootCauseCode
    : diagnostic.causeSummary?.causeCode;
  const detail = [
    typeof code === 'string' || typeof code === 'number' ? String(code) : '',
    typeof cause === 'string' ? cause : ''
  ]
    .filter((value) => value.length > 0 && !description.includes(value))
    .join(': ');
  return detail ? `${description}\nCause: ${detail}` : description;
}

/** Shared wording for the app's normal terminal and protocol presentation. */
export function historyRecoveryMessage(progress: HistoryIndexRecoveryProgress): string {
  const session = JSON.stringify(progress.sessionId);
  switch (progress.phase) {
    case 'started':
      return `Restoring history index for session ${session}…`;
    case 'progress':
      return `Restoring history index for session ${session}: ${String(progress.records)} records, ${String(progress.bytes)}/${String(progress.totalBytes)} bytes…`;
    case 'completed':
      return `History index restored for session ${session}. Original history is unchanged.`;
    case 'cancelled':
    case 'failed':
      return progress.message;
  }
}

/** Keeps line-oriented recovery output readable without delaying recovery or cancellation. */
export class HistoryRecoveryProgressRenderer {
  private last: { readonly sessionId: string; readonly time: number; readonly records: number; readonly bytes: number } | undefined;

  constructor(
    private readonly write: (message: string) => void,
    private readonly now: () => number = () => performance.now()
  ) {}

  handle(progress: HistoryIndexRecoveryProgress): void {
    const time = this.now();
    if (progress.phase === 'progress') {
      const previous = this.last?.sessionId === progress.sessionId ? this.last : undefined;
      if (previous !== undefined &&
          (progress.records === previous.records && progress.bytes === previous.bytes ||
            progress.bytes < progress.totalBytes && time - previous.time < 1000)) return;
      this.last = { sessionId: progress.sessionId, time, records: progress.records, bytes: progress.bytes };
    } else {
      this.last = progress.phase === 'started'
        ? { sessionId: progress.sessionId, time, records: 0, bytes: 0 }
        : undefined;
    }
    this.write(historyRecoveryMessage(progress));
  }
}
