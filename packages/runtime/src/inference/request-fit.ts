import {
  SimpleTokenEstimator,
  type ModelProfile,
  type ModelRequest,
  type TokenEstimator
} from '@agent-core/model';
import { requestWindowForModel } from '../orchestration/model-request.js';

export interface ModelRequestFit {
  readonly messageTokens: number;
  readonly toolTokens: number;
  readonly responseFormatTokens: number;
  readonly promptTokens: number;
  readonly outputReserveTokens: number;
  readonly maxPromptTokens: number;
  readonly contextWindowTokens: number;
}

export class ModelRequestFitError extends Error {
  readonly fit: ModelRequestFit;

  constructor(message: string, fit: ModelRequestFit) {
    super(message);
    this.name = 'ModelRequestFitError';
    this.fit = fit;
  }
}

export function estimateModelRequestFit(
  request: ModelRequest,
  profile: ModelProfile,
  estimator: TokenEstimator = new SimpleTokenEstimator()
): ModelRequestFit {
  if (request.model !== profile.id) throw new Error(`Logical request model ${request.model} does not match model profile ${profile.id}.`);
  if (request.maxOutputTokens !== undefined && profile.limits.outputTokens !== undefined && request.maxOutputTokens > profile.limits.outputTokens) {
    throw new Error(`Logical request asks for ${String(request.maxOutputTokens)} output tokens, above model ${profile.id}'s ${String(profile.limits.outputTokens)} token output limit.`);
  }
  const window = requestWindowForModel(profile, request.maxOutputTokens);
  const messageTokens = estimator.estimateMessages(request.messages);
  const toolTokens = request.tools === undefined || request.tools.length === 0
    ? 0
    : estimator.estimateText(JSON.stringify(request.tools));
  const responseFormatTokens = request.responseFormat === undefined || typeof request.responseFormat === 'string'
    ? 0
    : estimator.estimateText(JSON.stringify(request.responseFormat));
  return Object.freeze({
    messageTokens,
    toolTokens,
    responseFormatTokens,
    promptTokens: messageTokens + toolTokens + responseFormatTokens,
    outputReserveTokens: window.maxOutputTokens,
    maxPromptTokens: window.maxPromptTokens,
    contextWindowTokens: window.contextWindowTokens
  });
}

export function assertModelRequestFitsProfile(
  request: ModelRequest,
  profile: ModelProfile,
  estimator: TokenEstimator = new SimpleTokenEstimator()
): ModelRequestFit {
  const fit = estimateModelRequestFit(request, profile, estimator);
  if (fit.promptTokens > fit.maxPromptTokens || fit.promptTokens + fit.outputReserveTokens > fit.contextWindowTokens) {
    throw new ModelRequestFitError(
      `Logical model request does not fit ${profile.provider}/${profile.id}: prompt=${String(fit.promptTokens)}, maxPrompt=${String(fit.maxPromptTokens)}, outputReserve=${String(fit.outputReserveTokens)}, context=${String(fit.contextWindowTokens)}.`,
      fit
    );
  }
  return fit;
}
