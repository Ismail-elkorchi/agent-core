import { richText, statusBar } from '@ismail-elkorchi/terminal-ui/components';
import type { Element, InlineContent, StatusBarStatus } from '@ismail-elkorchi/terminal-ui/components';
import type { AgentTuiMessage } from './messages.js';
import type { AgentTuiState } from './state.js';
import { terminalPresentation } from './run-presentation.js';

export function statusChrome(state: AgentTuiState): Element {
  const presentation = runPresentation(state);
  const center = [state.runtimeDetails.modelId, permissionLabel(state)].filter((value): value is string => value !== undefined).join(' · ');
  return statusBar({
    id: 'status',
    leading: [{ id: 'app', kind: 'text', text: 'Agent Core' }],
    center: center.length === 0 ? [] : [{ id: 'model-and-authority', kind: 'text', text: center }],
    trailing: [{ id: 'run', kind: 'status', text: presentation.text, status: presentation.status }]
  });
}

function permissionLabel(state: AgentTuiState): string | undefined {
  const permissions = state.runtimeDetails.permissions;
  if (!permissions) return undefined;
  const patch = permissions.workspaceWrites === 'allowed' ? 'patch: allowed'
    : permissions.workspaceWrites === 'dry_run' ? 'patch: dry-run'
      : permissions.workspaceWrites === 'ambient_shell' ? 'patch: denied; workspace: ambient shell'
        : 'patch: denied';
  const shell = permissions.shell === 'ambient' ? 'shell: ambient' : 'shell: denied';
  return `${patch}; ${shell}`;
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
