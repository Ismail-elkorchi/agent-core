import type { ModelSelection } from '@agent-core/model';

/** Native state needs a fresh source-backed request admitted by the runtime. */
export class NativeContextIncompatibilityError extends Error {
  constructor(readonly reason: string) {
    super(`Selected native context is incompatible: ${reason}.`);
    this.name = 'NativeContextIncompatibilityError';
  }
}

/** Only explicit model settings select a connection; continuation snapshots record execution. */
export function recordedModelSelection(
  entries: readonly import('../session/contracts.js').SessionBranchEntry[]
): ModelSelection | undefined {
  let selection: ModelSelection | undefined;
  for (const entry of entries) {
    if (entry.type === 'model_settings')
      selection = {
        provider: entry.provider,
        model: entry.model,
        ...(entry.endpoint === undefined ? {} : { endpoint: entry.endpoint }),
        ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
        ...(entry.temperature === undefined ? {} : { temperature: entry.temperature })
      };
  }
  return selection;
}
