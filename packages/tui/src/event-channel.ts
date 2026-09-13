import type { ComponentMessage } from '@ismail-elkorchi/terminal-ui/component';
import type { MessageResolution } from '@ismail-elkorchi/terminal-ui/interaction';
import { ignoreMessage } from '@ismail-elkorchi/terminal-ui/interaction';
import type {
  TuiEventSource,
  TuiSourceSink,
  TuiSubscriptionContext
} from '@ismail-elkorchi/terminal-ui/tui';
import { reliableSourceMessage, replaceableSourceMessage } from '@ismail-elkorchi/terminal-ui/tui';

export class TuiEventChannel<Message extends ComponentMessage> implements TuiEventSource<Message> {
  constructor(
    readonly id: string,
    private readonly options: {
      readonly replacementKey: (message: Message) => string | undefined;
      readonly failureMessage: (message: string) => Message;
    }
  ) {}
  readonly generation = 0;
  readonly source = 'external';
  readonly channel = { capacity: 64 };

  private readonly attached = deferred<TuiSourceSink<Message>>();
  private readonly completion = deferred<undefined>();
  private admission: Promise<void> = Promise.resolve();
  private accepting = true;
  private running = false;
  private cancelled = false;
  private failed = false;
  private failure: unknown;

  enqueue(message: Message): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error('TUI event channel is closed.'));
    const admission = this.admission.then(async () => {
      const sink = await this.attached.promise;
      const key = this.options.replacementKey(message);
      await sink.emit(
        key === undefined ? reliableSourceMessage(message) : replaceableSourceMessage(key, message)
      );
    });
    this.admission = admission.then(
      () => undefined,
      (cause: unknown) => {
        this.fail(cause);
      }
    );
    return admission;
  }

  fail(cause: unknown): void {
    if (!this.accepting) return;
    this.accepting = false;
    this.failed = true;
    this.failure = cause;
    this.completion.reject(cause);
  }

  async run(context: TuiSubscriptionContext, sink: TuiSourceSink<Message>): Promise<void> {
    if (this.running) throw new Error('TUI event channel is already running.');
    this.running = true;
    this.attached.resolve(sink);
    await Promise.race([this.completion.promise, aborted(context.signal)]);
    if (context.signal.aborted) {
      this.accepting = false;
      this.cancelled = true;
    }
  }

  onLifecycle(
    event: import('@ismail-elkorchi/terminal-ui/tui').TuiSourceLifecycle
  ): MessageResolution<Message> {
    return event.kind === 'failed'
      ? this.options.failureMessage(event.diagnostic.message)
      : ignoreMessage();
  }

  async dispose(): Promise<void> {
    if (this.cancelled || this.failed) {
      this.accepting = false;
      await this.admission.catch(() => undefined);
      return;
    }
    return this.close();
  }

  async close(): Promise<void> {
    if (this.cancelled) {
      await this.admission.catch(() => undefined);
      return;
    }
    if (this.failed) throw this.failure;
    if (!this.accepting) return this.admission;
    this.accepting = false;
    if (!this.running) this.attached.reject(new Error('TUI event channel closed before attachment.'));
    try {
      await this.admission;
      this.completion.resolve(undefined);
    } catch (cause) {
      this.completion.reject(cause);
      throw cause;
    }
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true }
    );
  });
}
