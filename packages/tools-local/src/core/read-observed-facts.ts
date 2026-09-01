import { type ObservationAction, type ObservedResource, type ToolResultFacts } from '@agent-core/tools';
import type { ToolScope } from '@agent-core/tools';

/** Build read-tool observedFacts from the same ToolScope persisted on the observation. */
export function builtInObservedFacts(
  action: Extract<ObservationAction, 'list' | 'search' | 'read'>,
  scope: ToolScope,
  summary: string,
  options: { readonly outcome?: 'success' | 'failure'; readonly actuality?: 'observed' | 'predicted' } = {}
): ToolResultFacts {
  return { items: [{
    action,
    resources: scope.resources.map(resourceFromScope),
    scope: {
      ...(scope.filters ? { filters: scope.filters } : {}),
      ...(scope.limits ? { limits: scope.limits } : {}),
      ...(scope.omitted ? { omitted: scope.omitted } : {}),
      coverage: scope.coverage,
      ...(scope.truncated === undefined ? {} : { truncated: scope.truncated }),
      actuality: options.actuality ?? 'observed'
    },
    summary,
    outcome: options.outcome ?? 'success'
  }] };
}

function resourceFromScope(scope: string): ObservedResource {
  if (scope === 'files') return { uri: 'rooted-file:///' };
  if (scope.startsWith('files/')) return { uri: `rooted-file:///${scope.slice('files/'.length)}` };
  if (scope === 'artifacts') return { uri: 'artifact://*' };
  if (scope.startsWith('artifacts/')) return { uri: `artifact://${scope.slice('artifacts/'.length)}` };
  return { uri: `scope://${scope}` };
}
