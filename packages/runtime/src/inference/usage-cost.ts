import type { ModelPricing, ModelUsage } from '@agent-core/model';
export interface InferenceCost {
  readonly status: 'known' | 'partial' | 'unknown';
  readonly amount?: number;
  readonly currency?: string;
  readonly unknownTokens: number;
}
export function calculateInferenceCost(usage: ModelUsage, pricing: ModelPricing | undefined): InferenceCost {
  const cacheRead = Math.min(usage.promptTokens, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.min(usage.promptTokens - cacheRead, usage.cacheWriteTokens ?? 0);
  const regularInput = Math.max(0, usage.promptTokens - cacheRead - cacheWrite);
  const tier = pricing?.inputTiers
    ?.filter((modelOutput) => usage.promptTokens > modelOutput.aboveInputTokens)
    .sort((left, right) => right.aboveInputTokens - left.aboveInputTokens)[0];
  const inputMultiplier = tier?.inputMultiplier ?? 1;
  const outputMultiplier = tier?.outputMultiplier ?? 1;
  const components = [
    {
      tokens: regularInput,
      rate: multiplyRate(pricing?.rates.input, inputMultiplier)
    },
    {
      tokens: cacheRead,
      rate: multiplyRate(pricing?.rates.cacheRead, inputMultiplier)
    },
    {
      tokens: cacheWrite,
      rate: multiplyRate(pricing?.rates.cacheWrite, inputMultiplier)
    },
    {
      tokens: usage.completionTokens,
      rate: multiplyRate(pricing?.rates.output, outputMultiplier)
    }
  ];
  const unknownTokens = components.reduce(
    (total, component) =>
      total + (component.tokens > 0 && component.rate === undefined ? component.tokens : 0),
    0
  );
  const amount = components.reduce(
    (total, component) =>
      total + (component.rate === undefined ? 0 : (component.tokens * component.rate) / 1_000_000),
    0
  );
  const hasKnown = components.some((component) => component.tokens > 0 && component.rate !== undefined);
  return Object.freeze({
    status: unknownTokens > 0 ? (hasKnown ? 'partial' : 'unknown') : 'known',
    ...(hasKnown && pricing ? { amount, currency: pricing.currency } : {}),
    unknownTokens
  });
}

function multiplyRate(rate: number | undefined, multiplier: number): number | undefined {
  return rate === undefined ? undefined : rate * multiplier;
}
