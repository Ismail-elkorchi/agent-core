import type { AgentApprovalRequest, AgentApprovalSuspension } from '@agent-core/runtime';
import {
  applyScrollEvent,
  measuredWindow,
  normalizeScrollState,
  prepareSearchPickerIndex,
  searchPickerReducer,
  searchPickerEntryById,
  scrollReducer
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { SearchPickerIndex } from '@ismail-elkorchi/terminal-ui/behavior';
import type { ScrollGeometry } from '@ismail-elkorchi/terminal-ui/interaction';
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
import type { Element, InlineContent } from '@ismail-elkorchi/terminal-ui/components';
import { column, grid, overlay, row, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import { wrapTextCells } from '@ismail-elkorchi/terminal-ui/text';
import { defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import type {
  TuiContext,
  TuiEventSource,
  TuiInputBindingContext,
  TuiUpdateResult
} from '@ismail-elkorchi/terminal-ui/tui';
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
import type {
  AgentTuiConversationState,
  AgentTuiPickerState,
  AgentTuiRuntimeDetails,
  AgentTuiState,
} from './state.js';
import type { AgentTuiActivityEntry, AgentTuiConversationEntry } from './conversation-model.js';
import { conversationText, toggleActivity } from './conversation.js';
import { INTERACTIVE_COMMANDS } from './interactive-commands.js';

export interface AgentTuiAppOptions {
  readonly eventSource?: TuiEventSource<AgentTuiMessage>;
  readonly commandHandler?: AgentTuiCommandHandler;
  readonly runtimeDetails?: AgentTuiRuntimeDetails;
  readonly approvalHandler?: (
    suspension: AgentApprovalSuspension,
    decision: 'allow' | 'deny'
  ) => Promise<void>;
}

export function createAgentTuiApp(task: string, options: AgentTuiAppOptions = {}) {
  const eventSource = options.eventSource;
  return defineTui<AgentTuiState, AgentTuiMessage>({
    id: 'agent-core',
    init: () => createInitialAgentTuiState(task, options.runtimeDetails),
    update: (state, message, context) => updateAgentTui(state, message, context, options),
    inputBindings: [
      binding('commands', 'p', { ctrl: true }, { type: 'overlay.open', overlay: 'commands' }, ({ state }) => canOpenOverlay(state)),
      binding('search', 'f', { ctrl: true }, { type: 'overlay.open', overlay: 'search' }, ({ state }) => canOpenOverlay(state)),
      binding('help', 'f1', {}, { type: 'overlay.open', overlay: 'help' }, ({ state }) => canOpenOverlay(state)),
      binding('page-up', 'pageUp', {}, { type: 'conversation.scroll', action: { kind: 'scrollPages', rows: -1 } }, ({ state }) => canScroll(state)),
      binding('page-down', 'pageDown', {}, { type: 'conversation.scroll', action: { kind: 'scrollPages', rows: 1 } }, ({ state }) => canScroll(state)),
      binding('composer-submit', 'enter', {}, { type: 'composer.submit' }, composerBindingEnabled),
      binding(
        'composer-newline-shift-enter',
        'enter',
        { shift: true },
        composerNewlineMessage(),
        composerBindingEnabled
      ),
      binding('composer-newline-control-o', 'o', { ctrl: true }, composerNewlineMessage(), composerBindingEnabled)
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
    case 'conversation.scroll': {
      const layout = conversationLayout(state, context);
      return updated({
        ...state,
        conversation: {
          ...state.conversation,
          scroll: scrollReducer(layout.scroll, message.action, layout.geometry)
        }
      }, context);
    }
    case 'conversation.scrolled': return updated({
      ...state,
      conversation: {
        ...state.conversation,
        scroll: applyScrollEvent(state.conversation.scroll, message.event),
      }
    }, context);
    case 'activity.toggle': return updated(toggleActivity(state, message.id), context);
    case 'overlay.open': return openOverlay(state, message.overlay, context);
    case 'overlay.close': return updated({ ...state, overlay: { kind: 'none' } }, context, {
      kind: 'element', elementId: 'composer'
    });
    case 'modal.scrolled': return { state: { ...state, modalOffsetRow: message.offsetRow } };
    case 'commands.transition': return transitionCommands(state, message.transition);
    case 'commands.accept': return acceptCommand(state, message.event.id, context, options.commandHandler);
    case 'search.transition': return transitionSearch(state, message.transition);
    case 'search.accept': return acceptSearchResult(state, message.event.id, context);
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

function transitionCommands(
  state: AgentTuiState,
  transition: Extract<AgentTuiMessage, { type: 'commands.transition' }>['transition']
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  if (state.overlay.kind !== 'commands') return { state };
  return {
    state: {
      ...state,
      overlay: {
        kind: 'commands',
        picker: searchPickerReducer(
          state.overlay.picker,
          transition,
          { searchPickerIndex: COMMAND_INDEX }
        )
      }
    }
  };
}

function acceptCommand(
  state: AgentTuiState,
  id: string,
  context: TuiContext,
  handler: AgentTuiCommandHandler | undefined
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  if (state.overlay.kind !== 'commands') return { state };
  const command = INTERACTIVE_COMMANDS.find((candidate) => candidate.name === id);
  if (command === undefined) return { state };
  if (command.requiresValue) {
    return updated(setComposerText({ ...state, overlay: { kind: 'none' } }, `${command.name} `), context, {
      kind: 'element', elementId: 'composer'
    });
  }
  return submit(setComposerText({ ...state, overlay: { kind: 'none' } }, command.name), context, handler);
}

function transitionSearch(
  state: AgentTuiState,
  transition: Extract<AgentTuiMessage, { type: 'search.transition' }>['transition']
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  if (state.overlay.kind !== 'search') return { state };
  const index = conversationSearchIndex(state);
  return {
    state: {
      ...state,
      overlay: {
        kind: 'search',
        picker: searchPickerReducer(
          state.overlay.picker,
          transition,
          { searchPickerIndex: index }
        )
      }
    }
  };
}

function acceptSearchResult(
  state: AgentTuiState,
  id: string,
  context: TuiContext
): TuiUpdateResult<AgentTuiState, AgentTuiMessage> {
  if (state.overlay.kind !== 'search') return { state };
  const layout = conversationLayout(state, context);
  const selected = searchPickerEntryById(conversationSearchIndex(state), id)?.value;
  if (selected === undefined) return { state };
  let scroll = scrollReducer(
    layout.scroll,
    { kind: 'setFollowTail', followTail: false },
    layout.geometry
  );
  scroll = scrollReducer(
    scroll,
    { kind: 'setOffset', rows: layout.starts.get(selected.id) ?? 0 },
    layout.geometry
  );
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
  const picker: AgentTuiPickerState = { query: { text: '' } };
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
    onAction: (
      action: Extract<AgentTuiMessage, { type: 'composer.edit' }>['action']
    ): AgentTuiMessage => ({ type: 'composer.edit', action })
  });
}

function conversationView(state: AgentTuiState, context: TuiContext): Element<AgentTuiMessage> {
  const layout = conversationLayout(state, context);
  if (layout.items.length === 0) {
    return viewport(text({ content: 'Start with a message.', id: 'conversation-empty', textRole: 'caption' }), {
      id: 'conversation',
      offset: { row: 0 },
      onScroll: (event): AgentTuiMessage => ({ type: 'conversation.scrolled', event })
    });
  }
  const window = measuredWindow({
    items: layout.items,
    viewportRows: layout.geometry.viewportRows,
    offsetRow: layout.scroll.offsetRow
  });
  const children: Element<AgentTuiMessage>[] = [];
  const sizes: { readonly kind: 'fixed'; readonly cells: number }[] = [];
  const firstStart = window.entries[0]?.startRowIndex ?? 0;
  if (firstStart > 0) {
    children.push(text({ content: '', id: 'conversation-before' }));
    sizes.push({ kind: 'fixed', cells: firstStart });
  }
  for (const entry of window.entries) {
    children.push(conversationEntryView(entry.item.value, state));
    sizes.push({ kind: 'fixed', cells: entry.item.rows });
  }
  const lastEnd = window.entries.at(-1)?.endRowIndexExclusive ?? 0;
  if (lastEnd < window.totalRows) {
    children.push(text({ content: '', id: 'conversation-after' }));
    sizes.push({ kind: 'fixed', cells: window.totalRows - lastEnd });
  }
  return viewport(column(children, { id: 'conversation-window', sizes }), {
    id: 'conversation',
    offset: { row: layout.scroll.offsetRow },
    scrollbar: { axis: 'vertical', visible: 'auto' },
    onScroll: (event): AgentTuiMessage => ({ type: 'conversation.scrolled', event })
  });
}

function conversationEntryView(entry: AgentTuiConversationEntry, state: AgentTuiState): Element<AgentTuiMessage> {
  if (entry.kind === 'activity' && entry.details !== undefined) {
    return disclosure({
      id: entry.id,
      label: activityLabel(entry),
      ...(entry.summary === undefined ? {} : { summary: body(entry.summary) }),
      expanded: state.conversation.expandedIds.includes(entry.id),
      slots: {
        content: richText({ id: `${entry.id}:details`, segments: body(entry.details), wrap: true })
      },
      onAction: (): AgentTuiMessage => ({ type: 'activity.toggle', id: entry.id })
    });
  }
  return richText({ id: entry.id, segments: conversationSegments(entry), wrap: true });
}

function overlayView(state: AgentTuiState, context: TuiContext): Element<AgentTuiMessage> | undefined {
  const width = Math.max(30, Math.min(84, context.terminalSize.columns - 4));
  const height = Math.max(8, Math.min(20, context.terminalSize.rows - 4));
  switch (state.overlay.kind) {
    case 'none': return undefined;
    case 'commands': return dialog({
      ...modalOptions('commands-dialog', 'Commands', 'command-picker', width, height),
      slots: {
        content: searchPicker({
          id: 'command-picker',
          title: 'Commands',
          presentation: state.overlay.picker,
          searchPickerIndex: COMMAND_INDEX,
          maxVisible: Math.max(3, height - 5),
          helpText: 'Enter choose · Esc close',
          onTransition: (transition): AgentTuiMessage => ({
            type: 'commands.transition',
            transition
          }),
          onAccept: (event): AgentTuiMessage => ({ type: 'commands.accept', event })
        })
      }
    });
    case 'search': return dialog({
      ...modalOptions('search-dialog', 'Find', 'conversation-search', width, height),
      slots: {
        content: searchPicker({
          id: 'conversation-search',
          title: 'Find in conversation',
          presentation: state.overlay.picker,
          searchPickerIndex: conversationSearchIndex(state),
          maxVisible: Math.max(3, height - 5),
          emptyText: 'No matching messages',
          helpText: 'Enter jump · Esc close',
          onTransition: (transition): AgentTuiMessage => ({
            type: 'search.transition',
            transition
          }),
          onAccept: (event): AgentTuiMessage => ({ type: 'search.accept', event })
        })
      }
    });
    case 'help': return dialog({
      ...modalOptions('help-dialog', 'Keyboard shortcuts', 'help-content', width, 13),
      slots: {
        content: richText({
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
        })
      }
    });
    case 'debug': return dialog({
      ...modalOptions('debug-dialog', 'Runtime details', 'debug-content', width, height),
      slots: {
        content: modalViewport(
          richText({ id: 'debug-details', segments: body(state.overlay.text), wrap: true }),
          state,
          'debug-content'
        )
      }
    });
  }
}

function approvalDialog(state: AgentTuiState, context: TuiContext): Element<AgentTuiMessage> {
  if (state.run.kind !== 'waiting_for_approval') return text({ content: '' });
  const suspension = state.run.suspension;
  const approval = suspension.pendingApprovals[0];
  const width = Math.max(36, Math.min(88, context.terminalSize.columns - 4));
  const bodyElement = approval === undefined
    ? richText({ id: 'approval-missing', segments: errorText('The runtime suspended without an approval request.'), wrap: true })
    : approvalContent(approval, suspension.pendingApprovals.length, state);
  return dialog({
    id: 'approval-dialog',
    title: 'Approval required',
    modal: true,
    focusPolicy: { initialFocus: { kind: 'element', elementId: 'approval-deny' }, returnFocus: 'restore' },
    dismissal: { escape: true, outsidePress: false },
    onAction: (): AgentTuiMessage => ({ type: 'approval.decide', decision: 'deny' }),
    slots: {
      content: modalViewport(bodyElement, state, 'approval-content-scroll'),
      actions: row([
        button({ id: 'approval-deny', label: 'Deny', tone: 'destructive', onAction: (): AgentTuiMessage => ({ type: 'approval.decide', decision: 'deny' }) }),
        button({ id: 'approval-allow', label: 'Allow once', tone: 'primary', onAction: (): AgentTuiMessage => ({ type: 'approval.decide', decision: 'allow' }) })
      ], { id: 'approval-actions', gap: 2 })
    },
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
    onScroll: (event): AgentTuiMessage => ({
      type: 'modal.scrolled',
      offsetRow: event.nextState.offsetRow,
    })
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
    disclosure({
      id: 'approval-details',
      label: 'Exact input and effects',
      expanded: state.conversation.expandedIds.includes('approval-details'),
      slots: {
        content: richText({ id: 'approval-raw', segments: body(details), wrap: true })
      },
      onAction: (): AgentTuiMessage => ({ type: 'activity.toggle', id: 'approval-details' })
    })
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
      await handler(suspension, decision);
      return { kind: 'none' as const };
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
  readonly geometry: ScrollGeometry;
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
  const geometry: ScrollGeometry = {
    contentRows: totalRows,
    contentColumns: width,
    viewportRows,
    viewportColumns: width
  };
  const scroll = normalizeScrollState(state.conversation.scroll, geometry);
  return { items, starts, scroll, geometry };
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

const conversationSearchIndexes = new WeakMap<
  AgentTuiConversationState,
  SearchPickerIndex<AgentTuiConversationEntry>
>();

function conversationSearchIndex(
  state: AgentTuiState,
): SearchPickerIndex<AgentTuiConversationEntry> {
  const cached = conversationSearchIndexes.get(state.conversation);
  if (cached !== undefined) return cached;
  const index = prepareSearchPickerIndex(
    visibleConversationItems(state),
    conversationSearchEntry,
  );
  conversationSearchIndexes.set(state.conversation, index);
  return index;
}

function conversationSearchEntry(entry: AgentTuiConversationEntry) {
  const content = conversationText(entry).trim().replaceAll(/\s+/g, ' ');
  const label = content.length <= 90 ? content : `${content.slice(0, 89)}…`;
  return {
    id: entry.id,
    label: label.length === 0 ? entry.kind : label,
    value: entry,
    group: entry.kind,
  };
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
      escape: true as const,
      outsidePress: false as const
    },
    onAction: (): AgentTuiMessage => ({ type: 'overlay.close' }),
    width,
    height,
    padding: 1
  };
}

function binding(
  id: string,
  key: 'p' | 'f' | 'f1' | 'pageUp' | 'pageDown' | 'enter' | 'o',
  modifiers: { readonly ctrl?: boolean; readonly shift?: boolean },
  message: AgentTuiMessage,
  enabled: (context: TuiInputBindingContext<AgentTuiState>) => boolean
) {
  return {
    id,
    triggers: [{ kind: 'key' as const, key, modifiers }],
    phase: 'beforeFocus' as const,
    message,
    enabled
  };
}

function composerBindingEnabled({ state, focusPath }: TuiInputBindingContext<AgentTuiState>): boolean {
  return state.overlay.kind === 'none'
    && state.run.kind !== 'waiting_for_approval'
    && focusPath?.includes('composer') === true;
}

function composerNewlineMessage(): AgentTuiMessage {
  return {
    type: 'composer.edit',
    action: { kind: 'edit', operation: { kind: 'insert', text: '\n' } }
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
  const accesses = approval.effects.accesses;
  if (accesses.length === 0) return 'tool operation';
  const summary = accesses.map((access) => `${access.mode.replaceAll('_', ' ')} · ${access.scope}`).join(', ');
  const ambient = accesses.some((access) => access.mode === 'execute')
    && approval.effects.lockScopes.includes('workspace/files');
  return ambient
    ? `${summary}. Ambient shell authority can read, write, or delete files, access the network, and start child processes.`
    : summary;
}

function approvalSubject(approval: AgentApprovalRequest): string {
  if (typeof approval.input !== 'object' || approval.input === null || Array.isArray(approval.input)) return '';
  const input = approval.input as import('@agent-core/json').JsonObject;
  const candidates = [
    ['Command', input.command],
    ['Path', input.path],
    ['Query', input.query],
    ['Pattern', input.pattern]
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
