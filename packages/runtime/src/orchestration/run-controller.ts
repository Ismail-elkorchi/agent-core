import { canonicalJsonString } from '@agent-core/json';
import { calculateInferenceCost } from '../inference/usage-cost.js';

import type { ModelPricing, ModelUsage } from '@agent-core/model';
import type { ToolCall } from '@agent-core/tools';
import {
  systemAgentClock,
  validateAgentRunLimits,
  type AgentClock,
  type AgentLimitKind,
  type AgentRunBudgetState,
  type AgentRunLimits,
  type AgentRunPhase
} from '../run/contracts.js';

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

export class AgentRunController {
  readonly limits: AgentRunLimits;
  private readonly clock: AgentClock;
  private readonly startedAt: number;
  private readonly initialElapsedMs: number;
  private readonly callCounts = new Map<string, number>();
  private currentPhase: AgentRunPhase = 'initializing';
  private state: Omit<AgentRunBudgetState, 'elapsedMs'> = {
    modelTurns: 0,
    totalToolCalls: 0,
    repeatedIdenticalToolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    knownCosts: {},
    pricingStatus: 'unknown',
    unknownPricedTokens: 0,
    consecutiveProviderFailures: 0,
    consecutiveToolFailures: 0
  };

  constructor(
    input: {
      readonly clock?: AgentClock;
      readonly limits?: Partial<AgentRunLimits>;
      readonly initialBudget?: AgentRunBudgetState;
      readonly initialToolCalls?: readonly ToolCall[];
    } = {}
  ) {
    this.limits = validateAgentRunLimits(input.limits);
    this.clock = input.clock ?? systemAgentClock();
    this.startedAt = this.clock.now();
    if (input.initialBudget) {
      const { elapsedMs, ...rest } = input.initialBudget;
      this.initialElapsedMs = elapsedMs;
      this.state = { ...rest };
      if (input.initialToolCalls) this.restoreToolCallHistory(input.initialToolCalls);
    } else {
      this.initialElapsedMs = 0;
      if (input.initialToolCalls && input.initialToolCalls.length > 0)
        throw new Error('Initial tool-call history requires an initial budget snapshot.');
    }
  }

  private restoreToolCallHistory(calls: readonly ToolCall[]): void {
    if (calls.length !== this.state.totalToolCalls)
      throw new Error(
        `Recovered tool-call history count ${String(calls.length)} does not match budget total ${String(this.state.totalToolCalls)}.`
      );
    for (const call of calls) {
      const fingerprint = `${call.name}:${canonicalJsonString(call.input)}`;
      this.callCounts.set(fingerprint, (this.callCounts.get(fingerprint) ?? 0) + 1);
    }
    const recoveredMaximum = Math.max(0, ...this.callCounts.values());
    if (recoveredMaximum !== this.state.repeatedIdenticalToolCalls)
      throw new Error(
        `Recovered repeated-call maximum ${String(recoveredMaximum)} does not match budget value ${String(this.state.repeatedIdenticalToolCalls)}.`
      );
  }

  get phase(): AgentRunPhase {
    return this.currentPhase;
  }

  transition(phase: Exclude<AgentRunPhase, 'initializing' | 'waiting_for_approval' | 'ended'>): void {
    this.setPhase(phase);
  }

  waitForApproval(): void {
    this.setPhase('waiting_for_approval');
  }

  resumeApprovedTools(): void {
    this.setPhase('executing_tools');
  }

  commitTerminal(): void {
    this.setPhase('ended');
  }

  private setPhase(next: AgentRunPhase): void {
    const previous = this.currentPhase;
    if (previous === next) return;
    const allowed =
      (previous === 'initializing' && (next === 'requesting_model' || next === 'finalizing')) ||
      (previous === 'requesting_model' && (next === 'executing_tools' || next === 'finalizing')) ||
      (previous === 'executing_tools' &&
        (next === 'waiting_for_approval' || next === 'requesting_model' || next === 'finalizing')) ||
      (previous === 'waiting_for_approval' && (next === 'executing_tools' || next === 'finalizing')) ||
      (previous === 'finalizing' && next === 'ended');
    if (!allowed) throw new Error(`Illegal run transition: ${previous} -> ${next}.`);
    this.currentPhase = next;
  }

  beginModelTurn(): void {
    this.assertElapsed();
    if (this.state.modelTurns >= this.limits.modelTurns) {
      const previous = this.snapshot();
      throw this.limitError(
        'model_turns',
        this.state.modelTurns + 1,
        this.limits.modelTurns,
        1,
        previous,
        { ...previous, modelTurns: this.state.modelTurns + 1 },
        false
      );
    }
    this.state = { ...this.state, modelTurns: this.state.modelTurns + 1 };
  }

