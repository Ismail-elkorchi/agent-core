import { canonicalJsonString } from '@agent-core/evidence';
import type { ModelPricing, ModelUsage } from '@agent-core/model';
import {
  createAgentRunMachine,
  DEFAULT_AGENT_RUN_RETRY_POLICY,
  reduceAgentRun,
  systemAgentClock,
  validateAgentRunLimits,
  type AgentClock,
  type AgentLimitKind,
  type AgentRunBudgetState,
  type AgentRunLimits,
  type AgentRunMachineState,
  type AgentRunPhase,
  type AgentRunRetryPolicy,
  type AgentTerminalSnapshot,
  type AgentToolBatchIdentity,
  type AgentTurnIdentity
} from '../run/contracts.js';
import type { ToolCall } from '@agent-core/tools';

export class AgentLimitExceededError extends Error {
  readonly attempted: number;
  readonly maximum: number;
  readonly attemptedDelta: number;
  readonly previousSnapshot: AgentRunBudgetState;
  readonly resultingSnapshot: AgentRunBudgetState;
  readonly consumed: boolean;
  /** The authoritative post-decision snapshot; retained as the concise error context. */
  readonly snapshot: AgentRunBudgetState;
  constructor(readonly limit: AgentLimitKind, input: { readonly attempted: number; readonly maximum: number; readonly attemptedDelta: number; readonly previousSnapshot: AgentRunBudgetState; readonly resultingSnapshot: AgentRunBudgetState; readonly consumed: boolean }) {
    super(`Agent run limit exhausted: ${limit}; attempted=${String(input.attempted)}, maximum=${String(input.maximum)}.`);
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
  readonly retryPolicy: AgentRunRetryPolicy;
  private readonly clock: AgentClock;
  private readonly startedAt: number;
  private readonly initialElapsedMs: number;
  private readonly callCounts = new Map<string, number>();
  private machine: AgentRunMachineState;
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
    consecutiveToolFailures: 0,
    providerRetries: 0
  };

  constructor(input: {
    readonly runId?: string;
    readonly finalizationId?: string;
    readonly clock?: AgentClock;
    readonly limits?: Partial<AgentRunLimits>;
    readonly retryPolicy?: Partial<AgentRunRetryPolicy>;
    readonly initialBudget?: AgentRunBudgetState;
    readonly initialToolCalls?: readonly ToolCall[];
  } = {}) {
    this.limits = validateAgentRunLimits(input.limits);
    this.retryPolicy = validateRetryPolicy(input.retryPolicy);
    this.clock = input.clock ?? systemAgentClock();
    this.startedAt = this.clock.now();
    if (input.initialBudget) {
      const { elapsedMs, ...rest } = input.initialBudget;
      this.initialElapsedMs = elapsedMs;
      this.state = { ...rest };
      if (input.initialToolCalls) this.restoreToolCallHistory(input.initialToolCalls);
    } else {
      this.initialElapsedMs = 0;
      if (input.initialToolCalls && input.initialToolCalls.length > 0) throw new Error('Initial tool-call history requires an initial budget snapshot.');
    }
    this.machine = createAgentRunMachine({
      runId: input.runId ?? 'unassigned-run',
      finalizationId: input.finalizationId ?? 'unassigned-finalization',
      budget: this.snapshot()
    });
  }

  private restoreToolCallHistory(calls: readonly ToolCall[]): void {
    if (calls.length !== this.state.totalToolCalls) throw new Error(`Recovered tool-call history count ${String(calls.length)} does not match budget total ${String(this.state.totalToolCalls)}.`);
    for (const call of calls) {
      const fingerprint = `${call.name}:${canonicalJsonString(call.input)}`;
      this.callCounts.set(fingerprint, (this.callCounts.get(fingerprint) ?? 0) + 1);
    }
    const recoveredMaximum = Math.max(0, ...this.callCounts.values());
    if (recoveredMaximum !== this.state.repeatedIdenticalToolCalls) throw new Error(`Recovered repeated-call maximum ${String(recoveredMaximum)} does not match budget value ${String(this.state.repeatedIdenticalToolCalls)}.`);
  }

