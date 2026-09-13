import type { TerminalDiagnostic } from '@ismail-elkorchi/terminal-ui';

export function diagnosticMessage(diagnostic: TerminalDiagnostic): string {
  const cause = diagnostic.cause;
  return cause !== null &&
    typeof cause === 'object' &&
    !Array.isArray(cause) &&
    'message' in cause &&
    typeof cause.message === 'string'
    ? cause.message
    : diagnostic.message;
}
