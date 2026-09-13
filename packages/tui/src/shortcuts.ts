import {
  decodeInputTrigger,
  inputTriggerIdentity,
  matchesInputTrigger,
  type InputTrigger
} from '@ismail-elkorchi/terminal-ui/input';
import { ignoreMessage, type KeyboardBinding } from '@ismail-elkorchi/terminal-ui/interaction';
import type {
  TuiBindingHelpItem,
  TuiInputBinding,
  TuiInputBindingContext
} from '@ismail-elkorchi/terminal-ui/tui';

export type Shortcut = Extract<InputTrigger, { readonly kind: 'key' }>;
export interface ShortcutAction {
  readonly id: string;
  readonly label: string;
  readonly bindings: readonly string[];
}
export type ShortcutOverrides = Readonly<Record<string, Shortcut>>;
const shortcutKeys = [
  ...Array.from('abcdefghijklmnopqrstuvwxyz0123456789'),
  ...Array.from({ length: 12 }, (_, index) => `f${String(index + 1)}`),
  'escape',
  'enter',
  'tab',
  'backspace',
  'delete',
  'arrowUp',
  'arrowDown',
  'arrowLeft',
  'arrowRight',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'insert',
  'space'
];
export function parseShortcut(value: unknown): Shortcut {
  const trigger = decodeInputTrigger(value);
  if (
    trigger.kind !== 'key' ||
    !shortcutKeys.includes(trigger.key) ||
    trigger.modifiers?.kind === 'any' ||
    (!trigger.modifiers?.ctrl &&
      !trigger.modifiers?.alt &&
      !trigger.modifiers?.meta &&
      !/^f\d+$/u.test(trigger.key))
  )
    throw new Error(
      'Choose Ctrl, Alt or Meta with a letter, digit or navigation key, or F1–F12. Ordinary typing remains editor input.'
    );
  return trigger;
}

/** Route configurable actions using public trigger matching; the host still owns decoding and focus. */
export function shortcutBindings<State, Message>(
  bindings: readonly TuiInputBinding<State, Message>[],
  options: {
    readonly actions: readonly ShortcutAction[];
    overrides(state: State): ShortcutOverrides;
    capturing(state: State): string | undefined;
    captured(action: string, shortcut: Shortcut): Message;
    cancelled(): Message;
    failed(message: string): Message;
  }
): readonly TuiInputBinding<State, Message>[] {
  const actionFor = (id: string) => options.actions.find((action) => action.bindings.includes(id));
  const enabled = (binding: TuiInputBinding<State, Message>, context: TuiInputBindingContext<State>) =>
    typeof binding.enabled === 'function' ? binding.enabled(context) : binding.enabled !== false;
  return [
    {
      id: 'custom-shortcuts',
      phase: 'beforeFocus',
      triggers: shortcutKeys.map((key) =>
        decodeInputTrigger({ kind: 'key', key, modifiers: { kind: 'any' } })
      ),
      toMessage(context) {
        const capture = options.capturing(context.state);
        const overrides = options.overrides(context.state);
        if (capture !== undefined) {
          if (context.event.kind !== 'key' || context.event.eventType === 'release') return ignoreMessage();
          if (context.event.key === 'escape' || (context.event.key === 'c' && context.event.modifiers.ctrl))
            return options.cancelled();
          try {
            const { ctrl, alt, meta, shift } = context.event.modifiers;
            const shortcut = parseShortcut({
              kind: 'key',
              key: context.event.key,
              modifiers: {
                ...(ctrl ? { ctrl: true } : {}),
                ...(alt ? { alt: true } : {}),
                ...(meta ? { meta: true } : {}),
                ...(shift ? { shift: true } : {})
              }
            });
            const identity = inputTriggerIdentity(shortcut);
            const conflict = bindings.find((binding) => {
              const action = actionFor(binding.id);
              if (action?.id === capture) return false;
              const override = action === undefined ? undefined : overrides[action.id];
              return (override === undefined ? binding.triggers : [override]).some(
                (trigger) => inputTriggerIdentity(trigger) === identity
              );
            });
            if (conflict !== undefined)
              return options.failed(
                `That shortcut belongs to ${conflict.label ?? conflict.id}. Choose another key.`
              );
            return options.captured(capture, shortcut);
          } catch (error) {
            return options.failed(error instanceof Error ? error.message : String(error));
          }
        }
        for (const action of options.actions) {
          const trigger = overrides[action.id];
          if (trigger === undefined || !matchesInputTrigger(trigger, context.event)) continue;
          const binding = bindings.find(
            (binding) => action.bindings.includes(binding.id) && enabled(binding, context)
          );
          if (binding !== undefined)
            return binding.toMessage === undefined ? binding.message : binding.toMessage(context);
        }
        return ignoreMessage();
      }
    },
    ...bindings.map((binding): TuiInputBinding<State, Message> => {
      const action = actionFor(binding.id);
      return action === undefined
        ? binding
        : {
            ...binding,
            enabled: (context) =>
              options.overrides(context.state)[action.id] === undefined && enabled(binding, context)
          };
    })
  ];
}
export function shortcutHelp(
  help: readonly TuiBindingHelpItem[],
  overrides: ShortcutOverrides,
  actions: readonly ShortcutAction[]
): readonly TuiBindingHelpItem[] {
  return help.map((item) => {
    const action = actions.find((action) => action.bindings.includes(item.id));
    const trigger = action === undefined ? undefined : overrides[action.id];
    return trigger === undefined
      ? item
      : { ...item, bindings: [{ binding: trigger satisfies KeyboardBinding, label: item.label }] };
  });
}