  get phase(): AgentRunPhase { return this.machine.phase; }
  get machineState(): AgentRunMachineState { return this.machine; }

  transition(phase: Exclude<AgentRunPhase, 'preparing' | 'ended'>, identity?: AgentTurnIdentity | AgentToolBatchIdentity): void {
    if (phase === this.machine.phase) return;
    const budget = this.snapshot();
    if (phase === 'requesting_model') {
      const turn = requireTurnIdentity(identity, phase);
      this.machine = reduceAgentRun(this.machine, { type: 'model.request', turnId: turn.turnId, requestAttempt: turn.requestAttempt, budget });
    } else if (phase === 'executing_tools') {
      const batch = requireToolBatchIdentity(identity);
      this.machine = reduceAgentRun(this.machine, { type: 'tools.execute', turnId: batch.turnId, requestAttempt: batch.requestAttempt, toolBatchId: batch.toolBatchId, budget });
    } else if (phase === 'waiting_for_approval') {
      throw new Error('Use waitForApproval() so approval identities are persisted with the transition.');
    } else if (phase === 'verifying') {
      this.machine = reduceAgentRun(this.machine, { type: 'verification.start', budget });
    } else {
      this.machine = reduceAgentRun(this.machine, { type: 'finalization.start', budget });
    }
  }

  waitForApproval(approvalIds: readonly string[]): void {
    this.machine = reduceAgentRun(this.machine, { type: 'approval.wait', approvalIds, budget: this.snapshot() });
  }

  resumeApprovedTools(): void {
    this.machine = reduceAgentRun(this.machine, { type: 'approval.resolved', budget: this.snapshot() });
  }

  commitTerminal(terminal: AgentTerminalSnapshot): void {
    this.machine = reduceAgentRun(this.machine, { type: 'finalization.committed', terminal });
  }

  beginModelTurn(): void {
    this.assertElapsed();
    if (this.state.modelTurns >= this.limits.modelTurns) {
      const previous = this.snapshot();
      throw this.limitError('model_turns', this.state.modelTurns + 1, this.limits.modelTurns, 1, previous, { ...previous, modelTurns: this.state.modelTurns + 1 }, false);
    }
    this.state = { ...this.state, modelTurns: this.state.modelTurns + 1 };
  }

  recordToolCalls(calls: readonly ToolCall[]): void {
    this.assertElapsed();
    const previous = this.snapshot();
    const total = this.state.totalToolCalls + calls.length;
    if (total > this.limits.totalToolCalls) throw this.limitError('total_tool_calls', total, this.limits.totalToolCalls, calls.length, previous, { ...previous, totalToolCalls: total }, false);
    let maximum = this.state.repeatedIdenticalToolCalls;
    const nextCounts = new Map(this.callCounts);
    for (const call of calls) {
      const fingerprint = `${call.name}:${canonicalJsonString(call.input)}`;
      const count = (nextCounts.get(fingerprint) ?? 0) + 1;
      nextCounts.set(fingerprint, count);
      maximum = Math.max(maximum, count);
      if (count > this.limits.repeatedIdenticalToolCalls) throw this.limitError('repeated_tool_calls', count, this.limits.repeatedIdenticalToolCalls, 1, previous, { ...previous, totalToolCalls: total, repeatedIdenticalToolCalls: maximum }, false);
    }
    this.callCounts.clear(); for (const [key, count] of nextCounts) this.callCounts.set(key, count);
    this.state = { ...this.state, totalToolCalls: total, repeatedIdenticalToolCalls: maximum };
  }

