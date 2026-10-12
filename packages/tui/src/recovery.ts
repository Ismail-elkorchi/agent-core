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

/** Ordinary loading presentation; typed diagnostics stay on the application event stream. */
export function historyRecoveryMessage(progress: HistoryIndexRecoveryProgress): string {
  return progress.phase === 'started' || progress.phase === 'progress' ? 'Opening conversation…' : '';
}

/** One delayed loading line per command, regardless of how many conversations are inspected. */
export class HistoryRecoveryProgressRenderer {
  private startedAt: number | undefined;
  private announced = false;

  constructor(
    private readonly write: (message: string) => void,
    private readonly now: () => number = () => performance.now()
  ) {}

  handle(progress: HistoryIndexRecoveryProgress): void {
    if (progress.phase !== 'started' && progress.phase !== 'progress') {
      this.startedAt = undefined;
      return;
    }
    const time = this.now();
    this.startedAt ??= time;
    if (this.announced || time - this.startedAt < 1000) return;
    this.announced = true;
    this.write(historyRecoveryMessage(progress));
  }
}
