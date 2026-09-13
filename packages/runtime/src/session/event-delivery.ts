export interface ApplicationDeliveryEvent {
  readonly type: 'delivery.gap';
}

type Listener<Event> = (event: Event | ApplicationDeliveryEvent) => void | Promise<void>;
interface Subscription<Event> {
  readonly listener: Listener<Event>;
  readonly onFailure: (error: Error) => void;
  readonly queue: (Event | ApplicationDeliveryEvent)[];
  active: boolean;
  delivering: boolean;
  gapped: boolean;
}

/** Delivery is bounded and independent of application execution and settlement. */
export class ApplicationEvents<Event> {
  private readonly subscriptions = new Set<Subscription<Event>>();

  constructor(
    private readonly replacementKey: (event: Event | ApplicationDeliveryEvent) => string | undefined = () =>
      undefined
  ) {}

  subscribe(listener: Listener<Event>, onFailure: (error: Error) => void): () => void {
    const subscription: Subscription<Event> = {
      listener,
      onFailure,
      queue: [],
      active: true,
      delivering: false,
      gapped: false
    };
    this.subscriptions.add(subscription);
    return () => {
      this.detach(subscription);
    };
  }

  publish(event: Event | ApplicationDeliveryEvent): void {
    for (const subscription of this.subscriptions) {
      if (subscription.gapped) continue;
      const key = this.replacementKey(event);
      if (key !== undefined) {
        let replaced = false;
        for (let index = subscription.queue.length - 1; index >= 0; index--) {
          const queued = subscription.queue[index];
          if (queued === undefined) break;
          const previousKey = this.replacementKey(queued);
          if (previousKey === undefined) break;
          if (previousKey === key) {
            subscription.queue[index] = event;
            replaced = true;
            break;
          }
        }
        if (replaced) continue;
      }
      if (subscription.queue.length === 64) {
        subscription.queue.length = 0;
        subscription.queue.push({ type: 'delivery.gap' });
        subscription.gapped = true;
      } else {
        subscription.queue.push(event);
      }
      if (!subscription.delivering) void this.deliver(subscription);
    }
  }

  close(): void {
    for (const subscription of this.subscriptions) this.detach(subscription);
  }

  fail(error: Error): void {
    for (const subscription of [...this.subscriptions]) {
      this.detach(subscription);
      subscription.onFailure(error);
    }
  }

  private detach(subscription: Subscription<Event>): void {
    subscription.active = false;
    subscription.queue.length = 0;
    this.subscriptions.delete(subscription);
  }

  private async deliver(subscription: Subscription<Event>): Promise<void> {
    subscription.delivering = true;
    try {
      while (subscription.active && subscription.queue.length > 0) {
        const event = subscription.queue.shift();
        if (event !== undefined) {
          if (isDeliveryGap(event)) subscription.gapped = false;
          await subscription.listener(event);
        }
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.detach(subscription);
      subscription.onFailure(error);
    } finally {
      subscription.delivering = false;
    }
  }
}

function isDeliveryGap(value: unknown): value is ApplicationDeliveryEvent {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'delivery.gap';
}
