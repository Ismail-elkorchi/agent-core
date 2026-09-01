import { defineTool } from '@agent-core/tools';
import { fileScope } from '../../core/resources.js';
import { rootedFileSelector } from '../../core/rooted-file-selection.js';
import { presentFindFilesObservation } from '../../core/presenters.js';
import { builtInObservedFacts } from '../../core/read-observed-facts.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import { findFilesInputSchema, findFilesOutputSchema, type FindFilesInput } from './schema.js';

interface CanonicalFindFilesInput extends FindFilesInput { readonly path: string }

export const findFilesTool = defineTool({
  name: 'find_files',
  implementationId: 'agent-core.find-files.v1',
  description: 'Find rooted files or directories using the common glob and ignore semantics.',
  schema: findFilesInputSchema,
  outputSchema: findFilesOutputSchema,
  presentObservation: presentFindFilesObservation,
  requirements: { services: ['rootedFileAuthority', 'rootedFileSelector'] },
  effectEnvelope: { accesses: [{ mode: 'read', scope: 'files' }], lockScopes: [] },
  canonicalizeInput(input, context): CanonicalFindFilesInput {
    return { ...input, path: requireRootedFileAuthority(context).canonicalPath(input.path) };
  },
  deriveEffects(input) {
    return { accesses: [{ mode: 'read', scope: fileScope(input.path) }], lockScopes: [], recovery: { kind: 'unknown' } };
  },
  async invoke(input, context) {
    const selected = await rootedFileSelector(context).select({
      startPath: input.path,
      patterns: input.patterns,
      type: input.type,
      respectGitIgnore: input.respectGitIgnore,
      includeHidden: input.includeHidden,
      exclude: input.exclude,
      ...(input.resultLimit === undefined ? {} : { requestedLimit: input.resultLimit }),
      ...(context.signal ? { signal: context.signal } : {})
    });
    const output = {
      path: selected.startPath,
      hostMaximumDepth: selected.hostMaximumDepth,
      patterns: [...input.patterns],
      entries: selected.entries.map(({ path, type }) => ({ path, type })),
      coverage: selected.coverage,
      causes: [...selected.causes],
      counts: { visited: selected.visitedEntries, returned: selected.returnedEntries, omitted: selected.omittedEntries },
      omitted: { ignoreFiles: selected.omittedIgnoreFiles },
      omissions: [...selected.omissions],
      omissionSamples: [...selected.omissionSamples]
    };
    const scope = {
      resources: [fileScope(output.path)], coverage: output.coverage,
      filters: { patterns: input.patterns, exclude: input.exclude, type: input.type }, limits: { hostMaximumDepth: selected.hostMaximumDepth },
      ...(output.causes.length > 0 ? { causes: output.causes, omitted: {
        entries: { count: output.counts.omitted.count, relation: output.counts.omitted.relation },
        causes: output.omissions.map((item) => ({ cause: item.cause, count: item.count, relation: item.relation }))
      } } : {})
    } as const;
    return {
      kind: 'result' as const,
      ok: true,
      summary: `Found ${String(output.counts.returned)} paths under ${output.path}${output.coverage === 'partial' ? ' with partial coverage' : ''}.`,
      scope,
      observedFacts: builtInObservedFacts('search', scope, `Found ${String(output.counts.returned)} matching paths.`),
      output
    };
  }
});
