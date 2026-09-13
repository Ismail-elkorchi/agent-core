import type { TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createProtocolWriter } from '@ismail-elkorchi/terminal-ui/protocol';

export interface AttentionState {
  readonly focused: boolean;
  readonly lastEvent?: string;
}

/** Event identity suppresses duplicate live/durable delivery, never decisions or run execution. */
export function observeAttention(state: AttentionState, event: string, enabled: boolean) {
  return {
    state: { ...state, lastEvent: event },
    notify: enabled && !state.focused && state.lastEvent !== event
  };
}

export async function ringTerminalBell(host: TerminalHost, signal: AbortSignal): Promise<void> {
  const capabilities = await host.getCapabilities({ signal });
  if (capabilities.bell.support !== 'supported' || capabilities.bell.availability !== 'available')
    throw new Error('This terminal does not expose a bell capability.');
  signal.throwIfAborted();
  await createProtocolWriter({
    async write(text) {
      const receipt = await host.write({ text }, { signal });
      if (receipt.status !== 'committed') throw new Error(receipt.diagnostic.message);
    }
  }).bell();
}
