import * as z from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const applyPatchInputSchema = z.strictObject({
  patch: z.string().min(1).max(5_000_000).meta({
    description: 'Single patch document. First call shape: {"patch":"*** Begin Patch\\n*** Update File: relative/path.txt\\n@@\\n-old\\n+new\\n*** End Patch"}. Supports Add File, Update File, Delete File, and Move to operations.'
  }),
  dryRun: z.boolean().default(false).meta({
    description: 'Validate and compute resulting hashes/counts without writing files. Defaults to false.'
  }),
  expectedOldSha256: z.record(z.string().trim().min(1), sha256Schema).optional().meta({
    description: 'Optional preconditions keyed by patch source path. For update, delete, and move operations, the current source file SHA-256 must match when a key is provided.'
  }),
  maxPatchBytes: z.int().min(1).max(5_000_000).default(512_000).meta({
    description: 'Maximum UTF-8 byte size of the patch document. Defaults to 512000.'
  }),
  maxBytesPerFile: z.int().min(1).max(50_000_000).default(1_000_000).meta({
    description: 'Maximum bytes to read per existing file. Defaults to 1000000. Larger existing files make the whole patch invalid.'
  }),
  maxNewBytesPerFile: z.int().min(1).max(50_000_000).default(1_000_000).meta({
    description: 'Maximum UTF-8 byte size for each resulting file. Defaults to 1000000.'
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
