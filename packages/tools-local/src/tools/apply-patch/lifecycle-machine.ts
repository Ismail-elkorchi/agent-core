export type PatchLifecycleState =
  | { readonly state: 'parsing' }
  | { readonly state: 'preflighting' }
  | { readonly state: 'preparing_changes' }
  | { readonly state: 'committing' }
  | { readonly state: 'completed'; readonly committed: boolean }
  | { readonly state: 'failed'; readonly stage: 'parsing' | 'preflighting' | 'commit'; readonly message: string; readonly recovery?: 'succeeded' | 'failed' | 'uncertain' };
export type PatchLifecycleEvent =
  | { readonly type: 'parse.succeeded' }
  | { readonly type: 'parse.failed'; readonly message: string }
  | { readonly type: 'preflight.succeeded' }
  | { readonly type: 'preflight.failed'; readonly message: string }
  | { readonly type: 'changes.prepared'; readonly requiresCommit: boolean }
  | { readonly type: 'commit.succeeded' }
  | { readonly type: 'commit.failed'; readonly message: string; readonly recovery: 'succeeded' | 'failed' | 'uncertain' };
export type PatchLifecycleCommand = { readonly type: 'preflight.run' } | { readonly type: 'changes.prepare' } | { readonly type: 'transaction.commit' } | { readonly type: 'result.complete'; readonly committed: boolean } | { readonly type: 'failure.persist'; readonly message: string; readonly recovery?: 'succeeded' | 'failed' | 'uncertain' };
export interface PatchLifecycleTransition { readonly state: PatchLifecycleState; readonly commands: readonly PatchLifecycleCommand[] }
export class PatchLifecycleTransitionError extends Error { constructor(readonly stateName: PatchLifecycleState['state'], readonly eventType: PatchLifecycleEvent['type']) { super(`Illegal patch lifecycle transition: ${stateName} + ${eventType}.`); this.name = 'PatchLifecycleTransitionError'; } }
export function createPatchLifecycle(): PatchLifecycleState { return Object.freeze({ state: 'parsing' }); }
export function reducePatchLifecycle(state: PatchLifecycleState, event: PatchLifecycleEvent): PatchLifecycleTransition {
  switch (state.state) {
    case 'parsing':
      if (event.type === 'parse.succeeded') return transition({ state: 'preflighting' }, [{ type: 'preflight.run' }]);
      if (event.type === 'parse.failed') return failed('parsing', event.message);
      break;
    case 'preflighting':
      if (event.type === 'preflight.succeeded') return transition({ state: 'preparing_changes' }, [{ type: 'changes.prepare' }]);
      if (event.type === 'preflight.failed') return failed('preflighting', event.message);
      break;
    case 'preparing_changes':
      if (event.type === 'changes.prepared') return event.requiresCommit
        ? transition({ state: 'committing' }, [{ type: 'transaction.commit' }])
        : transition({ state: 'completed', committed: false }, [{ type: 'result.complete', committed: false }]);
      break;
    case 'committing':
      if (event.type === 'commit.succeeded') return transition({ state: 'completed', committed: true }, [{ type: 'result.complete', committed: true }]);
      if (event.type === 'commit.failed') return failed('commit', event.message, event.recovery);
      break;
    case 'completed':
    case 'failed':
      break;
    default:
      return assertNever(state);
  }
  throw new PatchLifecycleTransitionError(state.state, event.type);
}
function failed(stage: Extract<PatchLifecycleState, { state: 'failed' }>['stage'], message: string, recovery?: 'succeeded' | 'failed' | 'uncertain'): PatchLifecycleTransition { return transition({ state: 'failed', stage, message, ...(recovery ? { recovery } : {}) }, [{ type: 'failure.persist', message, ...(recovery ? { recovery } : {}) }]); }
function transition(state: PatchLifecycleState, commands: readonly PatchLifecycleCommand[]): PatchLifecycleTransition { return Object.freeze({ state: Object.freeze(state), commands: Object.freeze([...commands]) }); }
function assertNever(value: never): never { throw new Error(`Unhandled patch lifecycle state: ${JSON.stringify(value)}`); }