  recordUsage(usage: ModelUsage, pricing?: ModelPricing): void {
    const previous = this.snapshot();
    const promptTokens = this.state.promptTokens + usage.promptTokens;
    const completionTokens = this.state.completionTokens + usage.completionTokens;
    const priced = calculateCost(usage, pricing);
    const knownCosts = { ...this.state.knownCosts };
    if (priced.amount !== undefined && priced.currency) knownCosts[priced.currency] = (knownCosts[priced.currency] ?? 0) + priced.amount;
    const unknownPricedTokens = this.state.unknownPricedTokens + priced.unknownTokens;
    const hasKnown = Object.keys(knownCosts).length > 0;
    const pricingStatus = unknownPricedTokens > 0 ? hasKnown ? 'partial' : 'unknown' : 'known';
    this.state = {
      ...this.state, promptTokens, completionTokens,
      cacheReadTokens: this.state.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: this.state.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      reasoningTokens: this.state.reasoningTokens + (usage.reasoningTokens ?? 0),
      knownCosts, pricingStatus, unknownPricedTokens
    };
    if (promptTokens > this.limits.promptTokens) throw this.limitError('prompt_tokens', promptTokens, this.limits.promptTokens, usage.promptTokens, previous, this.snapshot(), true);
    if (completionTokens > this.limits.completionTokens) throw this.limitError('completion_tokens', completionTokens, this.limits.completionTokens, usage.completionTokens, previous, this.snapshot(), true);
    const limitedCost = knownCosts[this.limits.knownCost.currency] ?? 0;
    if (limitedCost > this.limits.knownCost.amount) throw this.limitError('known_cost', limitedCost, this.limits.knownCost.amount, priced.currency === this.limits.knownCost.currency ? priced.amount ?? 0 : 0, previous, this.snapshot(), true);
  }

  recordProviderSuccess(): void { this.state = { ...this.state, consecutiveProviderFailures: 0 }; }
  recordProviderFailure(): void {
    const previous = this.snapshot();
    const failures = this.state.consecutiveProviderFailures + 1;
    this.state = { ...this.state, consecutiveProviderFailures: failures };
    if (failures > this.limits.consecutiveProviderFailures) throw this.limitError('consecutive_provider_failures', failures, this.limits.consecutiveProviderFailures, 1, previous, this.snapshot(), true);
  }
  recordProviderRetry(): void {
    const previous = this.snapshot();
    const retries = this.state.providerRetries + 1;
    this.state = { ...this.state, providerRetries: retries };
    if (retries > this.limits.providerRetries) throw this.limitError('provider_retries', retries, this.limits.providerRetries, 1, previous, this.snapshot(), true);
  }
  recordToolResult(ok: boolean): void {
    const previous = this.snapshot();
    const failures = ok ? 0 : this.state.consecutiveToolFailures + 1;
    this.state = { ...this.state, consecutiveToolFailures: failures };
    if (failures > this.limits.consecutiveToolFailures) throw this.limitError('consecutive_tool_failures', failures, this.limits.consecutiveToolFailures, 1, previous, this.snapshot(), true);
  }

  assertElapsed(): void {
    const elapsed = this.elapsedMs();
    if (elapsed > this.limits.elapsedMs) { const snapshot = this.snapshot(); throw this.limitError('elapsed_time', elapsed, this.limits.elapsedMs, Math.max(0, elapsed - this.initialElapsedMs), snapshot, snapshot, true); }
  }

  remainingElapsedMs(): number {
    this.assertElapsed();
    return Math.max(0, this.limits.elapsedMs - this.elapsedMs());
  }

  elapsedDeadlineError(): AgentLimitExceededError {
    const previous = this.snapshot();
    const attempted = Math.max(this.elapsedMs(), this.limits.elapsedMs + 1);
    const resulting = Object.freeze({ ...previous, elapsedMs: attempted });
    return this.limitError('elapsed_time', attempted, this.limits.elapsedMs, Math.max(1, attempted - previous.elapsedMs), previous, resulting, true);
  }

