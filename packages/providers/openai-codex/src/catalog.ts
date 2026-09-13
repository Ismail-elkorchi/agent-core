import { parseJsonObject } from '@agent-core/json';
import { parseModelProfile, type ModelCatalogEntry, type ModelProfile } from '@agent-core/model';

export interface CodexCatalogModel extends ModelCatalogEntry {
  readonly profile: ModelProfile;
}

/** Backend capability metadata; instructions and product-specific policies are not imported. */
export function decodeCodexCatalog(value: unknown): readonly CodexCatalogModel[] {
  const payload = parseJsonObject(value);
  if (!Array.isArray(payload.models)) throw new Error('Codex model catalog has no models array.');
  return payload.models.map((value) => {
    const model = parseJsonObject(value);
    if (typeof model.slug !== 'string' || !model.slug || typeof model.display_name !== 'string')
      throw new Error('Codex catalog model identity is invalid.');
    if (!Array.isArray(model.supported_reasoning_levels))
      throw new Error('Codex catalog reasoning levels are missing.');
    const efforts = model.supported_reasoning_levels.map((value) => parseJsonObject(value).effort);
    const profile = parseModelProfile({
      id: model.slug,
      displayName: model.display_name,
      provider: 'openai-codex',
      modalities: { input: model.input_modalities, output: ['text'] },
      limits: model.context_window == null ? {} : { contextTokens: model.context_window },
      capabilities: {
        streaming: true,
        toolCalling: true,
        supportedToolInputs: [{ kind: 'json' }, { kind: 'text' }],
        jsonMode: false,
        jsonSchema: false,
        logprobs: false,
        temperature: false,
        topP: false,
        reasoning: {
          strategies: efforts.length === 0 ? [] : ['effort'],
          canDisable: efforts.includes('none'),
          efforts,
          ...(model.supports_reasoning_summary_parameter === true
            ? { summaries: ['auto', 'concise', 'detailed'] }
            : {}),
          separateOutput: true
        }
      },
      supportedParameters: ['tools', 'reasoning', 'metadata', 'providerOptions'],
      metadata: {
        api: 'codex-responses',
        auth: 'chatgpt-subscription',
        ...(model.default_reasoning_level == null
          ? {}
          : { defaultReasoningEffort: model.default_reasoning_level })
      }
    });
    return {
      id: model.slug,
      displayName: model.display_name,
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      profile
    };
  });
}
