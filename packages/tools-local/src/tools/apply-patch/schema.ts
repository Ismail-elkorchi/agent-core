import * as z from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const applyPatchInputSchema = z.strictObject({
  patch: z.string().min(1).meta({
    description: 'Single patch document. First call shape: {"patch":"*** Begin Patch\\n*** Update File: relative/path.txt\\n@@\\n-old\\n+new\\n*** End Patch"}. Supports Add File, Update File, Delete File, and Move to operations.'
  }),
  dryRun: z.boolean().default(false).meta({
    description: 'Validate and compute resulting hashes/counts without writing files. Defaults to false.'
  }),
  expectedOldSha256: z.record(z.string().trim().min(1), sha256Schema).optional().meta({
    description: 'Optional preconditions keyed by patch source path. For update, delete, and move operations, the current source file SHA-256 must match when a key is provided.'
  })
});

export type ApplyPatchArguments = z.input<typeof applyPatchInputSchema>;
export type ApplyPatchInput = z.output<typeof applyPatchInputSchema>;

export type ApplyPatchFailureReason =
  | 'not_found'
  | 'not_file'
  | 'binary'
  | 'too_large'
  | 'symlink'
  | 'path_outside_workspace'
  | 'duplicate_path'
  | 'sha256_mismatch'
  | 'patch_parse_error'
  | 'context_not_found'
  | 'ambiguous_context'
  | 'result_too_large'
  | 'already_exists'
  | 'destination_exists'
  | 'parent_missing'
  | 'parent_not_directory'
  | 'parent_symlink'
  | 'write_failed';

export interface ApplyPatchFailure {
  path: string;
  reason: ApplyPatchFailureReason;
  message: string;
  operation?: ApplyPatchOperation;
  hunkIndex?: number;
  header?: string;
  failingLine?: string;
  oldPreview?: string;
  matchCount?: number;
  candidateLines?: number[];
  possiblyAlreadyApplied?: boolean;
  nextAction?: string;
}

export type ApplyPatchOperation = 'add' | 'update' | 'delete' | 'move';

export type PatchMatchMode =
  | 'exact'
  | 'trim_trailing_whitespace'
  | 'trim_surrounding_whitespace'
  | 'normalize_common_unicode_punctuation';

export interface ApplyPatchPathPair {
  sourcePath: string;
  destinationPath: string;
}

export interface ApplyPatchFileOutput {
  path: string;
  operation: ApplyPatchOperation;
  destinationPath?: string;
  hunkCount: number;
  additions: number;
  deletions: number;
  oldSha256?: string;
  newSha256?: string;
  oldBytes: number;
  newBytes: number;
  changed: boolean;
  matchModes?: PatchMatchMode[];
  exact?: boolean;
}

export interface ApplyPatchOutput {
  dryRun: boolean;
  transactional: true;
  files: ApplyPatchFileOutput[];
  changedPaths: string[];
  wouldChangePaths: string[];
  createdPaths: string[];
  wouldCreatePaths: string[];
  deletedPaths: string[];
  wouldDeletePaths: string[];
  movedPaths: ApplyPatchPathPair[];
  wouldMovePaths: ApplyPatchPathPair[];
  totalOperationCount: number;
  totalHunkCount: number;
  totalAdditions: number;
  totalDeletions: number;
}

const patchFileOutputSchema = z.strictObject({
  path: z.string(),
  operation: z.enum(['add', 'update', 'delete', 'move']),
  destinationPath: z.string().optional(),
  hunkCount: z.int().nonnegative(),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  oldSha256: sha256Schema.optional(),
  newSha256: sha256Schema.optional(),
  oldBytes: z.int().nonnegative(),
  newBytes: z.int().nonnegative(),
  changed: z.boolean(),
  matchModes: z.array(z.enum(['exact', 'trim_trailing_whitespace', 'trim_surrounding_whitespace', 'normalize_common_unicode_punctuation'])).optional(),
  exact: z.boolean().optional()
});

const pathPairSchema = z.strictObject({ sourcePath: z.string(), destinationPath: z.string() });

export const applyPatchOutputSchema = z.strictObject({
  dryRun: z.boolean(),
  transactional: z.literal(true),
  files: z.array(patchFileOutputSchema),
  changedPaths: z.array(z.string()),
  wouldChangePaths: z.array(z.string()),
  createdPaths: z.array(z.string()),
  wouldCreatePaths: z.array(z.string()),
  deletedPaths: z.array(z.string()),
  wouldDeletePaths: z.array(z.string()),
  movedPaths: z.array(pathPairSchema),
  wouldMovePaths: z.array(pathPairSchema),
  totalOperationCount: z.int().nonnegative(),
  totalHunkCount: z.int().nonnegative(),
  totalAdditions: z.int().nonnegative(),
  totalDeletions: z.int().nonnegative()
});
