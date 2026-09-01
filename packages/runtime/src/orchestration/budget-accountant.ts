import {
  type ModelMessage,
  type ModelTool,
  type ModelUsage,
  type TokenEstimator
} from '@agent-core/model';

export type BudgetPressure = 'normal' | 'constrained' | 'critical' | 'exhausted';

export interface RequestCostEstimate {
  messageTokens: number;
  modelWindowTokens: number;
  contextTokens: number;
  observedFactTokens: number;
  toolSchemaTokens: number;
  outputReserveTokens: number;
  totalPromptTokens: number;
  totalRequestTokens: number;
  readonly warnings: readonly string[];
}

export interface RequestWindow {
  contextWindowTokens: number;
  maxPromptTokens: number;
  maxOutputTokens: number;
}

export interface ProviderUsageReport {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  source: 'provider';
}

export interface BudgetAccountantSnapshot {
  estimatedPromptTokens: number;
  providerPromptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  remainingPromptTokens: number;
  pressure: BudgetPressure;
  lastEstimate?: RequestCostEstimate;
  lastProviderUsage?: ProviderUsageReport;
  estimateToActualRatio?: number;
}

export class BudgetAccountant {
  private estimatedPromptTokens = 0;
  private providerPromptTokens = 0;
  private completionTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private reasoningTokens = 0;
  private pendingPromptEstimate: RequestCostEstimate | undefined;
  private lastEstimate: RequestCostEstimate | undefined;
  private lastProviderUsage: ProviderUsageReport | undefined;
  private ratios: number[] = [];

  constructor(
    private readonly window: RequestWindow,
    private readonly estimator: TokenEstimator
  ) {}

  estimateRequest(input: {
    promptMessages: ModelMessage[];
    modelWindowTokens: number;
    contextTokens: number;
    observedFactTokens?: number;
    tools: ModelTool[];
    outputReserveTokens?: number;
  }): RequestCostEstimate {
    const messageTokens = this.estimator.estimateMessages(input.promptMessages);
    const modelWindowTokens = input.modelWindowTokens;
    const contextTokens = input.contextTokens;
    const observedFactTokens = input.observedFactTokens ?? 0;
    const toolSchemaTokens = estimateToolSchemaTokens(input.tools, this.estimator);
    const outputReserveTokens = input.outputReserveTokens ?? this.window.maxOutputTokens;
    // promptMessages is the final assembled window, including retained history,
    // context, and observed facts. Component counts below are diagnostics only.
    const totalPromptTokens = messageTokens + toolSchemaTokens;
    const totalRequestTokens = totalPromptTokens + outputReserveTokens;
    const warnings: string[] = [];
    if (toolSchemaTokens > Math.floor(this.window.maxPromptTokens * 0.2)) {
      warnings.push('Tool schema tokens are a large share of this request.');
    }
    return {
      messageTokens,
      modelWindowTokens,
      contextTokens,
      observedFactTokens,
      toolSchemaTokens,
      outputReserveTokens,
      totalPromptTokens,
      totalRequestTokens,
      warnings
    };
  }

  canSend(estimate: RequestCostEstimate): boolean {
    return estimate.totalPromptTokens <= this.window.maxPromptTokens
      && estimate.totalRequestTokens <= this.window.contextWindowTokens;
  }

  pressureAfter(estimate: RequestCostEstimate): BudgetPressure {
    return pressureFor({
      promptUsed: estimate.totalPromptTokens,
      promptMax: this.window.maxPromptTokens
    });
  }

  recordSent(estimate: RequestCostEstimate): BudgetAccountantSnapshot {
    this.pendingPromptEstimate = estimate;
    this.lastEstimate = estimate;
    return this.snapshot();
  }

  recordProviderUsage(usage: ModelUsage): BudgetAccountantSnapshot {
    const report: ProviderUsageReport = {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      source: 'provider'
    };
    if (this.pendingPromptEstimate) {
      this.ratios.push(usage.promptTokens / Math.max(1, this.pendingPromptEstimate.totalPromptTokens));
      this.pendingPromptEstimate = undefined;
    }
    this.providerPromptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.reasoningTokens += usage.reasoningTokens ?? 0;
    this.lastProviderUsage = report;
    return this.snapshot();
  }

  recordEstimatedResponse(completionTokens: number): BudgetAccountantSnapshot {
    if (this.pendingPromptEstimate) {
      this.estimatedPromptTokens += this.pendingPromptEstimate.totalPromptTokens;
      this.pendingPromptEstimate = undefined;
    }
    this.completionTokens += completionTokens;
    return this.snapshot();
  }

  snapshot(): BudgetAccountantSnapshot {
    const pendingPromptTokens = this.pendingPromptEstimate?.totalPromptTokens ?? 0;
    const totalTokens = this.providerPromptTokens + this.estimatedPromptTokens + pendingPromptTokens + this.completionTokens;
    const promptTokens = this.providerPromptTokens + this.estimatedPromptTokens + pendingPromptTokens;
    const remainingPromptTokens = Math.max(0, this.window.maxPromptTokens - (this.lastEstimate?.totalPromptTokens ?? 0));
    return {
      estimatedPromptTokens: this.estimatedPromptTokens + pendingPromptTokens,
      providerPromptTokens: this.providerPromptTokens,
      completionTokens: this.completionTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      reasoningTokens: this.reasoningTokens,
      totalTokens,
      remainingPromptTokens,
      pressure: pressureFor({
        promptUsed: this.lastEstimate?.totalPromptTokens ?? promptTokens,
        promptMax: this.window.maxPromptTokens
      }),
      ...(this.lastEstimate ? { lastEstimate: this.lastEstimate } : {}),
      ...(this.lastProviderUsage ? { lastProviderUsage: this.lastProviderUsage } : {}),
      ...(this.ratios.length > 0 ? { estimateToActualRatio: this.ratios[this.ratios.length - 1] ?? 1 } : {})
    };
  }
}

function estimateToolSchemaTokens(tools: ModelTool[], estimator: TokenEstimator): number {
  if (tools.length === 0) {
    return 0;
  }
  return estimator.estimateText(JSON.stringify(tools));
}

function pressureFor(input: {
  promptUsed: number;
  promptMax: number;
}): BudgetPressure {
  const promptRatio = input.promptUsed / Math.max(1, input.promptMax);
  if (promptRatio >= 1) {
    return 'exhausted';
  }
  if (promptRatio >= 0.86) {
    return 'critical';
  }
  if (promptRatio >= 0.72) {
    return 'constrained';
  }
  return 'normal';
}
