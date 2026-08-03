import {
  createScrollState,
  createTextAreaState,
  prepareSearchPickerIndex,
  textAreaReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchPickerIndex } from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchEntry, TextAreaAction } from '@ismail-elkorchi/terminal-ui/components';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { INTERACTIVE_COMMANDS } from '../interactive-commands.js';
import type { InteractiveCommandResult } from '../interactive-commands.js';
import { normalizeTaskInput } from '../task-input.js';
import type { AgentTuiState } from './state.js';
import { appendNotice, appendUser } from './conversation.js';

const COMPOSER_HISTORY_LIMIT = 100;

export type AgentTuiCommandExecution = InteractiveCommandResult & {
  readonly exit?: boolean;
  readonly tone?: 'success' | 'error' | 'muted';
};

export interface AgentTuiCommandHandler {
  execute(line: string): AgentTuiCommandExecution | Promise<AgentTuiCommandExecution>;
}

export interface AgentTuiCommandRequest {
  readonly id: string;
  readonly value: string;
  readonly recordResult: boolean;
}

export interface AgentTuiCommandSubmitResult {
  readonly state: AgentTuiState;
  readonly request?: AgentTuiCommandRequest;
}

export const COMMAND_ENTRIES: readonly SearchEntry[] = INTERACTIVE_COMMANDS.map((command) => ({
  id: command.name,
  label: command.name,
  value: command.name,
  description: command.description,
  keywords: [command.name.slice(1), command.description]
}));

export const COMMAND_INDEX: SearchPickerIndex = prepareSearchPickerIndex(COMMAND_ENTRIES);

export function editComposer(state: AgentTuiState, action: TextAreaAction): AgentTuiState {
  return {
    ...state,
    composer: { ...state.composer, input: textAreaReducer(state.composer.input, action) }
  };
}

export function setComposerText(state: AgentTuiState, value: string): AgentTuiState {
  return {
    ...state,
    composer: {
      ...state.composer,
      input: createTextAreaState({ value, scroll: createScrollState({ followTail: true }) })
    }
  };
}

export function submitComposer(state: AgentTuiState): AgentTuiCommandSubmitResult {
  const value = normalizeTaskInput(textDocumentText(state.composer.input.document));
  if (value.length === 0) return { state };
  const slashCommand = value.startsWith('/');
  const cleared: AgentTuiState = {
    ...state,
    composer: {
      input: createTextAreaState({ value: '', scroll: createScrollState({ followTail: true }) }),
      history: [...state.composer.history, value].slice(-COMPOSER_HISTORY_LIMIT),
      submissionCount: state.composer.submissionCount + 1
    }
  };
  const next = slashCommand ? cleared : appendUser(cleared, value);
  return {
    state: next,
    request: {
      id: `command:${String(next.composer.submissionCount)}`,
      value,
      recordResult: slashCommand
    }
  };
}

export function applyCommandExecution(
  state: AgentTuiState,
  execution: AgentTuiCommandExecution,
  recordResult: boolean
): { readonly state: AgentTuiState; readonly exit?: boolean } {
  let next = state;
  if (execution.view !== 'debug' && recordResult) {
    const tone = execution.tone === 'error' ? 'error' : execution.tone === 'muted' ? 'info' : 'success';
    next = appendNotice(next, execution.message, tone);
  }
  return { state: next, ...(execution.exit === undefined ? {} : { exit: execution.exit }) };
}

export function applyCommandFailure(state: AgentTuiState, message: string): AgentTuiState {
  return appendNotice(state, message, 'error');
}
