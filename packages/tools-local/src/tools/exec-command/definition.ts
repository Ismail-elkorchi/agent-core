import {
  defineTool,
  isCommandExecution,
  prepareCommandExecution,
  requireToolService,
  releasePreparedCommandExecution,
  startPreparedCommandExecution,
  type CommandExecution,
  type CommandExecutionOwner
} from '@agent-core/tools';
import { fileScope, processScope } from '../../core/resources.js';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { presentProcessObservation } from '../../core/presenters.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import { isSuccessfulProcessResult } from '../process-output.js';
import { execCommandOutputSchema, execCommandSchema } from './schema.js';

export function createExecCommandTool(options: { readonly ptySupported?: boolean } = {}) {
  const ptySupported = options.ptySupported === true;
  return defineTool({
    name: 'exec_command',
    implementationId: 'agent-core.exec-command.v1',
    description: 'Start a persistent command through the application-supplied command execution authority.',
    schema: execCommandSchema(ptySupported),
    outputSchema: execCommandOutputSchema,
    presentObservation: presentProcessObservation,
    requirements: { services: ['rootedFileAuthority', 'localToolConfiguration', 'commandExecution'] },
    effectEnvelope: { accesses: [{ mode: 'execute', scope: processScope() }], lockScopes: [fileScope()] },
    async canonicalizeInput(input, context) {
      const root = requireRootedFileAuthority(context);
      const workdir = root.canonicalPath(input.workdir);
      const directory = await root.openDirectory(workdir);
      await directory.close();
      const limits = requireLocalToolConfiguration(context).process;
      const executor = requireToolService<CommandExecution>(context, 'commandExecution', isCommandExecution, 'CommandExecution');
      const owner = processOwner(context.invocation);
      const request = Object.freeze({
        ...input, pty: 'pty' in input && input.pty === true, workdir,
        yieldMs: clampRequestedLimit(input.yieldMs, limits.maxYieldMs),
        timeoutMs: clampRequestedLimit(input.timeoutMs, limits.maxTimeoutMs),
        outputTokenBudget: clampRequestedLimit(input.outputTokenBudget, limits.maxOutputTokens),
        owner
      });
      const preparation = await prepareCommandExecution(executor, {
        command: request.command,
        rootedDirectory: request.workdir,
        pty: request.pty,
        timeoutMs: request.timeoutMs,
        yieldMs: request.yieldMs,
        outputTokenBudget: request.outputTokenBudget,
        owner
      });
      await context.preparation.own({ release: () => releasePreparedCommandExecution(executor, preparation) });
      return Object.freeze({ ...request, executor, preparation });
    },
    snapshotInput(input) {
      return Object.freeze({
        command: input.command,
        workdir: input.workdir,
        pty: input.pty,
        timeoutMs: input.timeoutMs,
        yieldMs: input.yieldMs,
        outputTokenBudget: input.outputTokenBudget,
        execution: input.preparation.authorization
      });
    },
    deriveEffects() {
      return { accesses: [{ mode: 'execute', scope: processScope() }], lockScopes: [fileScope()], recovery: { kind: 'unknown' } };
    },
    async invoke(input, context) {
      await context.emitProgress?.({ type: 'status', stage: 'process_starting', message: 'Starting command.' });
      let result;
      try {
        result = await startPreparedCommandExecution(input.executor, input.preparation, {
          ...(context.signal ? { signal: context.signal } : {}), ...(context.resourceLease ? { lease: context.resourceLease } : {}),
          onProgress: (progress) => context.emitProgress?.(progress)
        });
      } catch (error) {
        await context.emitProgress?.({ type: 'status', stage: 'process_failed', message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      return {
        kind: 'result' as const, ok: isSuccessfulProcessResult(result),
        summary: result.status === 'running' ? 'Process continues as ' + result.processId + '.' : 'Process ' + result.status + (result.exitCode === undefined ? '' : ' with exit code ' + String(result.exitCode)) + '.',
        scope: {
          resources: [processScope(result.processId), fileScope(input.workdir)],
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
function processOwner(invocation: import('@agent-core/tools').ToolInvocationContext | undefined): CommandExecutionOwner {
  if (!invocation) throw new Error('Process tools require a runtime invocation owner.');
  return Object.freeze({ runId: invocation.runId, turnId: invocation.turnId, toolBatchId: invocation.toolBatchId, callIndex: invocation.callIndex });
}
