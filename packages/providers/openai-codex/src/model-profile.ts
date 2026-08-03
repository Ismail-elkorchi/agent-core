import { type ModelCapabilities, type ModelProfile, ModelProviderError, parseModelProfile } from '@agent-core/model';

import { OPENAI_CODEX_DEFAULT_MODEL, OPENAI_CODEX_PROVIDER_ID } from './constants.js';

export type OpenAICodexModelProfileDefinition = Omit<ModelProfile, 'id' | 'provider'>;

interface OpenAICodexBuiltInProfile {
  displayName?: string;
  capabilities?: Partial<ModelCapabilities>;
  modalities?: Partial<ModelProfile['modalities']>;
  limits?: Partial<ModelProfile['limits']>;
  supportedParameters?: ModelProfile['supportedParameters'];
  pricing?: ModelProfile['pricing'];
  metadata?: Record<string, unknown>;
}

const OPENAI_CODEX_DEFAULT_LIMITS: ModelProfile['limits'] = {
  contextTokens: 1_050_000,
  maxInputTokens: 922_000,
  outputTokens: 128_000
};

const OPENAI_CODEX_MODEL_METADATA = {
  defaultReasoningEffort: 'medium'
} satisfies Record<string, unknown>;

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolCalling: true,
  supportedToolInputs: [{ kind: 'json' }, { kind: 'text' }, { kind: 'grammar', syntax: 'lark' }, { kind: 'grammar', syntax: 'regex' }],
  jsonMode: true,
  jsonSchema: true,
  logprobs: false,
  temperature: false,
  topP: false,
  reasoning: {
    strategies: ['effort'],
    canDisable: false,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    summaries: ['auto', 'concise', 'detailed'],
    separateOutput: true
  }
};

const DEFAULT_SUPPORTED_PARAMETERS: ModelProfile['supportedParameters'] = [
  'responseFormat',
  'tools',
  'reasoning',
  'metadata',
  'providerOptions'
];

export function describeOpenAICodexModel(
  model: string,
  profiles: Record<string, OpenAICodexModelProfileDefinition>
): ModelProfile {
  const selectedModel = model || OPENAI_CODEX_DEFAULT_MODEL;
  const explicit = profiles[selectedModel];
  const builtIn = builtInCodexModel(selectedModel);
  if (explicit) {
    return parseModelProfile({ id: selectedModel, provider: OPENAI_CODEX_PROVIDER_ID, ...explicit });
  }
  if (!builtIn) {
    throw new ModelProviderError({ provider: OPENAI_CODEX_PROVIDER_ID, code: 'model_unavailable', message: `OpenAI Codex model ${selectedModel} has no trusted profile. Supply a complete modelProfiles definition after verifying ChatGPT subscription availability.` });
  }
  const pricing = builtIn.pricing;
  return parseModelProfile({
    id: selectedModel,
    provider: OPENAI_CODEX_PROVIDER_ID,
    displayName: builtIn.displayName ?? selectedModel,
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...(builtIn.capabilities ?? {})
    },
    modalities: {
      input: builtIn.modalities?.input ?? ['text', 'image'],
      output: builtIn.modalities?.output ?? ['text']
    },
    limits: {
      ...OPENAI_CODEX_DEFAULT_LIMITS,
      ...(builtIn.limits ?? {})
    },
    supportedParameters: builtIn.supportedParameters ?? DEFAULT_SUPPORTED_PARAMETERS,
    ...(pricing ? { pricing } : {}),
    metadata: {
      api: 'codex-responses',
      auth: 'chatgpt-subscription',
      ...OPENAI_CODEX_MODEL_METADATA,
      ...(builtIn.metadata ?? {})
    }
  });
}

function builtInCodexModel(model: string): OpenAICodexBuiltInProfile | undefined {
  const identities: Record<string, { displayName: string; tier: string }> = {
    'gpt-5.6': { displayName: 'GPT-5.6 Sol', tier: 'sol' },
    'gpt-5.6-sol': { displayName: 'GPT-5.6 Sol', tier: 'sol' },
    'gpt-5.6-terra': { displayName: 'GPT-5.6 Terra', tier: 'terra' },
    'gpt-5.6-luna': { displayName: 'GPT-5.6 Luna', tier: 'luna' }
  };
  const identity = identities[model];
  return identity ? { displayName: identity.displayName, metadata: { modelTier: identity.tier } } : undefined;
}
