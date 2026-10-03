import type {
  TuiChild,
  TuiScopedResult,
  TuiChildState,
  TuiContext
} from '@ismail-elkorchi/terminal-ui/tui';
import { combineTuiResults } from '@ismail-elkorchi/terminal-ui/tui';

type PanelState<ParentState, State, Kind extends string> = Omit<ParentState, 'overlay'> & {
  readonly overlay:
    | { readonly kind: 'none' }
    | { readonly kind: Kind; readonly state: TuiChildState<State> };
};

/** Graft a child result into an application's ordinary modal state. Outputs remain explicit. */
export function applyPanelResult<ParentState, State, Message, Output, Kind extends string>(
  parent: ParentState,
  kind: Kind,
  result: TuiScopedResult<TuiChildState<State>, Message, Output>,
  close = false
): TuiScopedResult<PanelState<ParentState, State, Kind>, Message, Output> {
  return combineTuiResults<PanelState<ParentState, State, Kind>, Message, Output>(
    { ...parent, overlay: close ? { kind: 'none' } : { kind, state: result.state } },
    result
  );
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
