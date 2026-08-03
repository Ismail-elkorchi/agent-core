import * as z from 'zod';

export const shellCommandInputSchema = z.strictObject({
  command: z.string().min(1).refine((value) => value.trim().length > 0, 'Command cannot be empty or whitespace-only.').meta({
    description: 'Shell command string to run in the configured workspace. Supports pipes, redirects, here-docs, and command composition.'
  }),
  workdir: z.string().trim().min(1).default('.').meta({
    description: 'Workspace-relative directory to run the command in. Defaults to ".". Absolute paths and escaping paths are rejected.'
  }),
  timeoutMs: z.int().min(1_000).max(600_000).default(120_000).meta({ description: 'Maximum command runtime in milliseconds. Defaults to 120000.' }),
  maxOutputBytes: z.int().min(1_000).max(1_000_000).default(64_000).meta({
    description: 'Maximum combined stdout/stderr bytes captured from the process before runner truncation. Defaults to 64000. This controls retained evidence, not how many bytes are shown to the model.'
  }),
  previewMode: z.enum(['head_tail', 'head', 'tail', 'none']).default('head_tail').meta({
    description: 'How retained stdout/stderr should appear in the observation presentation. Defaults to "head_tail". Use "head" for commands like sed -n that already select a range, "tail" for logs/status output, and "none" when only exit status matters.'
  }),
  previewBytes: z.int().min(500).max(100_000).default(4_000).meta({
    description: 'Target observation-presentation bytes per stream after command capture. Defaults to 4000. This is capped by transcript budget and does not increase captured output; use maxOutputBytes for capture.'
  })
});

export type ShellCommandArguments = z.input<typeof shellCommandInputSchema>;
export type ShellCommandInput = z.output<typeof shellCommandInputSchema>;
