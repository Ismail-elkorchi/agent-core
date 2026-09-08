import type { ArtifactRef, ArtifactRepository } from '@agent-core/persistence';
import { parseProviderContextState, type ProviderContextState } from '@agent-core/model';
import type { AgentProviderStateReference } from '../events.js';
import { summarizeProviderState } from './event-summaries.js';

export async function storeProviderStateArtifact(input: {
  readonly artifacts: ArtifactRepository;
  readonly turnIndex: number;
  readonly state: ProviderContextState;
}): Promise<AgentProviderStateReference | undefined> {
  const content = new TextEncoder().encode(`${JSON.stringify(input.state)}\n`);
  if (content.byteLength > MAX_PROVIDER_STATE_BYTES) return undefined;
  const artifact = await input.artifacts.storeProtected({
    label: `provider-state-turnIndex-${String(input.turnIndex)}-${input.state.provider}-${input.state.kind}`,
    content,
    mediaType: 'application/json; charset=utf-8',
    description: `provider continuation state for turnIndex ${String(input.turnIndex)}`
  });
  return { summary: summarizeProviderState(input.state), artifact };
}

export async function readProviderStateArtifact(input: {
  readonly artifacts: ArtifactRepository;
  readonly ref: ArtifactRef;
}): Promise<ProviderContextState | undefined> {
  try {
    if (input.ref.size > MAX_PROVIDER_STATE_BYTES) return undefined;
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(await input.artifacts.readVerified(input.ref))
    );
    return parseProviderContextState(parsed);
  } catch {
    return undefined;
  }
}

export const MAX_PROVIDER_STATE_BYTES = 1024 * 1024;
