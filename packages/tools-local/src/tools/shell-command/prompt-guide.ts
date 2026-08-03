import type { ToolPromptGuideRequest } from '@agent-core/tools';
import { formatShellRuntimeForPrompt, type ShellRuntimeDescriber } from './shell-runtime.js';

const SHELL_COMMAND_BASE_PROMPT_GUIDE = `Use shell_command for workspace inspection, generation, verification, and normal shell workflows.

Input shape:
{"command":"pwd && ls","workdir":"."}

Rules:
- command is one shell string, not an argv array.
- workdir is workspace-relative and defaults to ".".
- Pipes, redirects, here-docs, and command composition are supported.
- For validation pipelines where any command failure matters, use \`set -o pipefail\` or check statuses explicitly.
- maxOutputBytes controls how much process stdout/stderr is captured, not how much is shown to the model.
- previewMode and previewBytes choose the slice included in the observation presentation; the transcript budget still applies.
- Prefer shell-side narrowing such as rg filters, sed ranges, head, tail, wc, or redirects to workspace files before broad output dumps.
- Before apply_patch updates, inspect the exact target region with unnumbered output such as \`sed -n '120,170p' path\`; avoid copying line numbers from \`nl -ba\` into patch hunks.
- Commands that write, use network risk, or are destructive require matching policy permission.`;

export function shellCommandPromptGuide(request: ToolPromptGuideRequest): string {
  return `${SHELL_COMMAND_BASE_PROMPT_GUIDE}\n\n${shellRuntimeGuide(request)}`;
}

function shellRuntimeGuide(request: ToolPromptGuideRequest): string {
  const describer = shellRuntimeDescriber(request.services?.shellRunner);
  if (!describer) {
    return [
      'Shell runtime snapshot:',
      '- Runtime: unavailable from the configured shell runner.',
      '- Use `command -v <name>` before relying on a command that may not be installed.'
    ].join('\n');
  }
  return formatShellRuntimeForPrompt(describer.describeEnvironment(), { maxCommands: 50 });
}

function shellRuntimeDescriber(value: unknown): ShellRuntimeDescriber | undefined {
  return isShellRuntimeDescriber(value) ? value : undefined;
}

function isShellRuntimeDescriber(value: unknown): value is ShellRuntimeDescriber {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'describeEnvironment') === 'function';
}
