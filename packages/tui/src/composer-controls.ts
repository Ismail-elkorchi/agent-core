import { button, text, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { row } from '@ismail-elkorchi/terminal-ui/layout';
import type { DraftAttachment } from './draft.js';

export function composerControls<Message extends { readonly type: string }>(options: {
  readonly attachments: readonly DraftAttachment[];
  readonly queued: number;
  readonly delivery: 'input' | 'follow_up';
  readonly onAttachments: () => Message;
  readonly onQueue: () => Message;
}): Element<Message> {
  return row(
    [
      text({
        content: options.delivery === 'follow_up' ? 'Enter: queue follow-up' : 'Enter: send',
        textRole: 'caption'
      }),
      button({
        id: 'draft-attachments',
        label:
          options.attachments.length === 0 ? 'Attach' : `${String(options.attachments.length)} attached`,
        onPress: options.onAttachments
      }),
      ...(options.queued === 0
        ? []
        : [
            button({
              id: 'draft-queue',
              label: `${String(options.queued)} queued`,
              onPress: options.onQueue
            })
          ])
    ],
    {
      sizes: [
        { kind: 'fill' },
        { kind: 'content' },
        ...(options.queued === 0 ? [] : [{ kind: 'content' as const }])
      ]
    }
  );
}
