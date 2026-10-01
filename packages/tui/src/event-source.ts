import type { ComponentMessage } from '@ismail-elkorchi/terminal-ui/component';
import { ignoreMessage } from '@ismail-elkorchi/terminal-ui/interaction';
import type { TuiEventSource, TuiSubscriptionContext } from '@ismail-elkorchi/terminal-ui/tui';
import { reliableSourceMessage, replaceableSourceMessage } from '@ismail-elkorchi/terminal-ui/tui';

/** Attach application delivery only while the runtime owns its source and sink. */
export function applicationEventSource<Message extends ComponentMessage>(
  id: string,
  options: {
    readonly subscribe: (
      emit: (message: Message) => Promise<void>,
      failed: (cause: unknown) => void
    ) => () => void;
    readonly start?: (
      emit: (message: Message) => Promise<void>,
      context: TuiSubscriptionContext
    ) => Promise<void>;
    readonly replacementKey: (message: Message) => string | undefined;
    readonly failureMessage: (message: string) => Message;
  }
): TuiEventSource<Message> {
  return {
    id,
    generation: 0,
    source: 'external',
    channel: { capacity: 64 },
    async run(context, sink) {
      if (context.signal.aborted) return;
      let resolve!: () => void;
      let reject!: (cause: unknown) => void;
      const completion = new Promise<void>((completed, failed) => {
        resolve = completed;
        reject = failed;
      });
      const abort = () => {
        resolve();
      };
      let unsubscribe: (() => void) | undefined;
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        const emit = (message: Message) => {
          const key = options.replacementKey(message);
          return sink.emit(
            key === undefined
              ? reliableSourceMessage(message)
              : replaceableSourceMessage(key, message)
          );
        };
        unsubscribe = options.subscribe(emit, reject);
        await Promise.race([Promise.resolve(options.start?.(emit, context)), completion]);
        await completion;
      } finally {
        context.signal.removeEventListener('abort', abort);
        unsubscribe?.();
      }
    },
    onLifecycle: (event) =>
      event.kind === 'failed' ? options.failureMessage(event.diagnostic.message) : ignoreMessage()
  };
}
