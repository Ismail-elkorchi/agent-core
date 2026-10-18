import type { ArtifactRepository } from '@agent-core/persistence';
import type { ToolAuthorizationDecision, ToolAuthorizationRequest } from '@agent-core/tools';

/** Applications grant public artifact access separately from session bookkeeping authority. */
export async function authorizeSessionToolEffects(
  request: ToolAuthorizationRequest,
  authority: {
    readonly sessionId: string;
    readonly branchId: string;
    readonly artifacts: ArtifactRepository;
    readonly allowArtifactRead: boolean;
  }
): Promise<ToolAuthorizationDecision> {
  const internal = (scope: string, writable: boolean) =>
    (writable ? ['context', 'session_state'] : ['context', 'session_state', 'history'])
      .some(root => {
        const base = `${root}/${encodeURIComponent(authority.sessionId)}/${encodeURIComponent(authority.branchId)}`;
        return scope === base || scope.startsWith(`${base}/`);
      });
  for (const access of request.effects.accesses) {
    if ((access.mode === 'read' || access.mode === 'write') && internal(access.scope, access.mode === 'write')) continue;
    if (access.mode !== 'read' || !access.scope.startsWith('artifacts/') || !authority.allowArtifactRead)
      return { decision: 'deny', reason: 'The session tool requested an effect outside its granted session and artifact authority.' };
    const artifactId = access.scope.slice('artifacts/'.length);
    if (!artifactId || artifactId.includes('/') || (await authority.artifacts.resolve(artifactId))?.visibility !== 'public')
      return { decision: 'deny', reason: 'The requested artifact is not a public artifact in this execution host.' };
  }
  if (request.effects.lockScopes.some(scope => !internal(scope, true)))
    return { decision: 'deny', reason: 'The session tool requested a lock outside its session authority.' };
  return { decision: 'allow', reason: 'Exact session effects and public artifact reads are within the host grants.' };
}
