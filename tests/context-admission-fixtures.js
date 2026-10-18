import { hashJson } from '@agent-core/persistence';

// Deterministic service-only admission. Runtime fixtures exercise actual provider compilation.
export function admittedSelection(input, model = { provider: 'fixture', model: 'context' }) {
  return input.strategy === 'fresh' ? {
    ...input.selection,
    continuity: {
      kind: 'fresh', resetId: `fixture-${hashJson({ cut: input.cut, sessionState: input.sessionState })}`,
      model, sources: input.selection.retained, historyPosition: input.cut
    }
  } : input.selection;
}
export async function admitContext(input) {
  return { compiledInputIdentity: 'fixture-input', capabilityRevision: 'fixture', selection: admittedSelection(input) };
}
