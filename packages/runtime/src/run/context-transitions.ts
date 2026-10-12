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
  private closed = false;
  constructor(
    private readonly options: {
      readonly runId: string;
      readonly events: EventRepository<AgentEvent>;
      readonly append: (event: AgentAuditEvent, key: string) => Promise<unknown>;
    }
  ) {}
  /** State-only native successors can preview the first queued immutable proposal. */
  async pendingState(): Promise<ContextTransitionRequest | undefined> {
    await this.writes;
    const first = this.requests.values().next().value;
    return first?.requested.preserveSelection && first.requested.workingState ? first.requested : undefined;
  }
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
      if (this.closed) throw new Error('The run has ended; refresh context before applying a selection.');
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
        const terminal = await Promise.all(['completed', 'rejected'].map((status) =>
          this.options.events.referenceByKey(this.options.runId, `${this.options.runId}:${requestId}:${status}`)));
        const rejection = terminal[1];
        if (rejection) {
          const rejected = (await this.options.events.readReference(rejection)).event;
          if (rejected.type !== 'context.transition.rejected')
            throw new Error('Context transition rejection receipt contradicts its command.');
          throw new Error(`Context transition already rejected: ${rejected.message}`);
        }
        if (!terminal.some(Boolean) && !this.requests.has(requestId))
          this.requests.set(requestId, { requestId, requested: event.request });
        return;
      }
      const prior = this.requests.get(requestId);
      if (prior) {
        if (hashJson(prior.requested) !== hashJson(request))
          throw new Error('Context transition request identity has conflicting content.');
        return;
      }
      if (this.requests.size >= 1024) throw new Error('Too many pending context transitions.');
      try {
        await this.options.append(
          { type: 'context.transition.requested', requestId, request },
          `${this.options.runId}:${requestId}:requested`
        );
      } catch (cause) {
        // The durable command is the authority when only the append receipt was lost.
        // Do not turn a known scheduled buffered mutation into an unknown tool effect.
        const receipt = await this.options.events.referenceByKey(
          this.options.runId, `${this.options.runId}:${requestId}:requested`);
        if (!receipt) throw cause;
        const recorded = (await this.options.events.readReference(receipt)).event;
        if (recorded.type !== 'context.transition.requested' || hashJson(recorded.request) !== hashJson(request))
          throw new Error('Context transition command identity has conflicting content.', { cause });
      }
      this.requests.set(requestId, { requestId, requested: request });
    });
    this.writes = action.catch(() => undefined);
    await action;
    return Object.freeze({ requestId });
  }
  async closePending(
    context: ContextService | undefined,
    message: string,
    rejected?: (requestId: string, message: string, idempotencyKey: string) => void | Promise<void>
  ): Promise<void> {
    const action = this.writes.then(async () => {
      this.closed = true;
      for (const pending of this.requests.values()) {
        const committed = await context?.findTransition(pending.requested.idempotencyKey);
        if (committed) {
          await this.complete(pending, committed);
          continue;
        }
        await this.options.append(
          { type: 'context.transition.rejected', requestId: pending.requestId, message },
          `${this.options.runId}:${pending.requestId}:rejected`
        );
        this.requests.delete(pending.requestId);
        await rejected?.(pending.requestId, message, pending.requested.idempotencyKey);
      }
    });
    this.writes = action.catch(() => undefined);
    await action;
  }
  async drain(input: {
    readonly context: ContextService;
    readonly onlyIdempotencyKey?: string;
    readonly admit: (request: ContextTransitionRequest) => Promise<ContextTransitionRequest>;
    readonly validate?: ContextAdmission;
    readonly committed: (entry: SessionContextTransitionEntry) => Promise<void>;
    readonly rejected?: (requestId: string, message: string, idempotencyKey: string) => void | Promise<void>;
    readonly signal: AbortSignal;
    readonly preserveFailure?: (error: unknown) => void;
  }): Promise<void> {
    await this.writes;
    for (const pending of this.requests.values()) {
      if (input.onlyIdempotencyKey && pending.requested.idempotencyKey !== input.onlyIdempotencyKey) continue;
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
        // Resolve publication before cancellation or failure classification: its receipt may be lost.
        const known = await input.context.findTransition(pending.requested.idempotencyKey);
        if (known) entry = known;
        else {
          input.signal.throwIfAborted();
          input.preserveFailure?.(cause);
          await this.options.append(
            {
              type: 'context.transition.rejected',
              requestId: pending.requestId,
              message: cause instanceof Error ? cause.message : String(cause)
            },
            `${this.options.runId}:${pending.requestId}:rejected`
          );
          this.requests.delete(pending.requestId);
          await input.rejected?.(
            pending.requestId,
            cause instanceof Error ? cause.message : String(cause),
            pending.requested.idempotencyKey
          );
          continue;
        }
      }
      await this.complete(pending, entry);
      await input.committed(entry);
    }
  }
  /** Completion delivery is idempotent; session publication remains the authority. */
  private async complete(pending: PendingTransition, entry: SessionContextTransitionEntry): Promise<void> {
    const event = {
      type: 'context.transition.completed' as const,
      requestId: pending.requestId,
      windowId: entry.window.windowId
    };
    const key = `${this.options.runId}:${pending.requestId}:completed`;
    try {
      await this.options.append(event, key);
    } catch (cause) {
      const reference = await this.options.events.referenceByKey(this.options.runId, key);
      if (reference) {
        const recorded = (await this.options.events.readReference(reference)).event;
        if (hashJson(recorded) !== hashJson(event))
          throw new Error('Context completion receipt conflicts with its committed publication.', { cause });
      } else {
        // One bounded retry covers a failed prewrite without risking duplicate completion.
        await this.options.append(event, key);
      }
    }
    this.requests.delete(pending.requestId);
  }
  private require(id: string): PendingTransition {
    const item = this.requests.get(id);
    if (!item) throw new Error('Context transition receipt has no original request.');
    return item;
  }
}
