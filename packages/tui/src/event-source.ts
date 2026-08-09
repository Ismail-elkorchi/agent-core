import type { TuiEventSource, TuiSubscriptionContext } from '@ismail-elkorchi/terminal-ui/tui';
import type { AgentTuiMessage } from './messages.js';

export class AgentTuiEventSource implements TuiEventSource<AgentTuiMessage> {
  readonly id = 'agent-core-events';
  readonly generation = 0;
  readonly source = 'external';
  readonly delivery = 'sequential';

  private readonly queued: AgentTuiMessage[] = [];
  private readonly waiters: ((message: AgentTuiMessage | undefined) => void)[] = [];
  private closed = false;
  private static readonly MAX_QUEUED_MESSAGES = 1024;

  enqueue(message: AgentTuiMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }
    if (this.queued.length >= AgentTuiEventSource.MAX_QUEUED_MESSAGES) {
      const disposable = this.queued.findIndex(isDisposableProgressMessage);
      this.queued.splice(disposable >= 0 ? disposable : 0, 1);
    }
    this.queued.push(message);
  }

  async *messages(context: TuiSubscriptionContext): AsyncIterable<AgentTuiMessage> {
    while (!this.closed && !context.signal.aborted) {
      const next = await this.next(context.signal);
      if (next === undefined) return;
      yield next;
    }
  }

  dispose(): void {
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    this.queued.splice(0);
    for (const waiter of waiters) {
      waiter(undefined);
    }
  }

  private next(signal: AbortSignal): Promise<AgentTuiMessage | undefined> {
    const queued = this.queued.shift();
    if (queued !== undefined || this.closed) return Promise.resolve(queued);
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = (message: AgentTuiMessage | undefined): void => {
        signal.removeEventListener('abort', abort);
        resolve(message);
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
  }
}

function isDisposableProgressMessage(message: AgentTuiMessage): boolean {
  return message.type === 'progress' && (
    message.event.type === 'assistant.delta'
    || message.event.type === 'assistant.reasoning'
    || message.event.type === 'assistant.status'
    || message.event.type === 'tool.updated'
  );
}
