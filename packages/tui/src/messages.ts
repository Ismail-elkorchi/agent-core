import type { AgentApprovalSuspension, AgentEndedRunResult, AgentProgressEvent } from '@agent-core/runtime';
import type {
  ScrollAction,
  SearchPickerAcceptEvent,
  SearchPickerControlTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { TextAreaAction } from '@ismail-elkorchi/terminal-ui/components';
import type { ScrollEvent } from '@ismail-elkorchi/terminal-ui/interaction';
import type { AgentTuiCommandExecution } from './command-surface.js';

export type AgentTuiMessage =
  | { readonly type: 'progress'; readonly event: AgentProgressEvent }
  | { readonly type: 'result'; readonly result: AgentEndedRunResult }
  | { readonly type: 'failure'; readonly message: string }
  | { readonly type: 'approval.required'; readonly suspension: AgentApprovalSuspension }
  | { readonly type: 'approval.decide'; readonly decision: 'allow' | 'deny' }
  | { readonly type: 'composer.edit'; readonly action: TextAreaAction }
  | { readonly type: 'composer.submit' }
  | { readonly type: 'command.completed'; readonly execution: AgentTuiCommandExecution; readonly recordResult: boolean }
  | { readonly type: 'command.failed'; readonly message: string }
  | { readonly type: 'conversation.scroll'; readonly action: ScrollAction }
  | { readonly type: 'conversation.scrolled'; readonly event: ScrollEvent }
  | { readonly type: 'activity.toggle'; readonly id: string }
  | { readonly type: 'overlay.open'; readonly overlay: 'commands' | 'search' | 'help' | 'debug' }
  | { readonly type: 'overlay.close' }
  | { readonly type: 'modal.scrolled'; readonly offsetRow: number }
  | { readonly type: 'commands.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'commands.accept'; readonly event: SearchPickerAcceptEvent }
  | { readonly type: 'search.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'search.accept'; readonly event: SearchPickerAcceptEvent }
  | { readonly type: 'app.exit'; readonly reason?: string };
