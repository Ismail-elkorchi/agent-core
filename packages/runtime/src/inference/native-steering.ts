import type { ModelProviderSession, ModelSteeringDelivery, ModelStreamEvent } from '@agent-core/model';
import type { AgentAuditEvent, AgentEvent } from '../events.js';
import { hashJson, type EventRepository } from '@agent-core/persistence';
import { parseJsonObject } from '@agent-core/json';

export class SteeringDeliveryUnknownError extends Error {
  constructor(readonly deliveryId: string) {
    super(`Steering ${deliveryId} has no confirmed provider delivery outcome.`);
    this.name = 'SteeringDeliveryUnknownError';
  }
}
interface AcceptedSteering {
  readonly deliveryId: string;
  readonly content: string;
  delivery?: ModelSteeringDelivery;
  localApplied: boolean;
}

/** Input delivery state is independent from the lifetime of the provider response. */
export class NativeSteeringCoordinator {
  private readonly inputs = new Map<string, AcceptedSteering>();
  private session: ModelProviderSession | undefined;
  private responseId: string | undefined;
  private native = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      readonly runId: string;
      readonly events: EventRepository<AgentEvent>;
      readonly append: (event: AgentAuditEvent, key: string) => Promise<unknown>;
    }
  ) {}

  async restore(): Promise<void> {
    for await (const record of this.options.events.read(this.options.runId)) {
      const event = record.event;
      if (event.type === 'input.steering.accepted')
        this.inputs.set(event.deliveryId, {
          deliveryId: event.deliveryId,
          content: event.content,
          localApplied: false
        });
      else if (event.type === 'input.steering.delivery') {
        const input = this.inputs.get(event.delivery.deliveryId);
        if (!input) throw new Error('Steering receipt has no accepted source input.');
        input.delivery = event.delivery;
      } else if (event.type === 'input.steering.local_applied') {
        const input = this.inputs.get(event.deliveryId);
        if (!input) throw new Error('Local steering delivery has no accepted input.');
        input.localApplied = true;
      }
    }
  }

  async accept(deliveryId: string, content: string): Promise<void> {
    if (this.inputs.has(deliveryId)) {
      if (this.inputs.get(deliveryId)?.content !== content)
        throw new Error('Steering input identity changed.');
      return;
    }
    await this.options.append(
      { type: 'input.steering.accepted', deliveryId, content },
      `steering:${deliveryId}:accepted`
    );
    this.inputs.set(deliveryId, { deliveryId, content, localApplied: false });
    if (this.native && this.responseId) this.pending = this.pending.then(() => this.submit(deliveryId));
  }

  bind(session: ModelProviderSession, native: boolean): void {
    if (native && (!session.steer || !session.steeringStatus))
      throw new Error('Native steering requires submission and delivery-reconciliation capabilities.');
    this.session = session;
    this.native = native;
    this.responseId = undefined;
  }

  async observe(event: Exclude<ModelStreamEvent, { type: 'done' }>): Promise<void> {
    if (event.type === 'response_started') {
      this.responseId = event.responseId;
      for (const input of this.inputs.values())
        if (!input.localApplied && !input.delivery)
          this.pending = this.pending.then(() => this.submit(input.deliveryId));
    } else if (event.type === 'steering') await this.record(event.delivery);
  }

  async nextRequestInputs(): Promise<readonly { readonly id: string; readonly content: string }[]> {
    await this.pending;
    const selected: { id: string; content: string }[] = [];
    for (const input of this.inputs.values()) {
      if (input.localApplied || input.delivery?.status === 'applied') continue;
      if (input.delivery && input.delivery.status !== 'failed') await this.reconcile(input);
      if (input.delivery && input.delivery.status !== 'failed') continue;
      await this.options.append(
        { type: 'input.steering.local_applied', deliveryId: input.deliveryId },
        `steering:${input.deliveryId}:local`
      );
      input.localApplied = true;
      selected.push({ id: input.deliveryId, content: input.content });
    }
    return Object.freeze(selected);
  }

  async finishResponse(): Promise<void> {
    await this.pending;
    for (const input of this.inputs.values()) {
      if (input.delivery && !['applied', 'failed'].includes(input.delivery.status))
        await this.reconcile(input);
    }
    this.responseId = undefined;
  }

  private async submit(deliveryId: string): Promise<void> {
    const input = this.inputs.get(deliveryId);
    const session = this.session;
    const responseId = this.responseId;
    if (!input || input.localApplied || input.delivery || !this.native || !responseId || !session?.steer)
      return;
    await this.record({ deliveryId, responseId, status: 'submitted' });
    try {
      await this.record(
        await session.steer({
          deliveryId,
          responseId,
          input: [{ role: 'user', content: input.content }]
        })
      );
    } catch {
      await this.record({
        deliveryId,
        responseId,
        status: 'uncertain',
        detail: 'Native steering submission disconnected before confirmed delivery.'
      });
    }
  }

  private async reconcile(input: AcceptedSteering): Promise<void> {
    if (this.session?.steeringStatus) {
      try {
        await this.record(await this.session.steeringStatus(input.deliveryId));
      } catch {
        /* Absence of provider evidence cannot authorize a second delivery. */
      }
    }
    if (input.delivery?.status !== 'applied' && input.delivery?.status !== 'failed')
      throw new SteeringDeliveryUnknownError(input.deliveryId);
  }

  private async record(delivery: ModelSteeringDelivery): Promise<void> {
    const input = this.inputs.get(delivery.deliveryId);
    if (!input || input.localApplied || (input.delivery && input.delivery.responseId !== delivery.responseId))
      throw new Error('Native steering receipt does not match its original input and response.');
    if (input.delivery?.status === 'applied') {
      if (delivery.status !== 'applied')
        throw new Error('Applied steering cannot revert to unconfirmed delivery.');
      return;
    }
    await this.options.append(
      { type: 'input.steering.delivery', delivery },
      `steering:${delivery.deliveryId}:${hashJson(parseJsonObject(delivery))}`
    );
    input.delivery = Object.freeze({ ...delivery });
  }
}
