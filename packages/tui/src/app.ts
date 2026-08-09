import type { AgentApprovalRequest, AgentApprovalSuspension, AgentRunResult } from '@agent-core/runtime';
import {
  measuredWindow,
  prepareSearchPickerIndex,
  searchPickerReducer,
  scrollReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchPickerState } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  button,
  dialog,
  disclosure,
  divider,
  richText,
  searchPicker,
  text,
  textArea
} from '@ismail-elkorchi/terminal-ui/components';
import type { Element, InlineContent, SearchEntry } from '@ismail-elkorchi/terminal-ui/components';
import { column, grid, overlay, row, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import { wrapTextCells } from '@ismail-elkorchi/terminal-ui/text';
import { defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import type { TuiContext, TuiEventSource, TuiUpdateResult } from '@ismail-elkorchi/terminal-ui/tui';
import { statusChrome, hintBar } from './chrome.js';
import { commandEffect } from './command-effects.js';
import {
  COMMAND_INDEX,
  applyCommandExecution,
  applyCommandFailure,
  editComposer,
  setComposerText,
  submitComposer
} from './command-surface.js';
import type { AgentTuiCommandHandler } from './command-surface.js';
import { applyFailure, applyProgress, applyResult } from './event-reducer.js';
import type { AgentTuiMessage } from './messages.js';
import { createInitialAgentTuiState } from './state.js';
import type { AgentTuiRuntimeDetails, AgentTuiState } from './state.js';
import type { AgentTuiActivityEntry, AgentTuiConversationEntry } from './conversation-model.js';
import { conversationText, scrollConversation, toggleActivity } from './conversation.js';
import { INTERACTIVE_COMMANDS } from './interactive-commands.js';

export interface AgentTuiAppOptions {
  readonly eventSource?: TuiEventSource<AgentTuiMessage>;
  readonly commandHandler?: AgentTuiCommandHandler;
  readonly runtimeDetails?: AgentTuiRuntimeDetails;
  readonly approvalHandler?: (
    suspension: AgentApprovalSuspension,
    decision: 'allow' | 'deny'
  ) => Promise<AgentRunResult>;
  readonly exitWhenApprovalEnds?: boolean;
}

export function createAgentTuiApp(task: string, options: AgentTuiAppOptions = {}) {
  const eventSource = options.eventSource;
  return defineTui<AgentTuiState, AgentTuiMessage>({
    id: 'agent-core',
    init: () => createInitialAgentTuiState(task, options.runtimeDetails),
    update: (state, message, context) => updateAgentTui(state, message, context, options),
    inputBindings: [
      binding('commands', 'p', { ctrl: true }, { type: 'overlay.open', overlay: 'commands' }, state => canOpenOverlay(state)),
      binding('search', 'f', { ctrl: true }, { type: 'overlay.open', overlay: 'search' }, state => canOpenOverlay(state)),
      binding('help', 'f1', {}, { type: 'overlay.open', overlay: 'help' }, state => canOpenOverlay(state)),
      binding('page-up', 'pageUp', {}, { type: 'conversation.scroll', action: { kind: 'scrollPages', rows: -1 } }, state => canScroll(state)),
      binding('page-down', 'pageDown', {}, { type: 'conversation.scroll', action: { kind: 'scrollPages', rows: 1 } }, state => canScroll(state))
    ],
    ...(eventSource === undefined
      ? {}
      : { subscriptions: (): readonly TuiEventSource<AgentTuiMessage>[] => [eventSource] }),
    view: agentTuiView
  });
}

function updateAgentTui(
  state: AgentTuiState,
  message: AgentTuiMessage,
  context: TuiContext,
  options: AgentTuiAppOptions
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  switch (message.type) {
    case 'progress': return updated(applyProgress(state, message.event), context);
    case 'result': return updated(applyResult(state, message.result), context);
    case 'failure': return updated(applyFailure(state, message.message), context);
    case 'approval.required': return updated({
      ...state,
      run: { kind: 'waiting_for_approval', suspension: message.suspension },
      overlay: { kind: 'none' },
      modalOffsetRow: 0
    }, context, { kind: 'element', elementId: 'approval-deny' });
    case 'approval.decide': {
      if (state.run.kind !== 'waiting_for_approval') return { state };
      return {
        state,
        effects: [approvalEffect(state.run.suspension, message.decision, options.approvalHandler)]
      };
    }
    case 'approval.result': {
      if (message.result.state === 'suspended') {
        return updated({ ...state, run: { kind: 'waiting_for_approval', suspension: message.result } }, context, {
          kind: 'element', elementId: 'approval-deny'
        });
      }
      const ended = reconcileConversationLayout(applyResult(state, message.result), context);
      return options.exitWhenApprovalEnds === true
        ? { state: ended, exit: { reason: terminalReason(message.result) } }
        : { state: ended, focus: { kind: 'element', elementId: 'composer' } };
    }
    case 'composer.edit': return updated(editComposer(state, message.action), context);
    case 'composer.submit': return submit(state, context, options.commandHandler);
    case 'command.completed': {
      const result = applyCommandExecution(state, message.execution, message.recordResult);
      const next = message.execution.view === 'debug'
        ? {
            ...result.state,
            overlay: { kind: 'debug' as const, text: debugText(result.state, message.execution.message) },
            modalOffsetRow: 0
          }
        : result.state;
      return result.exit === true
        ? { state: next, exit: { reason: 'command' } }
        : updated(next, context);
    }
    case 'command.failed': return updated(applyCommandFailure(state, message.message), context);
    case 'conversation.scroll': return updated(scrollConversation(state, message.action), context);
    case 'activity.toggle': return updated(toggleActivity(state, message.id), context);
    case 'overlay.open': return openOverlay(state, message.overlay, context);
    case 'overlay.close': return updated({ ...state, overlay: { kind: 'none' } }, context, {
      kind: 'element', elementId: 'composer'
    });
    case 'modal.scrolled': return { state: { ...state, modalOffsetRow: message.offsetRow } };
    case 'commands.action': return updateCommands(state, message.action, context, options.commandHandler);
    case 'search.action': return updateSearch(state, message.action, context);
    case 'app.exit': return {
      state,
      exit: message.reason === undefined ? {} : { reason: message.reason }
    };
  }
}

function submit(
  state: AgentTuiState,
  context: TuiContext,
  handler: AgentTuiCommandHandler | undefined
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  if (state.run.kind === 'waiting_for_approval') return { state };
  const submission = submitComposer(state);
  return submission.request === undefined
    ? { state: submission.state }
    : {
        state: reconcileConversationLayout(submission.state, context),
        effects: [commandEffect(submission.request, handler)]
      };
}

function updateCommands(
  state: AgentTuiState,
  action: Extract<AgentTuiMessage, { type: 'commands.action' }>['action'],
  context: TuiContext,
  handler: AgentTuiCommandHandler | undefined
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  if (state.overlay.kind !== 'commands') return { state };
  if (action.kind !== 'activate') {
    return { state: { ...state, overlay: { kind: 'commands', picker: searchPickerReducer(state.overlay.picker, action, { searchPickerIndex: COMMAND_INDEX }) } } };
  }
  const command = INTERACTIVE_COMMANDS.find((candidate) => candidate.name === action.entry.value);
  if (command?.requiresValue === true) {
    return updated(setComposerText({ ...state, overlay: { kind: 'none' } }, `${command.name} `), context, {
      kind: 'element', elementId: 'composer'
    });
  }
  return submit(setComposerText({ ...state, overlay: { kind: 'none' } }, action.entry.value), context, handler);
}

function updateSearch(
  state: AgentTuiState,
  action: Extract<AgentTuiMessage, { type: 'search.action' }>['action'],
  context: TuiContext
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  if (state.overlay.kind !== 'search') return { state };
  const index = conversationSearchIndex(state);
  if (action.kind !== 'activate') {
    return { state: { ...state, overlay: { kind: 'search', picker: searchPickerReducer(state.overlay.picker, action, { searchPickerIndex: index }) } } };
  }
  const layout = conversationLayout(state, context);
  const selected = layout.items.find((item) => item.id === action.entry.value);
  let scroll = scrollReducer(layout.scroll, { kind: 'setFollowTail', followTail: false });
  if (selected !== undefined) scroll = scrollReducer(scroll, { kind: 'setOffset', rows: layout.starts.get(selected.id) ?? 0 });
  return {
    state: {
      ...state,
      overlay: { kind: 'none' },
      conversation: { ...state.conversation, scroll }
    },
    focus: { kind: 'element', elementId: 'composer' }
  };
}

function openOverlay(
  state: AgentTuiState,
  kind: 'commands' | 'search' | 'help' | 'debug',
  context: TuiContext
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  if (!canOpenOverlay(state)) return { state };
  if (kind === 'help') return { state: { ...state, overlay: { kind: 'help' }, modalOffsetRow: 0 } };
  if (kind === 'debug') return { state: { ...state, overlay: { kind: 'debug', text: debugText(state) }, modalOffsetRow: 0 } };
  const picker: SearchPickerState = { query: '' };
  const overlayState: AgentTuiState = kind === 'commands'
    ? { ...state, overlay: { kind: 'commands', picker }, modalOffsetRow: 0 }
    : { ...state, overlay: { kind: 'search', picker }, modalOffsetRow: 0 };
  return updated(overlayState, context, {
    kind: 'element', elementId: kind === 'commands' ? 'command-picker' : 'conversation-search'
  });
}

function updated(
  state: AgentTuiState,
  context: TuiContext,
  focus?: TuiUpdateResult<AgentTuiState, AgentTuiMessage>['focus']
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  return {
    state: reconcileConversationLayout(state, context),
    ...(focus === undefined ? {} : { focus })
  };
}

function reconcileConversationLayout(state: AgentTuiState, context: TuiContext): AgentTuiState {
  const layout = conversationLayout(state, context);
  if (layout.scroll === state.conversation.scroll) return state;
  return { ...state, conversation: { ...state.conversation, scroll: layout.scroll } };
}

function agentTuiView(state: AgentTuiState, context: TuiContext): Element<AgentTuiMessage> {
  const workspace = grid([
    statusChrome(state),
    conversationView(state, context),
    divider({ id: 'composer-divider' }),
    composerView(state),
    hintBar(state, context.terminalSize.columns)
  ], {
    id: 'agent-core-tui',
    rows: [
      { kind: 'fixed', cells: 1 },
      { kind: 'fill' },
      { kind: 'fixed', cells: 1 },
      { kind: 'fixed', cells: 2 },
      { kind: 'fixed', cells: 1 }
    ],
    columns: [{ kind: 'fill' }]
  });
  if (state.run.kind === 'waiting_for_approval') {
    return overlay([workspace, approvalDialog(state, context)], { id: 'agent-core-overlay' });
  }
  const modal = overlayView(state, context);
  return modal === undefined
    ? overlay([workspace], { id: 'agent-core-overlay' })
    : overlay([workspace, modal], { id: 'agent-core-overlay' });
}

function composerView(state: AgentTuiState): Element<AgentTuiMessage> {
  const placeholder = state.run.kind === 'working' ? 'Queue a follow-up' : 'Send a message';
  return textArea({
    id: 'composer',
    presentation: state.composer.input,
    placeholder,
    wrap: true,
    scrollbar: { axis: 'vertical', visible: 'auto' },
    onAction: (action): AgentTuiMessage => ({ type: 'composer.edit', action }),
    keys: {
      enter: (): AgentTuiMessage => ({ type: 'composer.submit' }),
      triggers: [
        {
          trigger: { kind: 'key', key: 'enter', modifiers: { shift: true } },
          onKey: (): AgentTuiMessage => ({ type: 'composer.edit', action: { kind: 'edit', operation: { kind: 'insert', text: '\n' } } })
        },
        {
          trigger: { kind: 'key', key: 'o', modifiers: { ctrl: true } },
          onKey: (): AgentTuiMessage => ({ type: 'composer.edit', action: { kind: 'edit', operation: { kind: 'insert', text: '\n' } } })
        }
      ]
    }
  });
}

function conversationView(state: AgentTuiState, context: TuiContext): Element<AgentTuiMessage> {
  const layout = conversationLayout(state, context);
  if (layout.items.length === 0) {
    return viewport(text('Start with a message.', { id: 'conversation-empty', textRole: 'caption' }), {
      id: 'conversation',
      offset: { row: 0 },
      onScroll: (event): AgentTuiMessage => ({ type: 'conversation.scroll', action: event.action })
    });
  }
  const window = measuredWindow({
    items: layout.items,
    viewportRows: layout.scroll.viewportRows,
    offsetRow: layout.scroll.offsetRow
  });
  const children: Element<AgentTuiMessage>[] = [];
  const sizes: { readonly kind: 'fixed'; readonly cells: number }[] = [];
  const firstStart = window.entries[0]?.startRowIndex ?? 0;
  if (firstStart > 0) {
    children.push(text('', { id: 'conversation-before' }));
    sizes.push({ kind: 'fixed', cells: firstStart });
  }
  for (const entry of window.entries) {
    children.push(conversationEntryView(entry.item.value, state));
    sizes.push({ kind: 'fixed', cells: entry.item.rows });
  }
  const lastEnd = window.entries.at(-1)?.endRowIndexExclusive ?? 0;
  if (lastEnd < window.totalRows) {
    children.push(text('', { id: 'conversation-after' }));
    sizes.push({ kind: 'fixed', cells: window.totalRows - lastEnd });
  }
  return viewport(column(children, { id: 'conversation-window', sizes }), {
    id: 'conversation',
    offset: { row: layout.scroll.offsetRow },
    scrollbar: { axis: 'vertical', visible: 'auto' },
    onScroll: (event): AgentTuiMessage => ({ type: 'conversation.scroll', action: event.action })
  });
}

function conversationEntryView(entry: AgentTuiConversationEntry, state: AgentTuiState): Element<AgentTuiMessage> {
  if (entry.kind === 'activity' && entry.details !== undefined) {
    return disclosure(
      richText({ id: `${entry.id}:details`, segments: body(entry.details), wrap: true }),
      {
        id: entry.id,
        label: activityLabel(entry),
        ...(entry.summary === undefined ? {} : { summary: body(entry.summary) }),
        expanded: state.conversation.expandedIds.includes(entry.id),
        onAction: (): AgentTuiMessage => ({ type: 'activity.toggle', id: entry.id })
      }
    );
  }
  return richText({ id: entry.id, segments: conversationSegments(entry), wrap: true });
}

function overlayView(state: AgentTuiState, context: TuiContext): Element<AgentTuiMessage> | undefined {
  const width = Math.max(30, Math.min(84, context.terminalSize.columns - 4));
  const height = Math.max(8, Math.min(20, context.terminalSize.rows - 4));
  switch (state.overlay.kind) {
    case 'none': return undefined;
    case 'commands': return dialog(searchPicker({
      id: 'command-picker',
      title: 'Commands',
      query: state.overlay.picker.query,
      searchPickerIndex: COMMAND_INDEX,
      ...(state.overlay.picker.selectedId === undefined ? {} : { selectedId: state.overlay.picker.selectedId }),
      maxVisible: Math.max(3, height - 5),
      helpText: 'Enter choose · Esc close',
      onAction: (action): AgentTuiMessage => ({ type: 'commands.action', action })
    }), modalOptions('commands-dialog', 'Commands', 'command-picker', width, height));
    case 'search': return dialog(searchPicker({
      id: 'conversation-search',
      title: 'Find in conversation',
      query: state.overlay.picker.query,
      searchPickerIndex: conversationSearchIndex(state),
      ...(state.overlay.picker.selectedId === undefined ? {} : { selectedId: state.overlay.picker.selectedId }),
      maxVisible: Math.max(3, height - 5),
      emptyText: 'No matching messages',
      helpText: 'Enter jump · Esc close',
      onAction: (action): AgentTuiMessage => ({ type: 'search.action', action })
    }), modalOptions('search-dialog', 'Find', 'conversation-search', width, height));
    case 'help': return dialog(richText({
      id: 'help-content',
      segments: body([
        'Enter             Send message',
        'Shift+Enter       Insert newline (enhanced terminals)',
        'Ctrl+O            Insert newline',
        'Ctrl+P            Commands',
        'Ctrl+F            Find in conversation',
        'PageUp/PageDown   Scroll conversation',
        'F1                Help',
        'Escape            Close'
      ].join('\n')),
      wrap: true
    }), modalOptions('help-dialog', 'Keyboard shortcuts', 'help-content', width, 13));
    case 'debug': return dialog(modalViewport(
      richText({ id: 'debug-details', segments: body(state.overlay.text), wrap: true }),
      state,
      'debug-content'
    ), modalOptions('debug-dialog', 'Runtime details', 'debug-content', width, height));
  }
}

function approvalDialog(state: AgentTuiState, context: TuiContext): Element<AgentTuiMessage> {
  if (state.run.kind !== 'waiting_for_approval') return text('');
  const suspension = state.run.suspension;
  const approval = suspension.pendingApprovals[0];
  const width = Math.max(36, Math.min(88, context.terminalSize.columns - 4));
  const bodyElement = approval === undefined
    ? richText({ id: 'approval-missing', segments: errorText('The runtime suspended without an approval request.'), wrap: true })
    : approvalContent(approval, suspension.pendingApprovals.length, state);
  return dialog(modalViewport(bodyElement, state, 'approval-content-scroll'), {
    id: 'approval-dialog',
    title: 'Approval required',
    modal: true,
    focusPolicy: { initialFocus: { kind: 'element', elementId: 'approval-deny' }, returnFocus: 'restore' },
    dismissal: {
      escape: true,
      outsidePress: false,
      onDismiss: (): AgentTuiMessage => ({ type: 'approval.decide', decision: 'deny' })
    },
    actions: row([
      button({ id: 'approval-deny', label: 'Deny', tone: 'destructive', onPress: (): AgentTuiMessage => ({ type: 'approval.decide', decision: 'deny' }) }),
      button({ id: 'approval-allow', label: 'Allow once', tone: 'primary', onPress: (): AgentTuiMessage => ({ type: 'approval.decide', decision: 'allow' }) })
    ], { id: 'approval-actions', gap: 2 }),
    width,
    height: Math.max(12, Math.min(18, context.terminalSize.rows - 4)),
    padding: 1
  });
}

function modalViewport(
  child: Element<AgentTuiMessage>,
  state: AgentTuiState,
  id: string
): Element<AgentTuiMessage> {
  return viewport(child, {
    id,
    offset: { row: state.modalOffsetRow },
    scrollbar: { axis: 'vertical', visible: 'auto' },
    onScroll: (event): AgentTuiMessage => ({ type: 'modal.scrolled', offsetRow: event.scroll.offsetRow })
  });
}

function approvalContent(
  approval: AgentApprovalRequest,
  pendingCount: number,
  state: AgentTuiState
): Element<AgentTuiMessage> {
  const summary = [
    `${approval.toolName} · 1 of ${String(pendingCount)}`,
    approvalSubject(approval),
    approval.reason,
    effectSummary(approval)
  ].filter((line) => line.length > 0).join('\n');
  const details = JSON.stringify({ input: approval.input, effects: approval.effects }, null, 2);
  return column([
    richText({ id: 'approval-summary', segments: body(summary), wrap: true }),
    disclosure(
      richText({ id: 'approval-raw', segments: body(details), wrap: true }),
      {
        id: 'approval-details',
        label: 'Exact input and effects',
        expanded: state.conversation.expandedIds.includes('approval-details'),
        onAction: (): AgentTuiMessage => ({ type: 'activity.toggle', id: 'approval-details' })
      }
    )
  ], { id: 'approval-content', gap: 1 });
}

function approvalEffect(
  suspension: AgentApprovalSuspension,
  decision: 'allow' | 'deny',
  handler: AgentTuiAppOptions['approvalHandler']
) {
  return {
    id: `approval:${suspension.runId}:${suspension.pendingApprovals[0]?.approvalId ?? 'missing'}`,
    concurrency: 'keep-first' as const,
    async run() {
      if (handler === undefined) throw new Error('No approval handler is attached.');
      return {
        kind: 'message' as const,
        message: { type: 'approval.result' as const, result: await handler(suspension, decision) }
      };
    },
    onError: ({ diagnostic }: { readonly diagnostic: { readonly message: string } }) => ({
      kind: 'message' as const,
      message: { type: 'command.failed' as const, message: diagnostic.message }
    })
  };
}

interface ConversationLayout {
  readonly items: readonly { readonly id: string; readonly value: AgentTuiConversationEntry; readonly rows: number }[];
  readonly starts: ReadonlyMap<string, number>;
  readonly scroll: AgentTuiState['conversation']['scroll'];
}

function conversationLayout(state: AgentTuiState, context: TuiContext): ConversationLayout {
  const width = Math.max(12, context.terminalSize.columns - 2);
  const viewportRows = Math.max(0, context.terminalSize.rows - 5);
  const items = visibleConversationItems(state).map((entry) => ({
    id: entry.id,
    value: entry,
    rows: conversationEntryRows(entry, state, width, context)
  }));
  const starts = new Map<string, number>();
  let totalRows = 0;
  for (const item of items) {
    starts.set(item.id, totalRows);
    totalRows += item.rows;
  }
  let scroll = scrollReducer(state.conversation.scroll, { kind: 'setViewport', rows: viewportRows, columns: width });
  scroll = scrollReducer(scroll, { kind: 'setContent', rows: totalRows, columns: width });
  return { items, starts, scroll };
}

function conversationEntryRows(
  entry: AgentTuiConversationEntry,
  state: AgentTuiState,
  width: number,
  context: TuiContext
): number {
  if (entry.kind === 'activity' && entry.details !== undefined) {
    if (!state.conversation.expandedIds.includes(entry.id)) return 1;
    return 1 + wrappedRows(entry.details, width, context);
  }
  return wrappedRows(conversationPlainText(entry), width, context) + (entry.kind === 'activity' ? 0 : 1);
}

function wrappedRows(value: string, width: number, context: TuiContext): number {
  return Math.max(1, wrapTextCells(value, width, {
    widthProfile: context.capabilities.unicode.widthProfile,
    preserveWords: true
  }).length);
}

function conversationPlainText(entry: AgentTuiConversationEntry): string {
  switch (entry.kind) {
    case 'user': return `You\n${entry.text}`;
    case 'assistant': return `Assistant\n${entry.text.length === 0 ? '…' : entry.text}`;
    case 'reasoning': return `Reasoning summary\n${entry.text}`;
    case 'notice': return entry.text;
    case 'activity': return `${activityLabel(entry)}${entry.summary === undefined ? '' : ` ${entry.summary}`}`;
  }
}

function conversationSegments(entry: AgentTuiConversationEntry): InlineContent {
  switch (entry.kind) {
    case 'user': return [{ kind: 'text', text: 'You\n', style: { bold: true } }, ...body(`${entry.text}\n`)];
    case 'assistant': return [
      { kind: 'text', text: 'Assistant\n', style: { bold: true } },
      ...body(`${entry.text.length === 0 ? '…' : entry.text}\n`)
    ];
    case 'reasoning': return [
      { kind: 'text', text: 'Reasoning summary\n', style: { bold: true, dim: true } },
      { kind: 'text', text: `${entry.text}\n`, style: { dim: true } }
    ];
    case 'notice': return [{ kind: 'text', text: `${entry.text}\n`, style: entry.tone === 'error' ? { bold: true } : { dim: true } }];
    case 'activity': return [
      activitySymbol(entry.status),
      {
        kind: 'text',
        text: ` ${entry.label}${entry.summary === undefined ? '' : ` — ${entry.summary}`}`,
        ...(entry.status === 'running' ? { style: { dim: true } } : {})
      }
    ];
  }
}

function activityLabel(entry: AgentTuiActivityEntry): string {
  return `${activityGlyph(entry.status)} ${entry.label}`;
}

function activityGlyph(status: AgentTuiActivityEntry['status']): string {
  switch (status) {
    case 'running': return '•';
    case 'success': return '✓';
    case 'warning': return '!';
    case 'failed': return '✗';
  }
}

function activitySymbol(status: AgentTuiActivityEntry['status']): InlineContent[number] {
  return {
    kind: 'symbol',
    unicode: activityGlyph(status),
    ascii: status === 'success' ? '+' : status === 'failed' ? 'x' : status === 'warning' ? '!' : '*',
    accessibleText: status
  };
}

function conversationSearchIndex(state: AgentTuiState) {
  const entries: SearchEntry[] = visibleConversationItems(state).map((entry) => {
    const content = conversationText(entry).trim().replaceAll(/\s+/g, ' ');
    const label = content.length <= 90 ? content : `${content.slice(0, 89)}…`;
    return { id: entry.id, label: label.length === 0 ? entry.kind : label, value: entry.id, group: entry.kind };
  });
  return prepareSearchPickerIndex(entries);
}

function visibleConversationItems(state: AgentTuiState): readonly AgentTuiConversationEntry[] {
  if (state.conversation.omittedEntries === 0) return state.conversation.items;
  return [{
    id: 'conversation:omitted',
    kind: 'notice',
    tone: 'info',
    text: `${String(state.conversation.omittedEntries)} earlier conversation entries omitted from this display (${formatBytes(state.conversation.omittedBytes)}).`
  }, ...state.conversation.items];
}

function formatBytes(bytes: number): string { return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KiB`; }

function modalOptions(id: string, title: string, focusId: string, width: number, height: number) {
  return {
    id,
    title,
    modal: true as const,
    focusPolicy: { initialFocus: { kind: 'element' as const, elementId: focusId }, returnFocus: 'restore' as const },
    dismissal: {
      escape: true,
      outsidePress: false,
      onDismiss: (): AgentTuiMessage => ({ type: 'overlay.close' })
    },
    width,
    height,
    padding: 1
  };
}

function binding(
  id: string,
  key: 'p' | 'f' | 'f1' | 'pageUp' | 'pageDown',
  modifiers: { readonly ctrl?: boolean },
  message: AgentTuiMessage,
  enabled: (state: AgentTuiState) => boolean
) {
  return {
    id,
    triggers: [{ kind: 'key' as const, key, modifiers }],
    phase: 'beforeFocus' as const,
    message,
    enabled: ({ state }: { readonly state: AgentTuiState }) => enabled(state)
  };
}

function canOpenOverlay(state: AgentTuiState): boolean {
  return state.overlay.kind === 'none' && state.run.kind !== 'waiting_for_approval';
}

function canScroll(state: AgentTuiState): boolean {
  return state.overlay.kind === 'none' && state.run.kind !== 'waiting_for_approval';
}

function body(value: string): InlineContent {
  return [{ kind: 'text', text: value }];
}

function errorText(value: string): InlineContent {
  return [{ kind: 'text', text: value, style: { bold: true } }];
}

function effectSummary(approval: AgentApprovalRequest): string {
  const accesses = Array.isArray(approval.effects.accesses)
    ? approval.effects.accesses.filter((access): access is { readonly mode: string; readonly scope: string } => (
      typeof access === 'object' && access !== null && !Array.isArray(access)
      && typeof access.mode === 'string' && typeof access.scope === 'string'
    ))
    : [];
  if (accesses.length === 0) return 'tool operation';
  const summary = accesses.map((access) => `${access.mode.replaceAll('_', ' ')} · ${access.scope}`).join(', ');
  const ambient = accesses.some((access) => access.mode === 'execute')
    && Array.isArray(approval.effects.lockScopes) && approval.effects.lockScopes.includes('workspace/files');
  return ambient
    ? `${summary}. Ambient shell authority can read, write, or delete files, access the network, and start child processes.`
    : summary;
}

function approvalSubject(approval: AgentApprovalRequest): string {
  if (typeof approval.input !== 'object' || approval.input === null || Array.isArray(approval.input)) return '';
  const candidates = [
    ['Command', approval.input.command],
    ['Path', approval.input.path],
    ['Query', approval.input.query],
    ['Pattern', approval.input.pattern]
  ] as const;
  for (const [label, value] of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      const compact = value.trim().replaceAll(/\s+/g, ' ');
      return `${label}: ${compact.length <= 180 ? compact : `${compact.slice(0, 179)}…`}`;
    }
  }
  return '';
}

function debugText(state: AgentTuiState, runtimeState?: string): string {
  return JSON.stringify({
    runtimeDetails: state.runtimeDetails,
    eventProjection: state.debug,
    ...(runtimeState === undefined ? {} : { runtimeState: parseDebugRuntimeState(runtimeState) })
  }, null, 2);
}

function parseDebugRuntimeState(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

function terminalReason(result: Extract<AgentRunResult, { state: 'ended' }>): string {
  return `${result.terminal.executionStatus}:${result.terminal.verificationStatus}:${result.terminal.terminationReason}`;
}
