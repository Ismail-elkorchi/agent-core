import { type EvidenceAction, type EvidenceResource, type ToolEvidenceDelta } from '@agent-core/evidence';
import type { ToolScope } from '@agent-core/tools';

/** Build read-tool evidence from the same ToolScope persisted on the observation. */
export function builtInReadEvidence(
  action: Extract<EvidenceAction, 'list' | 'search' | 'read'>,
  scope: ToolScope,
  summary: string,
  options: { readonly outcome?: 'success' | 'failure'; readonly confidence?: 'verified' | 'unverified' } = {}
): ToolEvidenceDelta {
  return { items: [{
    action,
    resources: scope.resources.map(resourceFromScope),
    scope: {
      ...(scope.filters ? { filters: scope.filters } : {}),
      ...(scope.limits ? { limits: scope.limits } : {}),
      ...(scope.omitted ? { omitted: scope.omitted } : {}),
      coverage: scope.coverage,
      ...(scope.truncated === undefined ? {} : { truncated: scope.truncated }),
      confidence: options.confidence ?? 'verified'
    },
    summary,
    outcome: options.outcome ?? 'success'
  }] };
}

function resourceFromScope(scope: string): EvidenceResource {
  if (scope === 'files') return { uri: 'rooted-file:///' };
  if (scope.startsWith('files/')) return { uri: `rooted-file:///${scope.slice('files/'.length)}` };
  if (scope === 'artifacts') return { uri: 'artifact://*' };
  if (scope.startsWith('artifacts/')) return { uri: `artifact://${scope.slice('artifacts/'.length)}` };
  return { uri: `scope://${scope}` };
}
