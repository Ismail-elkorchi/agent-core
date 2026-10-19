import type { ComponentMessage } from '@ismail-elkorchi/terminal-ui/component';
import {
  button,
  disclosure,
  richText,
  type Element,
  type InlineContent
} from '@ismail-elkorchi/terminal-ui/components';
import { type ConversationEntry, type ConversationReferenceEntry } from './conversation.js';
import type { MarkdownDocument } from './markdown.js';

/** Shared display of recorded facts; expansion never changes their stored or model-facing form. */
export function conversationEntryView<Message extends ComponentMessage>(
  entry: ConversationEntry,
  options: {
    readonly width: number;
    readonly expanded: boolean;
    readonly markdown: (id: string, source: string) => MarkdownDocument;
    readonly onToggle: (id: string) => Message;
    readonly onInspect: (entry: ConversationReferenceEntry) => Message;
  }
): Element<Message> {
  if (entry.kind === 'reference')
    return button({
      id: entry.id,
      label: `Read recorded entry · ${String(entry.bytes)} bytes`,
      onPress: () => options.onInspect(entry)
    });
  if (entry.kind === 'activity') {
    const glyph = { running: '•', complete: '✓', success: '✓', warning: '!', failed: '✗' }[
      entry.status
    ];
    return disclosure({
      id: entry.id,
      label: `${glyph} ${entry.label}`,
      ...(entry.summary === undefined ? {} : { summary: [{ kind: 'text', text: entry.summary }] }),
      expanded: options.expanded,
      slots: {
        content: richText({
          segments: (entry.details ?? []).flatMap(
            (detail): InlineContent => [
              ...(detail.format === 'diff'
                ? patchSegments(detail.content)
                : [{ kind: 'text' as const, text: detail.content }]),
              { kind: 'text', text: '\n\n' }
            ]
          ),
          wrap: { preserveWords: true }
        })
      },
      onTransition: () => options.onToggle(entry.id)
    });
  }
  if (entry.kind === 'reasoning')
    return disclosure({
      id: entry.id,
      label: entry.channel === 'summary' ? 'Reasoning summary' : 'Reasoning',
      expanded: options.expanded,
      slots: {
        content: richText({
          segments: [{ kind: 'text', text: entry.text, style: { dim: true } }],
          wrap: true
        })
      },
      onTransition: () => options.onToggle(entry.id)
    });
  const segments: InlineContent =
    entry.kind === 'assignment'
      ? [{ kind: 'text', text: `Delegated assignment · model-authored · from ${entry.origin.sender.sessionId}\n`, style: { bold: true } },
          { kind: 'text', text: entry.text }]
      : entry.kind === 'peer'
      ? [{ kind: 'text', text: `Peer ${entry.participantId} · model-authored contribution\n`, style: { bold: true } },
          ...options.markdown(entry.id, entry.text).render(options.width).segments]
      : entry.kind === 'assistant'
      ? [
          {
            kind: 'text',
            text: `Assistant${entry.status === 'interrupted' ? ' · interrupted' : ''}\n`,
            style: { bold: true }
          },
          ...options.markdown(entry.id, entry.text).render(options.width).segments
        ]
      : entry.kind === 'user'
        ? [
            { kind: 'text', text: 'You\n', style: { bold: true } },
            { kind: 'text', text: entry.text }
          ]
        : [
            {
              kind: 'text',
              text: entry.text,
              style: entry.tone === 'error' ? { bold: true } : { dim: true }
            }
          ];
  return richText({
    id: entry.id,
    segments: [...segments, { kind: 'text', text: '\n' }],
    wrap: { preserveWords: true }
  });
}

/** Coloring never changes patch text; additions and removals retain their literal prefixes. */
export function patchSegments(patch: string): InlineContent {
  return patch.split(/(?<=\n)/u).map((line) => ({
    kind: 'text',
    text: line,
    ...(line.startsWith('+')
      ? { style: { fg: { kind: 'theme', token: 'status.success' } } }
      : line.startsWith('-')
        ? { style: { fg: { kind: 'theme', token: 'status.error' } } }
        : line.startsWith('@@') || line.startsWith('***')
          ? { style: { bold: true } }
          : {})
  }));
}
