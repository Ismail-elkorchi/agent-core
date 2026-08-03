export type ShellLifecycleState =
  | { readonly state: 'preparing' }
  | { readonly state: 'spawning' }
  | { readonly state: 'running' }
  | { readonly state: 'terminating'; readonly reason: 'abort' | 'timeout' }
  | { readonly state: 'exited'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly state: 'aborted' }
  | { readonly state: 'timed_out' }
  | { readonly state: 'process_failed'; readonly message: string }
  | { readonly state: 'spawn_failed'; readonly message: string }
  | { readonly state: 'cleanup_failed'; readonly message: string; readonly processOutcome: 'exited' | 'aborted' | 'timed_out' | 'process_failed' }
  | { readonly state: 'collecting_output'; readonly outcome: 'exited' | 'aborted' | 'timed_out' | 'process_failed' | 'spawn_failed' | 'cleanup_failed' }
  | { readonly state: 'completed'; readonly outcome: 'exited' | 'aborted' | 'timed_out' | 'process_failed' | 'spawn_failed' | 'cleanup_failed' };

export type ShellLifecycleEvent =
  | { readonly type: 'spawn.requested' }
  | { readonly type: 'spawn.succeeded' }
  | { readonly type: 'spawn.failed'; readonly message: string }
  | { readonly type: 'stop.requested'; readonly reason: 'abort' | 'timeout' }
  | { readonly type: 'process.closed'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: 'process.failed'; readonly message: string }
  | { readonly type: 'cleanup.settled' }
  | { readonly type: 'cleanup.failed'; readonly message: string }
  | { readonly type: 'output.collected' };

export type ShellLifecycleCommand =
  | { readonly type: 'process.spawn' }
  | { readonly type: 'process.stop'; readonly signal: 'SIGTERM' | 'SIGKILL' }
  | { readonly type: 'process.cleanup' }
  | { readonly type: 'output.collect' }
  | { readonly type: 'result.complete'; readonly outcome: Extract<ShellLifecycleState, { state: 'completed' }>['outcome'] };
export interface ShellLifecycleTransition { readonly state: ShellLifecycleState; readonly commands: readonly ShellLifecycleCommand[] }
export class ShellLifecycleTransitionError extends Error { constructor(readonly stateName: ShellLifecycleState['state'], readonly eventType: ShellLifecycleEvent['type']) { super(`Illegal shell lifecycle transition: ${stateName} + ${eventType}.`); this.name = 'ShellLifecycleTransitionError'; } }

export function createShellLifecycle(): ShellLifecycleState { return Object.freeze({ state: 'preparing' }); }
export function reduceShellLifecycle(state: ShellLifecycleState, event: ShellLifecycleEvent): ShellLifecycleTransition {
  switch (state.state) {
    case 'preparing':
      if (event.type === 'spawn.requested') return transition({ state: 'spawning' }, [{ type: 'process.spawn' }]);
      if (event.type === 'stop.requested' && event.reason === 'abort') return collect({ state: 'aborted' });
      break;
    case 'spawning':
      if (event.type === 'spawn.succeeded') return transition({ state: 'running' }, []);
      if (event.type === 'spawn.failed') return collect({ state: 'spawn_failed', message: event.message });
      break;
    case 'running':
      if (event.type === 'stop.requested') return transition({ state: 'terminating', reason: event.reason }, [{ type: 'process.stop', signal: event.reason === 'timeout' ? 'SIGKILL' : 'SIGTERM' }]);
      if (event.type === 'process.closed') return transition({ state: 'exited', exitCode: event.exitCode, signal: event.signal }, [{ type: 'process.cleanup' }]);
      if (event.type === 'process.failed') return transition({ state: 'process_failed', message: event.message }, [{ type: 'process.cleanup' }]);
      break;
    case 'terminating':
      if (event.type === 'process.closed' || event.type === 'process.failed') return transition(state.reason === 'timeout' ? { state: 'timed_out' } : { state: 'aborted' }, [{ type: 'process.cleanup' }]);
      break;
    case 'exited':
    case 'aborted':
    case 'timed_out':
    case 'process_failed':
      if (event.type === 'cleanup.settled') return collect(state);
      if (event.type === 'cleanup.failed') return collect({ state: 'cleanup_failed', message: event.message, processOutcome: state.state });
      break;
    case 'spawn_failed':
    case 'cleanup_failed':
      break;
    case 'collecting_output':
      if (event.type === 'output.collected') return transition({ state: 'completed', outcome: state.outcome }, [{ type: 'result.complete', outcome: state.outcome }]);
      break;
    case 'completed':
      break;
    default:
      return assertNever(state);
  }
  throw new ShellLifecycleTransitionError(state.state, event.type);
}

function collect(state: Extract<ShellLifecycleState, { state: 'exited' | 'aborted' | 'timed_out' | 'process_failed' | 'spawn_failed' | 'cleanup_failed' }>): ShellLifecycleTransition {
  return transition({ state: 'collecting_output', outcome: state.state }, [{ type: 'output.collect' }]);
}
function transition(state: ShellLifecycleState, commands: readonly ShellLifecycleCommand[]): ShellLifecycleTransition { return Object.freeze({ state: Object.freeze(state), commands: Object.freeze([...commands]) }); }
function assertNever(value: never): never { throw new Error(`Unhandled shell lifecycle state: ${JSON.stringify(value)}`); }
