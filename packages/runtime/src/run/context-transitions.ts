import { hashJson, type EventRepository } from '@agent-core/persistence';
import { parseJsonObject } from '@agent-core/json';
import type { AgentAuditEvent, AgentEvent } from '../events.js';
import { contextTransitionRequestSchema } from '../context/schema.js';
import type { ContextTransitionRequest } from '../context/contracts.js';
import type { ContextService } from '../context/service.js';
import type { SessionContextTransitionEntry } from '../session/contracts.js';

interface PendingTransition {
  readonly requestId: string;
  readonly requested: ContextTransitionRequest;
  admitted?: ContextTransitionRequest;
  completed?: boolean;
}
/** Legal-boundary delivery over the owning run ledger, with the session as commit authority. */
export class RunContextTransitions {
  private readonly requests = new Map<string, PendingTransition>();
  private writes: Promise<void> = Promise.resolve();
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
      if (event.type === 'context.transition.requested')
        this.requests.set(event.requestId, {
          requestId: event.requestId,
          requested: event.request
        });
      if (event.type === 'context.transition.admitted') {
        const prior = this.require(event.requestId);
        prior.admitted = event.request;
      }
      if (event.type === 'context.transition.completed' || event.type === 'context.transition.rejected')
        this.require(event.requestId).completed = true;
    }
  }
  async schedule(input: ContextTransitionRequest): Promise<{ readonly requestId: string }> {
    const request = contextTransitionRequestSchema.parse(input);
    const requestId = `context-${hashJson(request.idempotencyKey)}`;
    const action = this.writes.then(async () => {
      const prior = this.requests.get(requestId);
      if (prior) {
        if (hashJson(parseJsonObject(prior.requested)) !== hashJson(parseJsonObject(request)))
          throw new Error('Context transition request identity has conflicting content.');
        return;
      }
      if ([...this.requests.values()].filter((item) => !item.completed).length >= 1024)
        throw new Error('Too many pending context transitions.');
      await this.options.append(
        { type: 'context.transition.requested', requestId, request },
        `${this.options.runId}:${requestId}:requested`
      );
      this.requests.set(requestId, { requestId, requested: request });
    });
    this.writes = action.catch(() => undefined);
    await action;
    return Object.freeze({ requestId });
  }
  async drain(input: {
    readonly context: ContextService;
    readonly admit: (request: ContextTransitionRequest) => Promise<ContextTransitionRequest>;
    readonly committed: (entry: SessionContextTransitionEntry) => Promise<void>;
    readonly signal: AbortSignal;
  }): Promise<void> {
    await this.writes;
    for (const pending of this.requests.values()) {
      if (pending.completed) continue;
      input.signal.throwIfAborted();
      if (!pending.admitted) {
        const request = contextTransitionRequestSchema.parse(await input.admit(pending.requested));
        await this.options.append(
          {
            type: 'context.transition.admitted',
            requestId: pending.requestId,
            request
          },
          `${this.options.runId}:${pending.requestId}:admitted`
        );
        pending.admitted = request;
      }
      let entry: SessionContextTransitionEntry;
      try {
        entry = await input.context.transition(pending.admitted, {
          signal: input.signal
        });
      } catch (cause) {
        input.signal.throwIfAborted();
        // A committed session window wins even when its original receipt was lost.
        const known = (await input.context.history.view()).entries.find(
          (item): item is SessionContextTransitionEntry =>
            item.type === 'context_transition' &&
            item.transition.idempotencyKey === pending.admitted?.idempotencyKey
        );
        if (known) entry = known;
        else {
          await this.options.append(
            {
              type: 'context.transition.rejected',
              requestId: pending.requestId,
              message: cause instanceof Error ? cause.message : String(cause)
            },
            `${this.options.runId}:${pending.requestId}:rejected`
          );
          pending.completed = true;
          continue;
        }
      }
      await this.options.append(
        {
          type: 'context.transition.completed',
          requestId: pending.requestId,
          windowId: entry.window.windowId
        },
        `${this.options.runId}:${pending.requestId}:completed`
      );
      pending.completed = true;
      await input.committed(entry);
    }
  }
  private require(id: string): PendingTransition {
    const item = this.requests.get(id);
    if (!item) throw new Error('Context transition receipt has no original request.');
    return item;
  }
}
