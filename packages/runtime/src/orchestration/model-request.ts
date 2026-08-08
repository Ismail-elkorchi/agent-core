import { type PromptInstructionBlock } from '../context/manager.js';
import { type PromptInstruction } from '../context/prompt.js';
import {
  type ModelProfile,
  type ModelParameter,
  ModelProviderError,
  type ModelProviderErrorDiagnostic,
  type ModelReasoningRequest,
  type ModelResponse,
  type ModelTool,
  type ModelToolCall,
  type TokenEstimator,
  assertModelReasoningSupported
} from '@agent-core/model';
import { type ToolCall, type ToolDefinition, type ToolExecutionContext } from '@agent-core/tools';
import { type RequestWindow } from './budget-accountant.js';

export interface AgentInstructionInput {
  id: string;
  content: string;
  role?: PromptInstruction['role'];
  sourceUri?: string;
  priority?: number;
}

export function normalizeModelToolCall(toolCall: ModelToolCall): ToolCall {
  const call: ToolCall = {
    name: toolCall.name,
    input: toolCall.input
  };
  if (toolCall.id) {
    call.id = toolCall.id;
  }
  return call;
}

export function modelToolCallFromToolCall(toolCall: ToolCall): ModelToolCall {
  if (toolCall.input.kind === 'text') {
    return {
      ...(toolCall.id ? { id: toolCall.id } : {}),
      type: 'custom',
      name: toolCall.name,
      input: toolCall.input
    };
  }
  return {
    ...(toolCall.id ? { id: toolCall.id } : {}),
    type: 'function',
    name: toolCall.name,
    input: toolCall.input
  };
}

export function toolsForModel(tools: ToolDefinition[], modelProfile: ModelProfile): ModelTool[] {
  return tools.map((tool) => modelToolForDefinition(tool, modelProfile));
}

export function modelToolForDefinition(tool: ToolDefinition, modelProfile: ModelProfile): ModelTool {
  const supportedInputs = modelProfile.capabilities.supportedToolInputs;
  const textInput = tool.textInput;
  if (textInput?.format.type === 'grammar' && supportsGrammar(textInput.format.syntax, supportedInputs)) {
    return {
      type: 'custom',
      name: tool.name,
      description: textInput.description ?? tool.description,
      format: textInput.format
    };
  }
  if (tool.textInput && supportedInputs.some((input) => input.kind === 'text')) {
    return {
      type: 'custom',
      name: tool.name,
      description: tool.textInput.description ?? tool.description,
      format: { type: 'text' }
    };
  }
  if (supportedInputs.some((input) => input.kind === 'json')) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema
      }
    };
  }
  throw new Error(`Model ${modelProfile.id} cannot represent tool ${tool.name}: it supports neither the tool's text presentation nor JSON input.`);
}

function supportsGrammar(syntax: string, inputs: ModelProfile['capabilities']['supportedToolInputs']): boolean {
  return inputs.some((input) => input.kind === 'grammar' && input.syntax === syntax);
}

export function promptToolSpecs(
  tools: ToolDefinition[],
  modelProfile: ModelProfile,
  toolContext?: Omit<ToolExecutionContext, 'policy' | 'signal'>
): { name: string; description: string; accessModes: string[]; inputFormat: string; promptGuide?: string }[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: promptDescriptionForTool(tool, modelProfile),
    inputFormat: promptInputFormatForTool(tool, modelProfile),
    accessModes: [...new Set(tool.effectEnvelope.accesses.map((access) => access.mode))].sort(),
    ...promptGuideForTool(tool, modelProfile, toolContext)
  }));
}

export function validateModelRun(
  providerId: string,
  modelProfile: ModelProfile,
  tools: ToolDefinition[],
  temperature: number | undefined,
  reasoning: ModelReasoningRequest | undefined
): void {
  if (modelProfile.provider !== providerId) {
    throw new Error(`Provider ${providerId} returned a model profile for provider ${modelProfile.provider}.`);
  }
  if (!modelProfile.capabilities.toolCalling && tools.length > 0) {
    throw new Error(`Model ${modelProfile.id} on provider ${providerId} does not support native tool calling.`);
  }
  if (temperature !== undefined && !modelProfile.capabilities.temperature) {
    throw new Error(`Model ${modelProfile.id} on provider ${providerId} does not support temperature.`);
  }
  assertModelReasoningSupported(modelProfile, reasoning);
}

export function requestWindowForModel(modelProfile: ModelProfile, requestedOutputTokens: number | undefined): RequestWindow {
  const contextWindowTokens = modelProfile.limits.contextTokens;
  if (contextWindowTokens === undefined) {
    throw new Error(`Model ${modelProfile.id} on provider ${modelProfile.provider} did not describe limits.contextTokens.`);
  }
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 2) {
    throw new Error(`Model ${modelProfile.id} on provider ${modelProfile.provider} returned an invalid context token limit.`);
  }
  const modelOutputTokens = modelProfile.limits.outputTokens ?? Math.max(1, Math.floor(contextWindowTokens * 0.25));
  if (!Number.isInteger(modelOutputTokens) || modelOutputTokens < 1) {
    throw new Error(`Model ${modelProfile.id} on provider ${modelProfile.provider} returned an invalid output token limit.`);
  }
  const maxOutputTokens = requestedOutputTokens === undefined
    ? Math.min(modelOutputTokens, Math.max(1, contextWindowTokens - 1))
    : Math.min(requestedOutputTokens, modelOutputTokens, Math.max(1, contextWindowTokens - 1));
  const contextPromptTokens = Math.max(1, contextWindowTokens - maxOutputTokens);
  const maxPromptTokens = modelProfile.limits.maxInputTokens === undefined
    ? contextPromptTokens
    : Math.min(contextPromptTokens, modelProfile.limits.maxInputTokens);
  return {
    contextWindowTokens,
    maxOutputTokens,
    maxPromptTokens
  };
}

