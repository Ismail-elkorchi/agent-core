import type {
  ModelProfile,
  ModelProviderInfo,
  ModelProviderState,
  ModelRequest,
  ModelResponse
} from '@agent-core/model';
import type { ToolDefinition, ToolPolicy } from '@agent-core/tools';
import type {
  AgentModelRequestSummary,
  AgentModelResponseSummary,
  AgentProviderStateReference,
  AgentProviderStateSummary,
  AgentRunConfiguration
} from '../events.js';
import type { RequestWindow } from './budget-accountant.js';

export function summarizeRunConfiguration(input: {
  provider: ModelProviderInfo;
  model: ModelProfile;
  tools: readonly ToolDefinition[];
  toolPolicy: ToolPolicy;
  requestWindow: RequestWindow;
  requestedMaxOutputTokens?: number;
  temperature?: number;
  reasoning?: AgentRunConfiguration['runtime']['reasoning'];
  metadata?: Record<string, string>;
}): AgentRunConfiguration {
  return {
    provider: {
      id: input.provider.id,
      displayName: input.provider.displayName
    },
    model: {
      id: input.model.id,
      provider: input.model.provider,
      ...(input.model.displayName ? { displayName: input.model.displayName } : {}),
      limits: {
        ...(input.model.limits.contextTokens === undefined ? {} : { contextTokens: input.model.limits.contextTokens }),
        ...(input.model.limits.maxInputTokens === undefined ? {} : { maxInputTokens: input.model.limits.maxInputTokens }),
        ...(input.model.limits.outputTokens === undefined ? {} : { outputTokens: input.model.limits.outputTokens })
      },
      modalities: { input: [...input.model.modalities.input], output: [...input.model.modalities.output] },
      capabilities: {
        streaming: input.model.capabilities.streaming,
        toolCalling: input.model.capabilities.toolCalling,
        supportedToolInputs: [...input.model.capabilities.supportedToolInputs],
        jsonMode: input.model.capabilities.jsonMode,
        jsonSchema: input.model.capabilities.jsonSchema,
        logprobs: input.model.capabilities.logprobs,
        temperature: input.model.capabilities.temperature,
        topP: input.model.capabilities.topP,
        ...(input.model.capabilities.reasoning === undefined ? {} : { reasoning: {
          strategies: [...input.model.capabilities.reasoning.strategies],
          canDisable: input.model.capabilities.reasoning.canDisable,
          ...(input.model.capabilities.reasoning.efforts === undefined ? {} : { efforts: [...input.model.capabilities.reasoning.efforts] }),
          ...(input.model.capabilities.reasoning.modes === undefined ? {} : { modes: [...input.model.capabilities.reasoning.modes] }),
          ...(input.model.capabilities.reasoning.summaries === undefined ? {} : { summaries: [...input.model.capabilities.reasoning.summaries] }),
          separateOutput: input.model.capabilities.reasoning.separateOutput
        } })
      },
      supportedParameters: [...input.model.supportedParameters]
    },
    tools: input.tools.map((tool) => ({ name: tool.name, accessModes: [...new Set(tool.effectEnvelope.accesses.map((access) => access.mode))].sort() })),
    toolPolicy: input.toolPolicy,
    requestWindow: {
      contextWindowTokens: input.requestWindow.contextWindowTokens,
      maxOutputTokens: input.requestWindow.maxOutputTokens,
      maxPromptTokens: input.requestWindow.maxPromptTokens,
      ...(input.requestedMaxOutputTokens === undefined ? {} : { requestedMaxOutputTokens: input.requestedMaxOutputTokens })
    },
    runtime: {
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
      metadataKeys: Object.keys(input.metadata ?? {}).sort()
    }
  };
}

export function summarizeModelRequest(request: Omit<ModelRequest, 'signal'>): AgentModelRequestSummary {
  const tools = request.tools ?? [];
  return {
    model: request.model,
    messageCount: request.messages.length,
    messageRoleCounts: countMessageRoles(request.messages),
    messageBytes: jsonBytes(request.messages),
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.type === 'function' ? tool.function.name : tool.name),
    toolSchemaBytes: jsonBytes(tools),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
    metadataKeys: Object.keys(request.metadata ?? {}).sort(),
    providerOptionKeys: Object.keys(request.providerOptions?.values ?? {}).sort()
  };
}

export function summarizeModelResponse(
  response: ModelResponse,
  providerState: AgentProviderStateReference | undefined
): AgentModelResponseSummary {
  return {
    provider: response.provider,
    model: response.model,
    contentChars: response.content.length,
    contentBytes: Buffer.byteLength(response.content, 'utf8'),
    toolCallCount: response.toolCalls?.length ?? 0,
    toolCallNames: response.toolCalls?.map((call) => call.name) ?? [],
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    ...(response.transport === undefined ? {} : { transport: response.transport }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    terminationReason: response.terminationReason,
    ...(response.providerTerminationReason === undefined
      ? {}
      : { providerTerminationReason: response.providerTerminationReason }),
    ...(response.reasoningSummary === undefined ? {} : { reasoningSummaryChars: response.reasoningSummary.length }),
    ...(response.raw === undefined ? {} : { rawBytes: jsonBytes(response.raw) }),
    ...(providerState === undefined ? {} : {
      providerState: providerState.summary,
      providerStateRef: providerState.artifact
    })
  };
}

export function summarizeProviderState(state: ModelProviderState): AgentProviderStateSummary {
  return {
    provider: state.provider,
    model: state.model,
    kind: state.kind,
    dataKeys: Object.keys(state.data).sort(),
    bytes: jsonBytes(state)
  };
}

function countMessageRoles(messages: ModelRequest['messages']): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    counts[message.role] = (counts[message.role] ?? 0) + 1;
  }
  return counts;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(value === undefined ? 'undefined' : JSON.stringify(value), 'utf8');
}
