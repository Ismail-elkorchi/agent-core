import * as z from 'zod';

export const searchScopeShape = {
  path: z.string().trim().min(1).default('.').describe(
    'Start directory relative to the workspace root. Set this to the smallest relevant subtree; glob patterns filter matches but do not bound traversal.'
  ),
  patterns: z.array(z.string().trim().min(1)).min(1).describe('Glob patterns relative to path, not the workspace root.'),
  exclude: z.array(z.string().trim().min(1)).default([]).describe('Exclusion globs relative to path.')
};
