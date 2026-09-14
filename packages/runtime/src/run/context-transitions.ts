import { hashJson, type EventRepository } from '@agent-core/persistence';
import type { AgentAuditEvent, AgentEvent } from '../events.js';
import { contextTransitionRequestSchema } from '../context/schema.js';
import type { ContextTransitionRequest } from '../context/contracts.js';
import type { ContextAdmission, ContextService } from '../context/service.js';
import type { SessionContextTransitionEntry } from '../session/contracts.js';

interface PendingTransition {
  readonly requestId: string;
  readonly requested: ContextTransitionRequest;
  admitted?: ContextTransitionRequest;
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
  hasPending(): boolean {
    return this.requests.size > 0;
  }
  async restore(): Promise<void> {
    const through = await this.options.events.tail(this.options.runId);
    let cursor = -1;
    for (;;) {
      const page = await this.options.events.readRange(this.options.runId, {
        afterSequence: cursor,
        through,
        types: [
          'context.transition.requested',
          'context.transition.bound',
          'context.transition.completed',
          'context.transition.rejected'
        ]
      });
      if (page.oversized) throw new Error('Context command record exceeds its persisted bound.');
      for (const record of page.records) {
        const event = record.event;
        if (event.type === 'context.transition.requested')
          this.requests.set(event.requestId, {
            requestId: event.requestId,
            requested: event.request
          });
        if (event.type === 'context.transition.bound')
          this.require(event.requestId).admitted = event.request;
        if (
          event.type === 'context.transition.completed' ||
          event.type === 'context.transition.rejected'
        )
          this.requests.delete(event.requestId);
      }
      if (page.complete) break;
      if (page.nextSequence <= cursor) throw new Error('Context command reader made no progress.');
      cursor = page.nextSequence;
    }
  }
  async schedule(input: ContextTransitionRequest): Promise<{ readonly requestId: string }> {
    const request = contextTransitionRequestSchema.parse(input);
    const requestId = `context-${hashJson(request.idempotencyKey)}`;
    const action = this.writes.then(async () => {
      const recorded = await this.options.events.referenceByKey(
        this.options.runId,
        `${this.options.runId}:${requestId}:requested`
      );
      if (recorded) {
        const event = (await this.options.events.readReference(recorded)).event;
        if (
          event.type !== 'context.transition.requested' ||
          hashJson(event.request) !== hashJson(request)
        )
          throw new Error('Context transition command identity has conflicting content.');
        return;
      }
      const prior = this.requests.get(requestId);
      if (prior) {
        if (hashJson(prior.requested) !== hashJson(request))
          throw new Error('Context transition request identity has conflicting content.');
        return;
      }
      if (this.requests.size >= 1024) throw new Error('Too many pending context transitions.');
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
    readonly validate?: ContextAdmission;
    readonly committed: (entry: SessionContextTransitionEntry) => Promise<void>;
    readonly rejected?: (requestId: string, message: string) => void;
    readonly signal: AbortSignal;
  }): Promise<void> {
    await this.writes;
    for (const pending of this.requests.values()) {
      input.signal.throwIfAborted();
      let entry: SessionContextTransitionEntry;
      try {
        if (!pending.admitted) {
          const request = contextTransitionRequestSchema.parse(
            await input.admit(pending.requested)
          );
          await this.options.append(
            {
              type: 'context.transition.bound',
              requestId: pending.requestId,
              request
            },
            `${this.options.runId}:${pending.requestId}:admitted`
          );
          pending.admitted = request;
        }
        entry = await input.context.transition(pending.admitted, {
          signal: input.signal,
          ...(input.validate ? { admit: input.validate } : {})
        });
      } catch (cause) {
        input.signal.throwIfAborted();
        // A committed session window wins even when its original receipt was lost.
        const known = await input.context.findTransition(pending.requested.idempotencyKey);
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
          this.requests.delete(pending.requestId);
          input.rejected?.(
            pending.requestId,
            cause instanceof Error ? cause.message : String(cause)
          );
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
      this.requests.delete(pending.requestId);
      await input.committed(entry);
    }
  }
  private require(id: string): PendingTransition {
    const item = this.requests.get(id);
    if (!item) throw new Error('Context transition receipt has no original request.');
    return item;
  }
}