  recordToolCalls(calls: readonly ToolCall[]): void {
    this.assertElapsed();
    const previous = this.snapshot();
    const total = this.state.totalToolCalls + calls.length;
    if (total > this.limits.totalToolCalls)
      throw this.limitError(
        'total_tool_calls',
        total,
        this.limits.totalToolCalls,
        calls.length,
        previous,
        { ...previous, totalToolCalls: total },
        false
      );
    let maximum = this.state.repeatedIdenticalToolCalls;
    const nextCounts = new Map(this.callCounts);
    for (const call of calls) {
      const fingerprint = `${call.name}:${canonicalJsonString(call.input)}`;
      const count = (nextCounts.get(fingerprint) ?? 0) + 1;
      nextCounts.set(fingerprint, count);
      maximum = Math.max(maximum, count);
      if (count > this.limits.repeatedIdenticalToolCalls)
        throw this.limitError(
          'repeated_tool_calls',
          count,
          this.limits.repeatedIdenticalToolCalls,
          1,
          previous,
          {
            ...previous,
            totalToolCalls: total,
            repeatedIdenticalToolCalls: maximum
          },
          false
        );
    }
    this.callCounts.clear();
    for (const [key, count] of nextCounts) this.callCounts.set(key, count);
    this.state = {
      ...this.state,
      totalToolCalls: total,
      repeatedIdenticalToolCalls: maximum
    };
  }

  recordUsage(usage: ModelUsage, pricing?: ModelPricing): void {
    const previous = this.snapshot();
    const promptTokens = this.state.promptTokens + usage.promptTokens;
    const completionTokens = this.state.completionTokens + usage.completionTokens;
    const priced = calculateInferenceCost(usage, pricing);
    const knownCosts = { ...this.state.knownCosts };
    if (priced.amount !== undefined && priced.currency)
      knownCosts[priced.currency] = (knownCosts[priced.currency] ?? 0) + priced.amount;
    const unknownPricedTokens = this.state.unknownPricedTokens + priced.unknownTokens;
    const hasKnown = Object.keys(knownCosts).length > 0;
    const pricingStatus = unknownPricedTokens > 0 ? (hasKnown ? 'partial' : 'unknown') : 'known';
    this.state = {
      ...this.state,
      promptTokens,
      completionTokens,
      cacheReadTokens: this.state.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: this.state.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      reasoningTokens: this.state.reasoningTokens + (usage.reasoningTokens ?? 0),
      knownCosts,
      pricingStatus,
      unknownPricedTokens
    };
    if (promptTokens > this.limits.promptTokens)
      throw this.limitError(
        'prompt_tokens',
        promptTokens,
        this.limits.promptTokens,
        usage.promptTokens,
        previous,
        this.snapshot(),
        true
      );
    if (completionTokens > this.limits.completionTokens)
      throw this.limitError(
        'completion_tokens',
        completionTokens,
        this.limits.completionTokens,
        usage.completionTokens,
        previous,
        this.snapshot(),
        true
      );
    const limitedCost = knownCosts[this.limits.knownCost.currency] ?? 0;
    if (limitedCost > this.limits.knownCost.amount)
      throw this.limitError(
        'known_cost',
        limitedCost,
        this.limits.knownCost.amount,
        priced.currency === this.limits.knownCost.currency ? (priced.amount ?? 0) : 0,
        previous,
        this.snapshot(),
        true
      );
  }

  recordProviderSuccess(): void {
    this.state = { ...this.state, consecutiveProviderFailures: 0 };
  }
  recordProviderFailure(): void {
    const previous = this.snapshot();
    const failures = this.state.consecutiveProviderFailures + 1;
    this.state = { ...this.state, consecutiveProviderFailures: failures };
    if (failures > this.limits.consecutiveProviderFailures)
      throw this.limitError(
        'consecutive_provider_failures',
        failures,
        this.limits.consecutiveProviderFailures,
        1,
        previous,
        this.snapshot(),
        true
      );
  }
  recordToolResult(ok: boolean): void {
    const previous = this.snapshot();
    const failures = ok ? 0 : this.state.consecutiveToolFailures + 1;
    this.state = { ...this.state, consecutiveToolFailures: failures };
    if (failures > this.limits.consecutiveToolFailures)
      throw this.limitError(
        'consecutive_tool_failures',
        failures,
        this.limits.consecutiveToolFailures,
        1,
        previous,
        this.snapshot(),
        true
      );
  }

  assertElapsed(): void {
    const elapsed = this.elapsedMs();
    if (elapsed > this.limits.elapsedMs) {
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

  remainingElapsedMs(): number {
    this.assertElapsed();
    return Math.max(0, this.limits.elapsedMs - this.elapsedMs());
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