  snapshot(): AgentRunBudgetState {
    return Object.freeze({ ...this.state, elapsedMs: this.elapsedMs() });
  }

  private elapsedMs(): number { return this.initialElapsedMs + Math.floor(Math.max(0, this.clock.now() - this.startedAt)); }
  private limitError(limit: AgentLimitKind, attempted: number, maximum: number, attemptedDelta: number, previousSnapshot: AgentRunBudgetState, resultingSnapshot: AgentRunBudgetState, consumed: boolean): AgentLimitExceededError {
    return new AgentLimitExceededError(limit, { attempted, maximum, attemptedDelta, previousSnapshot, resultingSnapshot, consumed });
  }
}

function validateRetryPolicy(input: Partial<AgentRunRetryPolicy> | undefined): AgentRunRetryPolicy {
  const policy = { ...DEFAULT_AGENT_RUN_RETRY_POLICY, ...(input ?? {}) };
  if (!Number.isInteger(policy.retriesPerRequest) || policy.retriesPerRequest < 0) throw new Error('retriesPerRequest must be a nonnegative integer.');
  for (const name of ['initialDelayMs', 'maximumDelayMs'] as const) {
    if (!Number.isInteger(policy[name]) || policy[name] < 0) throw new Error(`${name} must be a nonnegative integer.`);
  }
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1) throw new Error('retry multiplier must be finite and at least 1.');
  return Object.freeze(policy);
}

function calculateCost(usage: ModelUsage, pricing: ModelPricing | undefined): { readonly amount?: number; readonly currency?: string; readonly unknownTokens: number } {
  const cacheRead = Math.min(usage.promptTokens, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.min(usage.promptTokens - cacheRead, usage.cacheWriteTokens ?? 0);
  const regularInput = Math.max(0, usage.promptTokens - cacheRead - cacheWrite);
  const tier = pricing?.inputTiers
    ?.filter((candidate) => usage.promptTokens > candidate.aboveInputTokens)
    .sort((left, right) => right.aboveInputTokens - left.aboveInputTokens)[0];
  const inputMultiplier = tier?.inputMultiplier ?? 1;
  const outputMultiplier = tier?.outputMultiplier ?? 1;
  const components = [
    { tokens: regularInput, rate: multiplyRate(pricing?.rates.input, inputMultiplier) },
    { tokens: cacheRead, rate: multiplyRate(pricing?.rates.cacheRead, inputMultiplier) },
    { tokens: cacheWrite, rate: multiplyRate(pricing?.rates.cacheWrite, inputMultiplier) },
    { tokens: usage.completionTokens, rate: multiplyRate(pricing?.rates.output, outputMultiplier) }
  ];
  const unknownTokens = components.reduce((total, component) => total + (component.tokens > 0 && component.rate === undefined ? component.tokens : 0), 0);
  const amount = components.reduce((total, component) => total + (component.rate === undefined ? 0 : component.tokens * component.rate / 1_000_000), 0);
  const hasKnown = components.some((component) => component.tokens > 0 && component.rate !== undefined);
  return { ...(hasKnown ? { amount, currency: pricing?.currency ?? 'USD' } : {}), unknownTokens };
}

function multiplyRate(rate: number | undefined, multiplier: number): number | undefined {
  return rate === undefined ? undefined : rate * multiplier;
}

function requireTurnIdentity(identity: AgentTurnIdentity | AgentToolBatchIdentity | undefined, phase: AgentRunPhase): AgentTurnIdentity {
  if (!identity) throw new Error(`${phase} requires a turn identity.`);
  return identity;
}

function requireToolBatchIdentity(identity: AgentTurnIdentity | AgentToolBatchIdentity | undefined): AgentToolBatchIdentity {
  if (!identity || !('toolBatchId' in identity) || identity.toolBatchId.length === 0) throw new Error('executing_tools requires a tool-batch identity.');
  return identity;
}
