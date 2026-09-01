import { defineTool } from '@agent-core/tools';
import { fileScope } from '../../core/resources.js';
import { rootedFileSelector } from '../../core/rooted-file-selection.js';
import { presentListDirectoryObservation } from '../../core/presenters.js';
import { builtInObservedFacts } from '../../core/read-observed-facts.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import { listDirectoryInputSchema, listDirectoryOutputSchema, type ListDirectoryInput } from './schema.js';

interface CanonicalListDirectoryInput extends ListDirectoryInput { readonly path: string }

export const listDirectoryTool = defineTool({
  name: 'list_directory',
  implementationId: 'agent-core.list-directory.v1',
  description: 'List a rooted directory as a sorted flat collection with explicit coverage.',
  schema: listDirectoryInputSchema,
  outputSchema: listDirectoryOutputSchema,
  presentObservation: presentListDirectoryObservation,
  requirements: { services: ['rootedFileAuthority', 'localToolConfiguration', 'rootedFileSelector'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'files' }], lockScopes: [] },
  canonicalizeInput(input, context): CanonicalListDirectoryInput {
    return {
      ...input,
      path: requireRootedFileAuthority(context).canonicalPath(input.path),
      depth: input.depth
    };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: fileScope(input.path) }], lockScopes: [], recovery: { kind: 'unknown' } };
  },
  async invoke(input, context) {
    const selected = await rootedFileSelector(context).select({
      startPath: input.path,
      patterns: ['**/*'],
      type: 'any',
      respectGitIgnore: input.respectGitIgnore,
      includeHidden: input.includeHidden,
      exclude: input.exclude,
      ...(input.resultLimit === undefined ? {} : { requestedLimit: input.resultLimit }),
      traversalDepth: input.depth,
      includeMetadata: input.includeMetadata,
      ...(context.signal ? { signal: context.signal } : {})
    });
    const output = {
      path: selected.startPath,
      depth: { requested: input.depth, effective: selected.effectiveDepth, hostMaximum: selected.hostMaximumDepth },
      entries: [...selected.entries],
      coverage: selected.coverage,
      causes: [...selected.causes],
      counts: { visited: selected.visitedEntries, returned: selected.returnedEntries, omitted: selected.omittedEntries },
      omitted: { ignoreFiles: selected.omittedIgnoreFiles },
      omissions: [...selected.omissions],
      omissionSamples: [...selected.omissionSamples]
    };
    const scope = {
      resources: [fileScope(output.path)], coverage: output.coverage,
      filters: { requestedDepth: input.depth },
      limits: { effectiveDepth: selected.effectiveDepth, hostMaximumDepth: selected.hostMaximumDepth },
      ...(output.causes.length > 0 ? { causes: output.causes, omitted: {
        entries: { count: output.counts.omitted.count, relation: output.counts.omitted.relation },
        causes: output.omissions.map((item) => ({ cause: item.cause, count: item.count, relation: item.relation }))
      } } : {})
    } as const;
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Listed ${String(output.counts.returned)} entries under ${output.path}${output.coverage === 'partial' ? ' with partial coverage' : ''}.`,
      scope,
      observedFacts: builtInObservedFacts('list', scope, `Listed ${String(output.counts.returned)} directory entries.`),
      output
    };
  }
});