export function promptInstructionsForRequest(input: {
  runInstructions: string[];
  configuredInstructions: AgentInstructionInput[];
}): PromptInstructionBlock[] {
  return [
    ...input.configuredInstructions.map((instruction, index): PromptInstructionBlock => ({
      id: instruction.id || `instruction-${String(index + 1)}`,
      role: instruction.role ?? 'developer',
      priority: instruction.priority ?? 900,
      content: instruction.content,
      ...(instruction.sourceUri ? { sourceUri: instruction.sourceUri } : {})
    })),
    ...input.runInstructions.map((content, index): PromptInstructionBlock => ({ id: `user-${String(index + 1)}`, role: 'user', priority: 950, content }))
  ];
}

export function estimatePromptScaffoldTokens(estimator: TokenEstimator, input: {
  task: string;
  runNotes: string[];
  runInstructions: string[];
  configuredInstructions: AgentInstructionInput[];
  tools: ToolDefinition[];
  modelProfile: ModelProfile;
  toolContext?: Omit<ToolExecutionContext, 'policy' | 'signal'>;
}): number {
  const text = [
    input.task,
    ...promptInstructionsForRequest({
      runInstructions: input.runInstructions,
      configuredInstructions: input.configuredInstructions
    }).map((instruction) => instruction.content),
    ...input.runNotes.slice(-8),
    ...promptToolSpecs(input.tools, input.modelProfile, input.toolContext).map((tool) => `${tool.name} ${tool.inputFormat} ${tool.accessModes.join(',')} ${tool.description} ${tool.promptGuide ?? ''}`)
  ].join('\n\n');
  return estimator.estimateText(text);
}

export function validateOptionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer when provided.`);
  }
  return value;
}

export function normalizeStreamedFinalResponse(response: ModelResponse, streamedContent: string, streamedReasoningSummary: string): ModelResponse {
  const normalized: ModelResponse = { ...response };
  if (normalized.content.length === 0 && streamedContent.length > 0) {
    normalized.content = streamedContent;
  }
  if (!normalized.reasoningSummary && streamedReasoningSummary.length > 0) {
    normalized.reasoningSummary = streamedReasoningSummary;
  }
  return normalized;
}

export function providerFailureDiagnostic(error: unknown): ModelProviderErrorDiagnostic | undefined {
  return error instanceof ModelProviderError ? error.diagnostic : undefined;
}

export function supportsParameter(modelProfile: ModelProfile, parameter: ModelParameter): boolean {
  return modelProfile.supportedParameters.includes(parameter);
}

export function finalMessageFromResponse(response: ModelResponse): string {
  const content = response.content.trim();
  if (content.length > 0) {
    return content;
  }
  return response.reasoningSummary?.trim() ?? '';
}

function promptDescriptionForTool(tool: ToolDefinition, modelProfile: ModelProfile): string {
  const selected = modelToolForDefinition(tool, modelProfile);
  if (selected.type === 'custom') {
    return tool.textInput?.description ?? tool.description;
  }
  return tool.description;
}

function promptInputFormatForTool(tool: ToolDefinition, modelProfile: ModelProfile): string {
  const selected = modelToolForDefinition(tool, modelProfile);
  if (selected.type === 'custom') {
    return selected.format.type === 'grammar' ? `freeform grammar:${selected.format.syntax}` : 'freeform text';
  }
  return 'json function';
}

function promptGuideForTool(
  tool: ToolDefinition,
  modelProfile: ModelProfile,
  toolContext: Omit<ToolExecutionContext, 'policy' | 'signal'> | undefined
): { promptGuide?: string } {
  const selected = modelToolForDefinition(tool, modelProfile);
  const inputFormat = promptInputFormatForTool(tool, modelProfile);
  if (selected.type === 'custom' && tool.textInput?.promptGuide) {
    return promptGuideResult(tool.textInput.promptGuide, inputFormat, toolContext);
  }
  if (tool.promptGuide) {
    return promptGuideResult(tool.promptGuide, inputFormat, toolContext);
  }
  return {};
}

function promptGuideResult(
  guide: NonNullable<ToolDefinition['promptGuide']>,
  inputFormat: string,
  toolContext: Omit<ToolExecutionContext, 'policy' | 'signal'> | undefined
): { promptGuide?: string } {
  const promptGuide = typeof guide === 'function'
    ? guide({
      inputFormat,
      ...(toolContext?.services ? { services: toolContext.services } : {}),
      ...(toolContext?.metadata ? { metadata: toolContext.metadata } : {})
    })
    : guide;
  return promptGuide && promptGuide.trim().length > 0 ? { promptGuide } : {};
}
