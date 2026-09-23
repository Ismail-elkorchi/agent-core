import {
  defineTool,
  isCommandExecution,
  isWorkspaceFiles,
  planCommandExecution,
  releaseCommandExecutionPlan,
  requireToolService,
  startCommandExecutionPlan,
  type CommandExecution,
  type CommandExecutionOwner,
  type CommandExecutionPlan,
  type CommandExecutionPlanRequest,
  type ToolExecutionContext,
  type WorkspaceFiles
} from '@agent-core/tools';
import { clampRequestedLimit, requireLocalToolConfiguration } from '../../core/configuration.js';
import { buildProcessContent } from '../../core/model-content.js';
import { fileScope, processScope } from '../../core/resources.js';
import { requireRootedFileAuthority } from '../../core/rooted-files.js';
import { execCommandOutputSchema, execCommandSchema } from './schema.js';

export function createExecCommandTool(
  options: { readonly ptySupported?: boolean; readonly environmentLifetimeSupported?: boolean } = {}
) {
  const ptySupported = options.ptySupported === true;
  return defineTool({
    name: 'exec_command',
    implementationId: 'agent-core.exec-command.v1',
    description:
      'Run a command to exit or timeout while streaming progress. Background commands return a process handle for later interaction.',
    schema: execCommandSchema(ptySupported, options.environmentLifetimeSupported),
    outputSchema: execCommandOutputSchema,
    buildModelContent: buildProcessContent,
    requirements: {
      services: ['localToolConfiguration', 'commandExecution']
    },
    effectEnvelope: {
      accesses: [{ mode: 'execute', scope: processScope() }],
      lockScopes: [fileScope()]
    },
    async canonicalizeInput(input, context) {
      const workspace = workspaceFiles(context);
      const workdir = workspace
        ? workspace.normalize(input.workdir)
        : requireRootedFileAuthority(context).canonicalPath(input.workdir);
      if (workspace) {
        const status = await workspace.stat(workdir);
        if (status.kind !== 'directory')
          throw new Error(`Command workdir is not a directory: ${workdir}`);
      } else {
        const directory = await requireRootedFileAuthority(context).openDirectory(workdir);
        await directory.close();
      }
      const limits = requireLocalToolConfiguration(context).process;
      const executor = requireToolService<CommandExecution>(
        context,
        'commandExecution',
        isCommandExecution,
        'CommandExecution'
      );
      const owner = processOwner(context);
      const background = input.background || input.lifetime === 'environment';
      const request = Object.freeze({
        ...input,
        background,
        pty: 'pty' in input && input.pty === true,
        lifetime: 'lifetime' in input ? input.lifetime : 'job',
        workdir,
        yieldMs: background ? Math.min(1_000, limits.maxYieldMs) : 0,
        timeoutMs: clampRequestedLimit(input.timeoutMs, limits.maxTimeoutMs),
        outputTokenBudget: clampRequestedLimit(input.outputTokenBudget, limits.maxOutputTokens),
        owner
      });
      return Object.freeze({ ...request, executor });
    },
    snapshotInput(input) {
      return commandSnapshot(input);
    },
    deriveEffects() {
      return {
        accesses: [{ mode: 'execute', scope: processScope() }],
        lockScopes: [fileScope()],
        recovery: { kind: 'unknown' }
      };
    },
    async bindExecution(input, context) {
      const { executor, ...request } = input;
      const reservation = await planCommandExecution(executor, {
        command: request.command,
        rootedDirectory: request.workdir,
        pty: request.pty,
        lifetime: request.lifetime,
        timeoutMs: request.timeoutMs,
        yieldMs: request.yieldMs,
        outputTokenBudget: request.outputTokenBudget,
        owner: request.owner
      });
      await context.lifetime.own({
        release: () => releaseCommandExecutionPlan(executor, reservation)
      });
      return {
        snapshot: { ...commandSnapshot(input), execution: reservation.authorization },
        invoke: (executionContext) => executeCommand({ ...input, reservation }, executionContext)
      };
    }
  });
}

async function executeCommand(
  input: CommandInput & { readonly reservation: CommandExecutionPlan },
  context: ToolExecutionContext
) {
  await context.emitProgress?.({
    type: 'status',
    stage: 'process_starting',
    message: 'Starting command.'
  });
  let result;
  try {
    result = await startCommandExecutionPlan(input.executor, input.reservation, {
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.resourceLease ? { lease: context.resourceLease } : {}),
      awaitTerminal: !input.background,
      onProgress: (progress) => context.emitProgress?.(progress)
    });
  } catch (error) {
    await context.emitProgress?.({
      type: 'status',
      stage: 'process_failed',
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
  return {
    kind: 'result' as const,
    execution: { state: result.status === 'running' ? ('active' as const) : ('settled' as const) },
    summary:
      result.status === 'running'
        ? 'Process continues as ' + result.processId + '.'
        : 'Process ' +
          result.status +
          (result.exitCode === undefined ? '' : ' with exit code ' + String(result.exitCode)) +
          '.',
    scope: {
      resources: [processScope(result.processId), fileScope(input.workdir)],
      coverage: result.combined.omittedBytes > 0 ? ('partial' as const) : ('complete' as const),
      ...(result.combined.omittedBytes > 0
        ? {
            truncated: true,
            causes: ['output_budget'],
            omitted: { bytes: result.combined.omittedBytes }
          }
        : {})
    },
    ...(result.artifact
      ? { content: [{ type: 'artifact' as const, artifact: result.artifact }] }
      : {}),
    output: result
  };
}
export const execCommandTool = createExecCommandTool();
function processOwner(context: ToolExecutionContext): CommandExecutionOwner {
  const invocation = context.invocation;
  if (!invocation) throw new Error('Process tools require a runtime invocation owner.');
  return Object.freeze({
    ownerId: context.resourceOwnerId ?? invocation.runId,
    runId: invocation.runId,
    turnId: invocation.turnId,
    toolBatchId: invocation.toolBatchId,
    callIndex: invocation.callIndex
  });
}

interface CommandInput extends Omit<CommandExecutionPlanRequest, 'rootedDirectory'> {
  readonly workdir: string;
  readonly background: boolean;
  readonly executor: CommandExecution;
}

function commandSnapshot(input: CommandInput) {
  return {
    command: input.command,
    workdir: input.workdir,
    pty: input.pty,
    lifetime: input.lifetime ?? 'job',
    timeoutMs: input.timeoutMs,
    background: input.background,
    outputTokenBudget: input.outputTokenBudget
  };
}

function workspaceFiles(context: ToolExecutionContext): WorkspaceFiles | undefined {
  const candidate = context.services?.workspaceFiles;
  if (candidate === undefined) return undefined;
  if (!isWorkspaceFiles(candidate))
    throw new TypeError('workspaceFiles must be an adopted file authority.');
  return candidate;
}
