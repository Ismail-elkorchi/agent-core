import { defineTool, requireToolService, requireWorkspaceRoot } from '@agent-core/tools';
import { canonicalWorkspacePath, requireDirectoryInsideRoot, resolveInsideRoot } from '../../core/filesystem.js';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { isProcessManager, type ProcessManager } from '../../core/process-manager.js';
import { isSuccessfulProcessResult } from '../process-output.js';
import { execCommandInputSchema, execCommandOutputSchema } from './schema.js';

export const execCommandTool = defineTool({
  name: 'exec_command',
  implementationId: 'agent-core.exec-command.v1',
  description: 'Start a persistent workspace command and return output produced before the yield time.',
  schema: execCommandInputSchema,
  outputSchema: execCommandOutputSchema,
  effectEnvelope: { accesses: [{ mode: 'execute', scope: 'workspace' }], lockScopes: ['workspace/process-start'] },
  async canonicalizeInput(input, context) {
    const root = requireWorkspaceRoot(context);
    const workdir = await canonicalWorkspacePath(root, input.workdir);
    await requireDirectoryInsideRoot(root, resolveInsideRoot(root, workdir), workdir);
    const limits = requireLocalToolConfiguration(context).process;
    return {
      ...input,
      workdir,
      yieldMs: clampRequestedLimit(input.yieldMs, limits.maxYieldMs),
      timeoutMs: clampRequestedLimit(input.timeoutMs, limits.maxTimeoutMs),
      outputTokenBudget: clampRequestedLimit(input.outputTokenBudget, limits.maxOutputTokens)
    };
  },
  deriveEffects(input) {
    return {
      accesses: [{ mode: 'execute', scope: `workspace/${input.workdir}` }],
      lockScopes: ['workspace/process-start'],
      idempotency: 'non_idempotent'
    };
  },
  async invoke(input, context) {
    const manager = requireToolService<ProcessManager>(context, 'processManager', isProcessManager, 'ProcessManager');
    await context.emitProgress?.({ stage: 'start', message: 'Starting process.' });
    const result = await manager.start({
      command: input.command,
      cwd: resolveInsideRoot(requireWorkspaceRoot(context), input.workdir),
      pty: input.pty,
      timeoutMs: input.timeoutMs,
      yieldMs: input.yieldMs,
      outputTokenBudget: input.outputTokenBudget,
      ...(context.signal ? { signal: context.signal } : {})
    });
    await context.emitProgress?.({ stage: result.status === 'running' ? 'running' : 'completed', message: `Process ${result.status}.` });
    return {
      kind: 'result' as const,
      ok: isSuccessfulProcessResult(result),
      summary: result.status === 'running' ? `Process continues as ${result.processId}.` : `Process ${result.status}${result.exitCode === undefined ? '' : ` with exit code ${String(result.exitCode)}`}.`,
      scope: { resources: [`processes/${result.processId}`, `workspace/files/${input.workdir}`], coverage: result.combined.omittedBytes > 0 ? 'partial' : 'complete', ...(result.combined.omittedBytes > 0 ? { cause: 'output token budget reached' } : {}) },
      content: [{ type: 'artifact' as const, artifact: result.artifact }],
      output: result
    };
  }
});
