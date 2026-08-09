import * as z from 'zod';

export const findFilesInputSchema = z.strictObject({
  patterns: z.array(z.string().trim().min(1)).min(1).meta({ description: 'One or more workspace glob patterns.' }),
  path: z.string().trim().min(1).default('.').meta({ description: 'Workspace-relative start directory.' }),
  type: z.enum(['file', 'directory', 'any']).default('file'),
  respectGitIgnore: z.boolean().default(true),
  includeHidden: z.boolean().default(false),
  exclude: z.array(z.string().trim().min(1)).default([]),
  resultLimit: z.int().min(1).optional().meta({ description: 'Optional smaller result limit.' })
});

export const findFilesOutputSchema = z.strictObject({
  path: z.string(),
  patterns: z.array(z.string()),
  entries: z.array(z.strictObject({ path: z.string(), type: z.enum(['file', 'directory', 'symlink', 'other']) })),
  coverage: z.enum(['complete', 'partial']),
  causes: z.array(z.string()),
  counts: z.strictObject({ visited: z.int().nonnegative(), returned: z.int().nonnegative(), omitted: z.int().nonnegative() }),
  omitted: z.strictObject({ ignoreFiles: z.int().nonnegative() }),
  omissionSamples: z.array(z.strictObject({
    path: z.string(),
    reason: z.enum(['hidden', 'gitignored', 'excluded', 'unreadable', 'limit']),
    message: z.string().optional()
  }))
});

export type FindFilesInput = z.output<typeof findFilesInputSchema>;
