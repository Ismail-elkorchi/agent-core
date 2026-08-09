import { createScrollState, createTextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import type { ScrollState, SearchPickerState, TextAreaState } from '@ismail-elkorchi/terminal-ui/behavior';
import type {
  AgentApprovalSuspension,
  AgentDeliveryDiagnostic,
  AgentProgressEvent,
  AgentProviderStateSummary,
  AgentReplayPayload,
  AgentRunBudgetState,
  AgentRunConfiguration,
  AgentRunPhase,
  AgentTerminalSnapshot
} from '@agent-core/runtime';
import type { AgentTuiConversationEntry } from './conversation-model.js';

export interface AgentTuiRuntimeDetails {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
  readonly showReasoning?: boolean;
  readonly sessionLocation?: string;
  readonly permissions?: {
    readonly workspaceWrites: 'denied' | 'dry_run' | 'allowed' | 'ambient_shell';
    readonly shell: 'denied' | 'ambient';
  };
}

export interface AgentTuiDebugState {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly sessionLocation?: string;
  readonly phase?: AgentRunPhase;
  readonly configuration?: AgentRunConfiguration;
  readonly budget?: AgentRunBudgetState;
  readonly replay?: AgentReplayPayload;
  readonly providerState?: AgentProviderStateSummary;
  readonly latestHistoryReduction?: Extract<AgentProgressEvent, { readonly type: 'context.history.reduced' }>;
  readonly latestCheckpoint?: Extract<AgentProgressEvent, { readonly type: 'context.checkpoint.created' }>;
  readonly terminal?: AgentTerminalSnapshot;
  readonly deliveryDiagnostics: readonly AgentDeliveryDiagnostic[];
}

export type AgentTuiRunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly label: string; readonly phase?: AgentRunPhase }
  | { readonly kind: 'waiting_for_approval'; readonly suspension: AgentApprovalSuspension }
  | { readonly kind: 'ended'; readonly terminal: AgentTerminalSnapshot }
  | { readonly kind: 'failed'; readonly message: string };

export type AgentTuiOverlay =
  | { readonly kind: 'none' }
  | { readonly kind: 'commands'; readonly picker: SearchPickerState }
  | { readonly kind: 'search'; readonly picker: SearchPickerState }
  | { readonly kind: 'help' }
  | { readonly kind: 'debug'; readonly text: string };

export interface AgentTuiConversationState {
  readonly items: readonly AgentTuiConversationEntry[];
  readonly omittedEntries: number;
  readonly omittedBytes: number;
  readonly scroll: ScrollState;
  readonly expandedIds: readonly string[];
}

export interface AgentTuiComposerState {
  readonly input: TextAreaState;
  readonly history: readonly string[];
  readonly submissionCount: number;
}

export interface AgentTuiState {
  readonly run: AgentTuiRunState;
  readonly conversation: AgentTuiConversationState;
  readonly composer: AgentTuiComposerState;
  readonly overlay: AgentTuiOverlay;
  readonly modalOffsetRow: number;
  readonly runtimeDetails: AgentTuiRuntimeDetails;
  readonly debug: AgentTuiDebugState;
  readonly nextLocalId: number;
}

export function createInitialAgentTuiState(
  task: string,
  runtimeDetails: AgentTuiRuntimeDetails = {}
): AgentTuiState {
  const trimmed = task.trim();
  const items: readonly AgentTuiConversationEntry[] = trimmed.length === 0
    ? []
    : [{ id: 'user:initial', kind: 'user', text: trimmed }];
  return {
    run: { kind: 'idle' },
    conversation: {
      items,
      omittedEntries: 0,
      omittedBytes: 0,
      scroll: createScrollState({ contentRows: items.length, followTail: true }),
      expandedIds: []
    },
    composer: {
      input: createTextAreaState({ value: '', scroll: createScrollState({ followTail: true }) }),
      history: [],
      submissionCount: 0
    },
    overlay: { kind: 'none' },
    modalOffsetRow: 0,
    runtimeDetails,
    debug: {
      ...(runtimeDetails.sessionLocation === undefined ? {} : { sessionLocation: runtimeDetails.sessionLocation }),
      deliveryDiagnostics: []
    },
    nextLocalId: 1
  };
}
