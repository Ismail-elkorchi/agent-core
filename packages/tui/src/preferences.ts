import { button, checkbox, text, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { formatKeyboardBinding } from '@ismail-elkorchi/terminal-ui/interaction';
import { column, flow, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import { builtInThemes } from '@ismail-elkorchi/terminal-ui/theme';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import { panel } from './panel.js';
import type { Shortcut, ShortcutAction, ShortcutOverrides } from './shortcuts.js';

export interface TuiPreferences {
  readonly shortcuts: ShortcutOverrides;
  readonly statusline: readonly string[];
  readonly theme: keyof typeof builtInThemes;
  readonly showReasoning: boolean;
  readonly showTools: boolean;
  readonly notify: boolean;
}
export const defaultTuiPreferences: TuiPreferences = Object.freeze({
  shortcuts: Object.freeze({}),
  statusline: Object.freeze(['model', 'reasoning', 'mode', 'status', 'queue']),
  theme: 'minimal',
  showReasoning: false,
  showTools: false,
  notify: false
});

export interface StatusField {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
}

export type PreferencesMessage =
  | { readonly type: 'preferences.capture'; readonly action: string }
  | { readonly type: 'preferences.captured'; readonly action: string; readonly shortcut: Shortcut }
  | { readonly type: 'preferences.capture-cancel' }
  | { readonly type: 'preferences.capture-failed'; readonly message: string }
  | { readonly type: 'preferences.reset-shortcut'; readonly action: string }
  | { readonly type: 'preferences.field'; readonly id: string }
  | { readonly type: 'preferences.move'; readonly id: string; readonly delta: number }
  | { readonly type: 'preferences.theme'; readonly theme: TuiPreferences['theme'] }
  | { readonly type: 'preferences.toggle'; readonly key: 'showReasoning' | 'showTools' | 'notify' }
  | { readonly type: 'preferences.scroll'; readonly offset: number }
  | { readonly type: 'preferences.save' };

export interface PresentationOptions {
  readonly preferences: TuiPreferences;
  save(preferences: TuiPreferences): Promise<void>;
}

export function savePreferences<Message>(
  preferences: TuiPreferences,
  storage: PresentationOptions | undefined,
  failed: (message: string) => Message
): TuiEffect<Message> {
  return {
    id: 'presentation-save',
    concurrency: 'enqueue',
    async run() {
      await storage?.save(preferences);
      return { kind: 'none' };
    },
    onError: ({ diagnostic }) => ({ kind: 'message', message: failed(diagnostic.message) })
  };
}

export function updatePreferences(
  preferences: TuiPreferences,
  message: PreferencesMessage
): TuiPreferences {
  switch (message.type) {
    case 'preferences.captured':
      return {
        ...preferences,
        shortcuts: { ...preferences.shortcuts, [message.action]: message.shortcut }
      };
    case 'preferences.reset-shortcut': {
      const shortcuts = Object.fromEntries(
        Object.entries(preferences.shortcuts).filter(([action]) => action !== message.action)
      );
      return { ...preferences, shortcuts };
    }
    case 'preferences.capture':
    case 'preferences.capture-cancel':
    case 'preferences.capture-failed':
      return preferences;
    case 'preferences.field':
      return {
        ...preferences,
        statusline: preferences.statusline.includes(message.id)
          ? preferences.statusline.filter((id) => id !== message.id)
          : [...preferences.statusline, message.id]
      };
    case 'preferences.move': {
      const statusline = [...preferences.statusline];
      const from = statusline.indexOf(message.id);
      if (from < 0) return preferences;
      statusline.splice(from, 1);
      statusline.splice(Math.max(0, Math.min(statusline.length, from + message.delta)), 0, message.id);
      return { ...preferences, statusline };
    }
    case 'preferences.theme':
      return { ...preferences, theme: message.theme };
    case 'preferences.toggle':
      return { ...preferences, [message.key]: !preferences[message.key] };
    case 'preferences.save':
    case 'preferences.scroll':
      return preferences;
  }
}

export function statusline(
  preferences: TuiPreferences,
  fields: readonly StatusField[],
  preview = false
): string {
  return preferences.statusline
    .flatMap((id) => {
      const field = fields.find((field) => field.id === id);
      return field === undefined
        ? []
        : field.value === undefined
          ? preview
            ? [`${field.label}: unavailable`]
            : []
          : [field.value];
    })
    .join(' · ');
}

export function preferencesTheme(preferences: TuiPreferences) {
  return builtInThemes[preferences.theme];
}

export function preferencesView(
  preferences: TuiPreferences,
  fields: readonly StatusField[],
  width: number,
  height: number,
  offset = 0,
  shortcuts: {
    readonly actions: readonly ShortcutAction[];
    readonly capturing?: string;
    readonly error?: string;
  } = { actions: [] }
): Element<PreferencesMessage | { readonly type: 'overlay.close' }> {
  type Message = PreferencesMessage | { readonly type: 'overlay.close' };
  const selected = preferences.statusline.flatMap((id) => fields.filter((field) => field.id === id));
  const ordered = [...selected, ...fields.filter((field) => !preferences.statusline.includes(field.id))];
  return panel({
    id: 'preferences',
    title: 'Status line and appearance',
    width,
    height,
    onClose: (): Message => ({ type: 'overlay.close' }),
    focusId: ordered[0] === undefined ? 'preferences-save' : `preference:${ordered[0].id}`,
    slots: {
      content: viewport(
        column([
          text({
            content:
              shortcuts.error ??
              (shortcuts.capturing === undefined
                ? ''
                : 'Press a shortcut · Esc or Ctrl+C cancels key capture')
          }),
          ...shortcuts.actions.map((action) => {
            const shortcut = preferences.shortcuts[action.id];
            return flow(
              [
                button<Message>({
                  id: `shortcut:${action.id}`,
                  label: `${action.label}: ${shortcut === undefined ? 'default' : formatKeyboardBinding(shortcut)}`,
                  onPress: () => ({ type: 'preferences.capture', action: action.id })
                }),
                button<Message>({
                  id: `shortcut-reset:${action.id}`,
                  label: 'Reset',
                  onPress: () => ({ type: 'preferences.reset-shortcut', action: action.id })
                })
              ],
              { direction: 'horizontal' }
            );
          }),
          text({ content: `Preview: ${statusline(preferences, fields, true)}` }),
          ...ordered.map((field) =>
            flow(
              [
                checkbox<Message>({
                  id: `preference:${field.id}`,
                  label: field.label,
                  checked: preferences.statusline.includes(field.id),
                  onTransition: () => ({ type: 'preferences.field', id: field.id })
                }),
                ...(preferences.statusline.includes(field.id)
                  ? [-1, 1].map((delta) =>
                      button({
                        id: `preference:${field.id}:${String(delta)}`,
                        label: delta < 0 ? 'Up' : 'Down',
                        onPress: (): Message => ({ type: 'preferences.move', id: field.id, delta })
                      })
                    )
                  : [])
              ],
              { direction: 'horizontal' }
            )
          ),
          flow(
            (Object.keys(builtInThemes) as TuiPreferences['theme'][]).map((theme) =>
              button({
                id: `theme:${theme}`,
                label: `${preferences.theme === theme ? '✓ ' : ''}${theme}`,
                onPress: (): Message => ({ type: 'preferences.theme', theme })
              })
            ),
            { direction: 'horizontal' }
          ),
          ...(
            [
              ['showReasoning', 'Show reasoning'],
              ['showTools', 'Expand tool output'],
              ['notify', 'Notify on completion or required action']
            ] as const
          ).map(([key, label]) =>
            checkbox<Message>({
              id: `preference:${key}`,
              label,
              checked: preferences[key],
              onTransition: () => ({ type: 'preferences.toggle', key })
            })
          )
        ]),
        {
          id: 'preferences-fields',
          offset: { row: offset },
          scrollbar: { axis: 'vertical', visible: 'auto' },
          onScroll: (event): Message => ({ type: 'preferences.scroll', offset: event.nextState.offsetRow })
        }
      ),
      actions: button({
        id: 'preferences-save',
        label: 'Save',
        onPress: (): Message => ({ type: 'preferences.save' })
      })
    }
  });
}
