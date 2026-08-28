import { defineTool, requireToolService } from '@agent-core/tools';
import { workspaceFileScope, workspaceProcessScope } from '../../core/resources.js';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { isProcessManager, type ProcessManager, type ProcessOwner } from '../../core/process-manager.js';
import { presentProcessObservation } from '../../core/presenters.js';
import { requireWorkspaceFileRoot } from '../../core/workspace.js';
import { isSuccessfulProcessResult } from '../process-output.js';
import { execCommandOutputSchema, execCommandSchema } from './schema.js';

export function createExecCommandTool(options: { readonly ptySupported?: boolean } = {}) {
  const ptySupported = options.ptySupported === true;
  return defineTool({
    name: 'exec_command',
    implementationId: 'agent-core.exec-command.v1',
    description: 'Start an ambient persistent shell command under the permissions of the Agent Core process. It can indirectly read, write, or delete files, access the network, and start child processes.',
    schema: execCommandSchema(ptySupported),
    outputSchema: execCommandOutputSchema,
    presentObservation: presentProcessObservation,
    requirements: { services: ['workspaceFileRoot', 'localToolConfiguration', 'processManager'] },
    effectEnvelope: { accesses: [{ mode: 'execute', scope: workspaceProcessScope() }], lockScopes: [workspaceFileScope()] },
    async canonicalizeInput(input, context) {
      const root = requireWorkspaceFileRoot(context);
      const workdir = root.canonicalPath(input.workdir);
      const directory = await root.openDirectory(workdir);
      await directory.close();
      const limits = requireLocalToolConfiguration(context).process;
      return {
        ...input, pty: 'pty' in input && input.pty === true, workdir,
        yieldMs: clampRequestedLimit(input.yieldMs, limits.maxYieldMs),
        timeoutMs: clampRequestedLimit(input.timeoutMs, limits.maxTimeoutMs),
        outputTokenBudget: clampRequestedLimit(input.outputTokenBudget, limits.maxOutputTokens)
      };
    },
    deriveEffects() {
      return { accesses: [{ mode: 'execute', scope: workspaceProcessScope() }], lockScopes: [workspaceFileScope()], recovery: { kind: 'unknown' } };
    },
    async invoke(input, context) {
      const manager = requireToolService<ProcessManager>(context, 'processManager', isProcessManager, 'ProcessManager');
      const owner = processOwner(context.invocation);
      const commandDirectory = await requireWorkspaceFileRoot(context).commandDirectory(input.workdir);
      await context.emitProgress?.({ type: 'status', stage: 'process_starting', message: 'Starting ambient process.' });
      let result;
      try {
        result = await manager.start({
          command: input.command, cwd: commandDirectory.path, pty: input.pty,
          timeoutMs: input.timeoutMs, yieldMs: input.yieldMs, outputTokenBudget: input.outputTokenBudget, owner,
          ...(context.signal ? { signal: context.signal } : {}), ...(context.resourceLease ? { lease: context.resourceLease } : {}),
          onProgress: (progress) => context.emitProgress?.(progress)
        });
      } catch (error) {
        await context.emitProgress?.({ type: 'status', stage: 'process_failed', message: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally { await commandDirectory.close(); }
      return {
        kind: 'result' as const, ok: isSuccessfulProcessResult(result),
        summary: result.status === 'running' ? 'Process continues as ' + result.processId + '.' : 'Process ' + result.status + (result.exitCode === undefined ? '' : ' with exit code ' + String(result.exitCode)) + '.',
        scope: {
          resources: [workspaceProcessScope(result.processId), workspaceFileScope(input.workdir)],
          coverage: result.combined.omittedBytes > 0 ? 'partial' : 'complete',
          ...(result.combined.omittedBytes > 0 ? { truncated: true, causes: ['output_budget'], omitted: { bytes: result.combined.omittedBytes } } : {})
        },
        ...(result.artifact ? { content: [{ type: 'artifact' as const, artifact: result.artifact }] } : {}),
        output: result
      };
    }
  });
}
export const execCommandTool = createExecCommandTool();
function processOwner(invocation: import('@agent-core/tools').ToolInvocationContext | undefined): ProcessOwner {
  if (!invocation) throw new Error('Process tools require a runtime invocation owner.');
  return Object.freeze({ runId: invocation.runId, turnId: invocation.turnId, toolBatchId: invocation.toolBatchId, callIndex: invocation.callIndex });
}
