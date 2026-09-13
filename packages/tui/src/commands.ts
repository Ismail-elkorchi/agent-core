import {
  searchPickerReducer,
  searchPickerView,
  textAreaReducer,
  type SearchPickerControlTransition,
  type SearchPickerIndex,
  type TextAreaState,
  type TextAreaTransition,
  type UnscrolledSearchPickerState
} from '@ismail-elkorchi/terminal-ui/behavior';
import { button, text, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';

export interface Command {
  readonly name: string;
  readonly description: string;
}

export interface CommandCompletion {
  readonly input: TextAreaState;
  readonly end: number;
  readonly names: readonly string[];
  readonly selected: number;
}

/** Completion is an editor interaction, not a second command parser or input buffer. */
export function completeCommand(
  input: TextAreaState,
  transition: TextAreaTransition,
  commands: readonly Command[]
): CommandCompletion | undefined {
  if (
    transition.kind !== 'edit' ||
    ('text' in transition.operation && transition.operation.text.length !== 1)
  )
    return undefined;
  const source = textDocumentText(input.document);
  const caret = input.caret.position.offset;
  const prefix = source.slice(0, caret);
  const token = /^\/[a-z-]*/u.exec(source)?.[0];
  if (
    token === undefined ||
    caret > token.length ||
    !/^\/[a-z-]*$/u.test(prefix) ||
    /[\r\n]/u.test(source) ||
    (source[token.length] !== undefined && !/\s/u.test(source[token.length] ?? '')) ||
    input.selection !== undefined
  )
    return undefined;
  const names = commands
    .filter((command) => command.name.startsWith(prefix))
    .map((command) => command.name)
    .sort((left, right) => Number(right === prefix) - Number(left === prefix));
  return names.length === 0 ? undefined : { input, end: token.length, names, selected: 0 };
}

/** An exact command name takes precedence over a longer prefix match while editing the query. */
export function transitionCommandPicker(
  state: UnscrolledSearchPickerState,
  transition: SearchPickerControlTransition,
  index: SearchPickerIndex,
  commands: readonly Command[]
): UnscrolledSearchPickerState {
  const next = searchPickerReducer(state, transition, { searchPickerIndex: index });
  const query = searchPickerView(next).input.text;
  if (query === searchPickerView(state).input.text) return next;
  const name = query.startsWith('/') ? query : `/${query}`;
  return commands.some((command) => command.name === name)
    ? searchPickerReducer(next, { kind: 'setActive', id: name }, { searchPickerIndex: index })
    : next;
}

export function moveCommand(completion: CommandCompletion, delta: number): CommandCompletion {
  return {
    ...completion,
    selected: (completion.selected + delta + completion.names.length) % completion.names.length
  };
}

export function commandSuggestions<Message extends { readonly type: string }>(
  completion: CommandCompletion,
  commands: readonly Command[],
  choose: (name: string) => Message
): Element<Message> {
  const start = Math.max(0, completion.selected - 4);
  return column([
    ...completion.names.slice(start, start + 5).map((name, index) =>
      button({
        id: `completion:${name}`,
        label: `${start + index === completion.selected ? '› ' : '  '}${name}  ${commands.find((command) => command.name === name)?.description ?? ''}`,
        onPress: () => choose(name)
      })
    ),
    text({ content: '↑↓ choose · Tab complete · Enter open · Esc dismiss', textRole: 'caption' })
  ]);
}

export function commandName(source: string, commands: readonly Command[]): string | undefined {
  if (source.includes('\n') || source.includes('\r')) return undefined;
  const first = source.trim().split(/\s/u)[0];
  return commands.some((command) => command.name === first) ? first : undefined;
}

/** Replace only the command token, retaining suffix text and the editor's undo history. */
export function insertCommand(
  completion: CommandCompletion,
  input: TextAreaState,
  name: string
): TextAreaState {
  if (completion.input !== input || (name !== '' && !completion.names.includes(name))) return input;
  return textAreaReducer(input, {
    kind: 'edit',
    operation: {
      kind: 'replaceRange',
      range: { startOffset: 0, endOffsetExclusive: completion.end },
      text: name
    }
  }).state;
}
