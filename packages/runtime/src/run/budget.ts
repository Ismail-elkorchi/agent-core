import type { InferenceUsageTotals } from '../inference/repository.js';
import type { AgentRunDriver } from './control/driver.js';

import type { ToolCall } from '@agent-core/tools';
import {
  systemAgentClock,
  validateAgentRunLimits,
  type AgentClock,
  type AgentLimitKind,
  type AgentRunBudgetState,
  type AgentRunLimits
} from './contracts.js';

export class AgentLimitExceededError extends Error {
  readonly attempted: number;
  readonly maximum: number;
  readonly attemptedDelta: number;
  readonly previousSnapshot: AgentRunBudgetState;
  readonly resultingSnapshot: AgentRunBudgetState;
  readonly consumed: boolean;
  /** The authoritative post-decision snapshot; retained as the concise error context. */
  readonly snapshot: AgentRunBudgetState;
  constructor(
    readonly limit: AgentLimitKind,
    input: {
      readonly attempted: number;
      readonly maximum: number;
      readonly attemptedDelta: number;
      readonly previousSnapshot: AgentRunBudgetState;
      readonly resultingSnapshot: AgentRunBudgetState;
      readonly consumed: boolean;
    }
  ) {
    super(
      `Agent run limit exhausted: ${limit}; attempted=${String(input.attempted)}, maximum=${String(input.maximum)}.`
    );
    this.name = 'AgentLimitExceededError';
    this.attempted = input.attempted;
    this.maximum = input.maximum;
    this.attemptedDelta = input.attemptedDelta;
    this.previousSnapshot = input.previousSnapshot;
    this.resultingSnapshot = input.resultingSnapshot;
    this.consumed = input.consumed;
    this.snapshot = input.resultingSnapshot;
  }
}

export class AgentRunBudget {
  readonly limits: AgentRunLimits;
  private readonly clock: AgentClock;
  private readonly startedAt: number;
  private readonly initialElapsedMs: number;
  private readonly emptyState: Omit<AgentRunBudgetState, 'elapsedMs'> = {
    modelTurns: 0,
    totalToolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    knownCosts: {},
    pricingStatus: 'unknown',
    unknownPricedTokens: 0
  };

  constructor(input: {
    readonly clock?: AgentClock;
    readonly limits?: Partial<AgentRunLimits>;
    readonly run: AgentRunDriver;
  }) {
    this.run = input.run;
    this.limits = validateAgentRunLimits(input.limits);
    this.clock = input.clock ?? systemAgentClock();
    this.startedAt = this.clock.now();
    this.initialElapsedMs = input.run.state().budget?.elapsedMs ?? 0;
  }

  private readonly run: AgentRunDriver;
  private get state(): Omit<AgentRunBudgetState, 'elapsedMs'> {
    return this.run.state().budget ?? this.emptyState;
  }

  reserveModelTurn(): AgentRunBudgetState {
    this.assertElapsed();
    const previous = this.snapshot();
    const total = previous.modelTurns + 1;
    if (this.limits.modelTurns !== undefined && total > this.limits.modelTurns)
      throw this.limitError(
        'model_turns',
        total,
        this.limits.modelTurns,
        1,
        previous,
        { ...previous, modelTurns: total },
        false
      );
    return Object.freeze({ ...previous, modelTurns: total });
  }

  reserveToolCalls(calls: readonly ToolCall[]): AgentRunBudgetState {
    this.assertElapsed();
    const previous = this.snapshot();
    const total = previous.totalToolCalls + calls.length;
    if (this.limits.totalToolCalls !== undefined && total > this.limits.totalToolCalls)
      throw this.limitError(
        'total_tool_calls',
        total,
        this.limits.totalToolCalls,
        calls.length,
        previous,
        { ...previous, totalToolCalls: total },
        false
      );
    return Object.freeze({ ...previous, totalToolCalls: total });
  }

  async recordUsage(totals: InferenceUsageTotals): Promise<void> {
    const previous = this.snapshot();
    const { usage, knownCosts, unknownPricedTokens } = totals;
    const { promptTokens, completionTokens } = usage;
    if (
      promptTokens < previous.promptTokens ||
      completionTokens < previous.completionTokens ||
      unknownPricedTokens < previous.unknownPricedTokens ||
      Object.entries(previous.knownCosts).some(
        ([currency, amount]) => (knownCosts[currency] ?? 0) < amount
      )
    )
      throw new Error(
        'The inference owner is missing previously settled run usage; restore its original repository before continuing.'
      );
    const hasKnown = Object.keys(knownCosts).length > 0;
    const pricingStatus =
      totals.invocations === 0
        ? previous.pricingStatus
        : unknownPricedTokens > 0
          ? hasKnown
            ? 'partial'
            : 'unknown'
          : 'known';
    await this.run.recordBudget(() => ({
      ...this.snapshot(),
      promptTokens,
      completionTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      knownCosts,
      pricingStatus,
      unknownPricedTokens
    }));
    if (this.limits.promptTokens !== undefined && promptTokens > this.limits.promptTokens)
      throw this.limitError(
        'prompt_tokens',
        promptTokens,
        this.limits.promptTokens,
        Math.max(0, promptTokens - previous.promptTokens),
        previous,
        this.snapshot(),
        true
      );
    if (
      this.limits.completionTokens !== undefined &&
      completionTokens > this.limits.completionTokens
    )
      throw this.limitError(
        'completion_tokens',
        completionTokens,
        this.limits.completionTokens,
        Math.max(0, completionTokens - previous.completionTokens),
        previous,
        this.snapshot(),
        true
      );
    const costLimit = this.limits.knownCost;
    const limitedCost = costLimit === undefined ? 0 : (knownCosts[costLimit.currency] ?? 0);
    if (costLimit !== undefined && limitedCost > costLimit.amount)
      throw this.limitError(
        'known_cost',
        limitedCost,
        costLimit.amount,
        Math.max(0, limitedCost - (previous.knownCosts[costLimit.currency] ?? 0)),
        previous,
        this.snapshot(),
        true
      );
  }

  assertElapsed(): void {
    const elapsed = this.elapsedMs();
    if (this.limits.elapsedMs !== undefined && elapsed > this.limits.elapsedMs) {
      const snapshot = this.snapshot();
      throw this.limitError(
        'elapsed_time',
        elapsed,
        this.limits.elapsedMs,
        Math.max(0, elapsed - this.initialElapsedMs),
        snapshot,
        snapshot,
        true
      );
    }
  }

  remainingElapsedMs(): number | undefined {
    this.assertElapsed();
    return this.limits.elapsedMs === undefined
      ? undefined
      : Math.max(0, this.limits.elapsedMs - this.elapsedMs());
  }

  snapshot(): AgentRunBudgetState {
    return Object.freeze({ ...this.state, elapsedMs: this.elapsedMs() });
  }

  private elapsedMs(): number {
    return this.initialElapsedMs + Math.floor(Math.max(0, this.clock.now() - this.startedAt));
  }
  private limitError(
    limit: AgentLimitKind,
    attempted: number,
    maximum: number,
    attemptedDelta: number,
    previousSnapshot: AgentRunBudgetState,
    resultingSnapshot: AgentRunBudgetState,
    consumed: boolean
  ): AgentLimitExceededError {
    return new AgentLimitExceededError(limit, {
      attempted,
      maximum,
      attemptedDelta,
      previousSnapshot,
      resultingSnapshot,
      consumed
    });
  }
}
