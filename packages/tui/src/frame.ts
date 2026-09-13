import type { ComponentMessage } from '@ismail-elkorchi/terminal-ui/component';
import { divider, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { grid, row } from '@ismail-elkorchi/terminal-ui/layout';

/** One transcript, a growing composer, and concise controls; domains supply the content. */
export function conversationFrame<Message extends ComponentMessage>(options: {
  readonly id: string;
  readonly terminalRows: number;
  readonly composerRows: number;
  readonly slots: {
    readonly status: Element<Message>;
    readonly conversation: Element<Message>;
    readonly composer: Element<Message>;
    readonly footer: readonly Element<Message>[];
  };
}): Element<Message> {
  if (options.terminalRows < 5) return options.slots.composer;
  return grid(
    [
      options.slots.status,
      options.slots.conversation,
      divider({ id: `${options.id}:divider` }),
      options.slots.composer,
      row(options.slots.footer, { sizes: options.slots.footer.map(() => ({ kind: 'content' })) })
    ],
    {
      id: options.id,
      rows: [
        { kind: 'fixed', cells: 1 },
        { kind: 'fill' },
        { kind: 'fixed', cells: 1 },
        { kind: 'fixed', cells: options.composerRows },
        { kind: 'fixed', cells: 1 }
      ],
      columns: [{ kind: 'fill' }]
    }
  );
}
