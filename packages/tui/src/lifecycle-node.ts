import { createTerminalHost, type TerminalHost } from '@ismail-elkorchi/terminal-ui/host';

/** Retires producers and application resources before disposing an owned terminal host. */
export async function runTerminalApplication<Result>(options: {
  readonly host?: TerminalHost;
  readonly run: (host: TerminalHost) => Promise<Result>;
  readonly cleanup: readonly (() => void | Promise<void>)[];
}): Promise<Result> {
  const host = options.host ?? createTerminalHost({ runtime: 'node' });
  let outcome:
    | { readonly kind: 'returned'; readonly value: Result }
    | { readonly kind: 'failed'; readonly cause: unknown };
  try {
    outcome = { kind: 'returned', value: await options.run(host) };
  } catch (cause) {
    outcome = { kind: 'failed', cause };
  }
  const failures: unknown[] = [];
  for (const close of [...options.cleanup, ...(options.host === undefined ? [() => host.dispose()] : [])]) {
    try {
      await close();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (outcome.kind === 'failed') {
    if (failures.length === 0) throw outcome.cause;
    throw new AggregateError([outcome.cause, ...failures], 'Terminal application and cleanup failed.', {
      cause: outcome.cause
    });
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Terminal application cleanup failed.');
  return outcome.value;
}
