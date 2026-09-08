import type {
  ModelNativeDispatch,
  ModelNativeToolCallIdentity,
  ModelToolResultDelivery,
  ModelToolResultInput
} from '@agent-core/model';
import type { AgentRunDriver } from '../run/control/driver.js';
import type { AgentToolTarget } from '../run/control/contracts.js';
import type { ModelWindow } from '../inference/model-window.js';

/** Transmission receipts refer to the original effect; they never grant effect retry authority. */
export class NativeToolDelivery {
  constructor(
    private readonly run: AgentRunDriver,
    private readonly window: ModelWindow
  ) {}

  available(): {
    readonly results: readonly ModelToolResultInput[];
    readonly sourceCalls: readonly ModelNativeToolCallIdentity[];
  } {
    const results: ModelToolResultInput[] = [];
    const sourceCalls: ModelNativeToolCallIdentity[] = [];
    for (const batch of this.run.state().toolBatches) {
      for (const [index, call] of batch.callStates.entries()) {
        if (call.stage !== 'recorded' || (call.delivery && call.delivery.status !== 'failed')) continue;
        const toolCallId = batch.modelCalls[index]?.id;
        const catalogIdentity = batch.source.nativeCatalogIdentity;
        if (!toolCallId || !catalogIdentity)
          throw new Error('Native result lost its original source identity.');
        const result = this.window.toolResult(toolCallId);
        if (!result) throw new Error('A recorded native result has no model presentation.');
        results.push(result);
        sourceCalls.push({ responseId: batch.source.responseId, catalogIdentity, toolCallId });
      }
    }
    return { results, sourceCalls };
  }

  async admit(dispatch: ModelNativeDispatch): Promise<void> {
    for (const source of dispatch.sourceCalls) {
      await this.run.recordToolDelivery(this.target(source), {
        deliveryId: dispatch.deliveryId,
        inputIdentity: dispatch.compiled.inputIdentity,
        targetResponseId: dispatch.responseId,
        status: 'admitted'
      });
    }
  }

  async observe(delivery: ModelToolResultDelivery): Promise<void> {
    for (const source of delivery.sourceCalls) {
      const target = this.target(source);
      const batch = this.run.state().toolBatches.find((batch) => batch.toolBatchId === target.toolBatchId);
      const call = batch?.callStates[target.callIndex];
      if (
        call?.stage !== 'recorded' ||
        call.delivery?.deliveryId !== delivery.deliveryId ||
        call.delivery.inputIdentity !== delivery.inputIdentity ||
        call.delivery.targetResponseId !== delivery.responseId
      ) {
        throw new Error('Native delivery evidence has no matching original admission.');
      }
      await this.run.recordToolDelivery(target, {
        deliveryId: delivery.deliveryId,
        inputIdentity: delivery.inputIdentity,
        targetResponseId: delivery.responseId,
        status: delivery.status,
        ...(delivery.successorResponseId ? { successorResponseId: delivery.successorResponseId } : {})
      });
    }
  }

  private target(source: ModelNativeToolCallIdentity): AgentToolTarget {
    for (const batch of this.run.state().toolBatches) {
      if (
        batch.source.responseId !== source.responseId ||
        batch.source.nativeCatalogIdentity !== source.catalogIdentity
      )
        continue;
      const callIndex = batch.modelCalls.findIndex((call) => call.id === source.toolCallId);
      if (callIndex >= 0) return { kind: 'tool', toolBatchId: batch.toolBatchId, callIndex };
    }
    throw new Error('Native result source does not identify retained tool work.');
  }
}
