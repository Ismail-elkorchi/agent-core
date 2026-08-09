export type AgentTuiConversationEntry =
  | AgentTuiUserEntry
  | AgentTuiAssistantEntry
  | AgentTuiReasoningEntry
  | AgentTuiActivityEntry
  | AgentTuiNoticeEntry;

export interface AgentTuiUserEntry {
  readonly id: string;
  readonly kind: 'user';
  readonly text: string;
}

export interface AgentTuiAssistantEntry {
  readonly id: string;
  readonly kind: 'assistant';
  readonly turnId: string;
  readonly text: string;
  readonly status: 'streaming' | 'complete' | 'interrupted';
}

export interface AgentTuiReasoningEntry {
  readonly id: string;
  readonly kind: 'reasoning';
  readonly turnId: string;
  readonly text: string;
}

export interface AgentTuiActivityEntry {
  readonly id: string;
  readonly kind: 'activity';
  readonly activity: 'tool' | 'check';
  readonly label: string;
  readonly status: 'running' | 'success' | 'warning' | 'failed';
  readonly summary?: string;
  readonly details?: string;
}

export interface AgentTuiNoticeEntry {
  readonly id: string;
  readonly kind: 'notice';
  readonly tone: 'info' | 'success' | 'warning' | 'error';
  readonly text: string;
}
