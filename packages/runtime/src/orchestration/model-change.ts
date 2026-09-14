import { parseJsonObject } from '@agent-core/json';
import { parseModelSelection, type ModelSelection } from '@agent-core/model';

/** A fresh continuation is a user choice, never a model-selection default. */
export interface ModelChangeOptions {
  readonly continuation?: 'fresh';
}

export class ModelContinuationRequiredError extends Error {
  readonly code = 'fresh_continuation_required';
  constructor(reason: string) {
    super(
      `The selected native context is incompatible (${reason}). Choose fresh continuation to use portable original sources in this session, or choose a compatible model.`
    );
    this.name = 'ModelContinuationRequiredError';
  }
}

/** The command envelope is separate from persisted provider/model settings. */
export function parseModelChangeRequest(input: unknown): {
  readonly selection: ModelSelection;
  readonly options: ModelChangeOptions;
} {
  const value = parseJsonObject(input, { maxTotalBytes: 64 * 1024 });
  const { continuation, ...settings } = value;
  if (continuation !== undefined && continuation !== 'fresh')
    throw new TypeError('Model continuation must be fresh when explicitly requested.');
  return Object.freeze({
    selection: parseModelSelection(settings),
    options: Object.freeze(continuation === undefined ? {} : { continuation })
  });
}

/** Carried source representations do not reselect an earlier target model. */
export function recordedModelSelection(
  entries: readonly import('../session/contracts.js').SessionBranchEntry[]
): ModelSelection | undefined {
  let selection: ModelSelection | undefined;
  const resets = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'model_settings')
      selection = {
        provider: entry.provider,
        model: entry.model,
        ...(entry.endpoint === undefined ? {} : { endpoint: entry.endpoint }),
        ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
        ...(entry.temperature === undefined ? {} : { temperature: entry.temperature })
      };
    if (entry.type !== 'context_transition') continue;
    const continuity = entry.window.selection.continuity;
    if (!continuity || resets.has(continuity.resetId)) continue;
    resets.add(continuity.resetId);
    selection = continuity.model;
  }
  return selection;
}
