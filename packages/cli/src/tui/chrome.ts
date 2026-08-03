import { richText, statusBar } from '@ismail-elkorchi/terminal-ui/components';
import type { Element, InlineContent, StatusBarStatus } from '@ismail-elkorchi/terminal-ui/components';
import type { AgentTuiMessage } from './messages.js';
import type { AgentTuiState } from './state.js';
import { terminalPresentation } from './run-presentation.js';

export function statusChrome(state: AgentTuiState): Element {
  const presentation = runPresentation(state);
  return statusBar({
    id: 'status',
    leading: [{ id: 'app', kind: 'text', text: 'Agent Core' }],
    center: state.runtimeDetails.modelId === undefined
      ? []
      : [{ id: 'model', kind: 'text', text: state.runtimeDetails.modelId }],
    trailing: [{ id: 'run', kind: 'status', text: presentation.text, status: presentation.status }]
  });
}

export function hintBar(state: AgentTuiState, columns: number): Element<AgentTuiMessage> {
  const text = state.run.kind === 'waiting_for_approval'
    ? 'Tab move · Enter choose · Esc deny'
    : columns < 50
      ? 'Ctrl+P commands'
      : 'Enter send · Ctrl+P commands · F1 help';
  return richText({ id: 'hints', segments: muted(text), wrap: false });
}

function runPresentation(state: AgentTuiState): { readonly text: string; readonly status: StatusBarStatus } {
  switch (state.run.kind) {
    case 'idle': return { text: 'Idle', status: 'idle' };
    case 'working': return { text: state.run.label, status: 'running' };
    case 'waiting_for_approval': return { text: 'Approval required', status: 'warning' };
    case 'failed': return { text: 'Failed', status: 'error' };
    case 'ended': {
      const terminal = terminalPresentation(state.run.terminal);
      return { text: terminal.headline, status: terminal.status };
    }
  }
}

function muted(text: string): InlineContent {
  return [{ kind: 'text', text, style: { dim: true } }];
}
