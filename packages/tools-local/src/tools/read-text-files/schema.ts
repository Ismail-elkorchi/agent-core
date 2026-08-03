import * as z from 'zod';

export const readTextFileRequestSchema = z.strictObject({
  path: z.string().trim().min(1).meta({
    description: 'Required non-empty text file path, relative to the configured root. Absolute paths and escaping paths are rejected.'
  }),
  startLine: z.int().min(1).default(1).meta({
    description: 'First 1-based line number to read from this file. Defaults to 1.'
  }),
  endLine: z.int().min(1).optional().meta({
    description: 'Last 1-based line number to read from this file. Omit to read about 100 lines from startLine.'
  })
}).superRefine((value, context) => {
  if (value.endLine !== undefined && value.endLine < value.startLine) {
    context.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: 'endLine must be greater than or equal to startLine.'
    });
  }
});

export const readTextFilesInputSchema = z.strictObject({
  files: z.array(readTextFileRequestSchema).min(1).max(50).meta({
    description: 'One or more text file windows to read. First call shape: {"files":[{"path":"relative/path.txt"}]}.'
  }),
  maxBytesPerFile: z.int().min(1).max(50_000_000).default(512_000).meta({
    description: 'Maximum bytes to read from each file. Defaults to 512000. Larger files return a structured per-file failure.'
  }),
  maxTotalBytes: z.int().min(1).max(20_000_000).default(2_000_000).meta({
    description: 'Maximum aggregate bytes read across all requested files. Defaults to 2000000.'
  })
});

export type ReadTextFilesArguments = z.input<typeof readTextFilesInputSchema>;
export type ReadTextFilesInput = z.output<typeof readTextFilesInputSchema>;

export type ReadTextFilesFailureReason =
  | 'not_found'
  | 'not_file'
  | 'binary'
  | 'too_large'
  | 'symlink'
  | 'path_outside_workspace'
  | 'invalid_range'
  | 'total_limit';

export interface ReadTextFilesFileOutput {
  path: string;
  sha256: string;
  lineEndings: 'lf' | 'crlf' | 'mixed' | 'none';
  hasFinalNewline: boolean;
  totalBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  content: string;
  coverage: 'complete' | 'partial';
}

export interface ReadTextFilesFailureOutput {
  path: string;
  reason: ReadTextFilesFailureReason;
  message: string;
}

export interface ReadTextFilesOutput {
  files: ReadTextFilesFileOutput[];
  failures: ReadTextFilesFailureOutput[];
  omitted: {
    files: number;
    bytes: number;
  };
  limits: {
    maxBytesPerFile: number;
    maxTotalBytes: number;
  };
  coverage: 'complete' | 'partial';
}
