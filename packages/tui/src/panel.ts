import type { ComponentMessage } from '@ismail-elkorchi/terminal-ui/component';
import { button, dialog, text, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { column, flow } from '@ismail-elkorchi/terminal-ui/layout';

/** A dismissible surface with a real close action, including loading and empty states. */
export function panel<Message extends ComponentMessage>(options: {
  readonly id: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly focusId?: string;
  readonly slots: { readonly content: Element<Message>; readonly actions?: Element<Message> };
  readonly onClose: () => Message;
}): Element<Message> {
  const closeId = `${options.id}:close`;
  return dialog({
    id: options.id,
    title: options.title,
    width: options.width,
    height: options.height,
    modal: true,
    focusPolicy: {
      initialFocus: { kind: 'element', elementId: options.focusId ?? closeId },
      returnFocus: 'restore'
    },
    dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
    onDismiss: options.onClose,
    slots: {
      content: options.slots.content,
      actions: column([
        ...(options.slots.actions === undefined ? [] : [options.slots.actions]),
        flow(
          [
            button({ id: closeId, label: 'Close', onPress: options.onClose }),
            text({ content: options.width < 60 ? 'Esc close' : 'Esc / Ctrl+C close', textRole: 'caption' })
          ],
          { direction: 'horizontal' }
        )
      ])
    }
  });
}
