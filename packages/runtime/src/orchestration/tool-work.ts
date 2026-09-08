import type { AgentApprovalRequest } from '../run/contracts.js';
import type { AgentRunState } from '../run/control/contracts.js';
import { ToolCallExecutor, type ToolCallCompletion } from './tool-execution.js';

export type ToolWorkStatus =
  | { readonly outcome: 'completed' | 'ownership_lost' | 'waiting_for_recovery' }
  | { readonly outcome: 'waiting_for_approval'; readonly approvals: readonly AgentApprovalRequest[] };

/** Drives the same per-call procedures at synchronous and native response boundaries. */
export class ToolWorkPump {
  private readonly active = new Map<string, Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private lostOwnership = false;
  private closed = false;

  constructor(
    private readonly executor: ToolCallExecutor,
    private readonly state: () => AgentRunState,
    private readonly signal: AbortSignal
  ) {}

  /** Start independent work and record available results without waiting for running effects. */
  async advance(): Promise<void> {
    this.queue = this.queue
      .then(() => this.drive())
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error('Tool work failed.', { cause: error });
      });
    await this.queue;
    this.assertAvailable();
  }

  async waitUntil(ready: (state: AgentRunState) => boolean): Promise<ToolWorkStatus> {
    for (;;) {
      await this.advance();
      const state = this.state();
      const approvals = state.toolBatches.flatMap((batch) =>
        batch.callStates.flatMap((call) => (call.stage === 'approval' ? [call.approval] : []))
      );
      if (approvals.length) return { outcome: 'waiting_for_approval', approvals };
      if (this.lostOwnership) return { outcome: 'ownership_lost' };
      if (ready(state)) return { outcome: 'completed' };
      if (!this.active.size) return { outcome: 'waiting_for_recovery' };
      await this.waitForChange();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
    await this.executor.release();
  }

  private async drive(): Promise<void> {
    if (!this.canDrive()) return;
    let progressed: boolean;
    do {
      if (this.closed) return;
      this.signal.throwIfAborted();
      progressed = false;
      for (const batch of this.state().toolBatches) {
        for (const [callIndex, call] of batch.callStates.entries()) {
          if (call.stage === 'recorded' || call.stage === 'cancelled') continue;
          const key = `${batch.toolBatchId}:${String(callIndex)}`;
          if (this.active.has(key)) continue;
          const step = await this.executor.step({ toolBatchId: batch.toolBatchId, callIndex });
          if (step.kind === 'advanced') progressed = true;
          if (step.kind === 'started') {
            this.track(key, step.completion);
            progressed = true;
          }
        }
      }
    } while (progressed);
  }

  private track(key: string, completion: Promise<ToolCallCompletion>): void {
    const settled = completion
      .then((result) => {
        this.lostOwnership ||= result.outcome === 'ownership_lost';
      })
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error('Tool work failed.', { cause: error });
      })
      .finally(() => {
        this.active.delete(key);
        // A completed result becomes observable even while a provider response is streaming.
        if (!this.closed) void this.advance().catch(() => undefined);
      });
    this.active.set(key, settled);
  }

  private async waitForChange(): Promise<void> {
    this.signal.throwIfAborted();
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        reject(
          this.signal.reason instanceof Error
            ? this.signal.reason
            : new Error('Tool work aborted.', { cause: this.signal.reason })
        );
      };
      this.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      await Promise.race([...this.active.values(), cancelled]);
    } finally {
      this.signal.removeEventListener('abort', abort);
    }
  }

  private assertAvailable(): void {
    if (this.failure) throw this.failure;
    this.signal.throwIfAborted();
  }

  private canDrive(): boolean {
    return !this.closed && !this.failure && !this.lostOwnership;
  }
}

export function toolObservationsComplete(state: AgentRunState): boolean {
  return state.toolBatches.every((batch) =>
    batch.callStates.every((call) => call.stage === 'recorded' || call.stage === 'cancelled')
  );
}
