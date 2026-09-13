import type { AgentProgressEvent } from '../events.js';

/** Only complete replacement values may be coalesced; fragments and boundaries retain order. */
export function progressReplacementKey(event: AgentProgressEvent): string | undefined {
  switch (event.type) {
    case 'assistant.delta':
      return `assistant:${event.turnId}:content`;
    case 'assistant.reasoning':
      return `assistant:${event.turnId}:reasoning:${event.channel ?? 'reasoning'}`;
    default:
      return undefined;
  }
}
