import type {
  TuiChild,
  TuiChildResult,
  TuiChildState,
  TuiContext,
  TuiUpdateResult
} from '@ismail-elkorchi/terminal-ui/tui';

type PanelState<ParentState, State, Kind extends string> = Omit<ParentState, 'overlay'> & {
  readonly overlay:
    | { readonly kind: 'none' }
    | { readonly kind: Kind; readonly state: TuiChildState<State> };
};

/** Graft a child result into an application's ordinary modal state. Outputs remain explicit. */
export function applyPanelResult<ParentState, State, Message, Output, Kind extends string>(
  parent: ParentState,
  kind: Kind,
  result: TuiChildResult<TuiChildState<State>, Message, Output>,
  close = false
): TuiChildResult<PanelState<ParentState, State, Kind>, Message, Output> {
  return {
    ...result,
    state: {
      ...parent,
      overlay: close ? { kind: 'none' as const } : { kind, state: result.state }
    }
  };
}

/** Allocate a new lifetime in the parent, without retaining a second store or registry. */
export function mountPanel<
  ParentState extends { readonly panelGeneration: number },
  State,
  Message,
  ParentMessage,
  Output,
  Kind extends string
>(
  parent: ParentState,
  kind: Kind,
  child: TuiChild<State, Message, ParentMessage, Output>,
  context: TuiContext
) {
  const generation = parent.panelGeneration + 1;
  const next: Omit<ParentState, 'panelGeneration'> & { readonly panelGeneration: number } = {
    ...parent,
    panelGeneration: generation
  };
  return applyPanelResult(next, kind, child.init({ id: kind, generation }, context));
}

/** Cancel removed lifetimes; a retained but hidden child continues to own its work. */
export function cancelRemovedPanels<State, Message>(
  result: TuiUpdateResult<State, Message>,
  previous: readonly TuiChildState<unknown>[],
  current: readonly TuiChildState<unknown>[]
): TuiUpdateResult<State, Message> {
  const removed = previous.filter(
    (child) => !current.some((next) => child.id === next.id && child.generation === next.generation)
  );
  return removed.length === 0
    ? result
    : {
        ...result,
        cancelEffects: [
          ...(result.cancelEffects ?? []),
          ...removed.flatMap((child) => child.effectIds)
        ]
      };
}
