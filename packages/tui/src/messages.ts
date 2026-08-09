import type { AgentApprovalSuspension, AgentEndedRunResult, AgentProgressEvent, AgentRunResult } from '@agent-core/runtime';
import type { ScrollAction } from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchPickerAction, TextAreaAction } from '@ismail-elkorchi/terminal-ui/components';
import type { AgentTuiCommandExecution } from './command-surface.js';

export type AgentTuiMessage =
  | { readonly type: 'progress'; readonly event: AgentProgressEvent }
  | { readonly type: 'result'; readonly result: AgentEndedRunResult }
  | { readonly type: 'failure'; readonly message: string }
  | { readonly type: 'approval.required'; readonly suspension: AgentApprovalSuspension }
  | { readonly type: 'approval.decide'; readonly decision: 'allow' | 'deny' }
  | { readonly type: 'approval.result'; readonly result: AgentRunResult }
  | { readonly type: 'composer.edit'; readonly action: TextAreaAction }
  | { readonly type: 'composer.submit' }
  | { readonly type: 'command.completed'; readonly execution: AgentTuiCommandExecution; readonly recordResult: boolean }
  | { readonly type: 'command.failed'; readonly message: string }
  | { readonly type: 'conversation.scroll'; readonly action: ScrollAction }
  | { readonly type: 'activity.toggle'; readonly id: string }
  | { readonly type: 'overlay.open'; readonly overlay: 'commands' | 'search' | 'help' | 'debug' }
  | { readonly type: 'overlay.close' }
  | { readonly type: 'modal.scrolled'; readonly offsetRow: number }
  | { readonly type: 'commands.action'; readonly action: SearchPickerAction }
  | { readonly type: 'search.action'; readonly action: SearchPickerAction }
  | { readonly type: 'app.exit'; readonly reason?: string };
