import path from 'node:path';
import type { ArtifactRepository } from '@agent-core/evidence';
import type {
  CommandExecution,
  CommandExecutionReport,
  CommandReconciliationResult,
  CompiledToolDefinition,
  ToolResourceLease
} from '@agent-core/tools';
import { parseLocalToolConfiguration, DEFAULT_LOCAL_TOOL_CONFIGURATION, type LocalToolConfiguration } from './core/configuration.js';
import { LocalCommandExecution, type PtyProcessFactory } from './core/command-execution.js';
import { WorkspaceFileSelector } from './core/workspace-file-selection.js';
import { isWorkspaceFileRoot, type WorkspaceFileRoot } from './core/workspace-file-root.js';
import { TextPatchJournal } from './core/text-write.js';
import { applyPatchTool } from './tools/apply-patch/index.js';
import { createExecCommandTool } from './tools/exec-command/index.js';
import { findFilesTool } from './tools/find-files/index.js';
import { listDirectoryTool } from './tools/list-directory/index.js';
import { readArtifactTool } from './tools/read-artifact/index.js';
import { readFilesTool } from './tools/read-files/index.js';
import { searchTextTool } from './tools/search-text/index.js';
import { stopProcessTool } from './tools/stop-process/index.js';
import { viewImageTool } from './tools/view-image/index.js';
import { writeStdinTool } from './tools/write-stdin/index.js';

export interface LocalToolHostOptions {
  readonly workspaceFileRoot: WorkspaceFileRoot;
  readonly artifactRepository: ArtifactRepository;
  readonly processLedgerDirectory?: string;
  readonly patchJournal?: TextPatchJournal;
  readonly configuration?: LocalToolConfiguration;
  readonly enabledTools: readonly string[];
  readonly ptyFactory?: PtyProcessFactory;
  readonly deliverRecoveredTerminalReport?: (report: CommandExecutionReport) => Promise<boolean>;
}

export interface LocalToolHost {
  readonly tools: readonly CompiledToolDefinition[];
  readonly services: Readonly<Record<string, unknown>> & {
    readonly workspaceFileRoot: WorkspaceFileRoot;
    readonly artifactRepository: ArtifactRepository;
    readonly localToolConfiguration: LocalToolConfiguration;
    readonly commandExecution?: CommandExecution;
    readonly workspaceFileSelector: WorkspaceFileSelector;
    readonly patchJournal?: TextPatchJournal;
  };
  readonly capabilities: readonly string[];
  readonly artifactRepository: ArtifactRepository;
  readonly commandExecution?: CommandExecution;
  ready(): Promise<void>;
  reconciliation(): Promise<CommandReconciliationResult>;
  resolveReconciliation(input?: { readonly acknowledgeProcessIds?: readonly string[] }): Promise<CommandReconciliationResult>;
  close(): Promise<void>;
}

/** Compose and own the Node-local built-in tool host without application policy. */
export function createLocalToolHost(options: LocalToolHostOptions): LocalToolHost {
  const enabledTools = ownEnabledTools(options.enabledTools);
  assertKnownTools(enabledTools);
  const processToolsEnabled = enabledTools.some((name) => name === 'exec_command' || name === 'write_stdin' || name === 'stop_process');
  if (processToolsEnabled && options.processLedgerDirectory === undefined) throw new Error('Local process tools require processLedgerDirectory.');
  const configuration = options.configuration === undefined
    ? DEFAULT_LOCAL_TOOL_CONFIGURATION
    : parseLocalToolConfiguration(options.configuration);
  const artifactRepository = options.artifactRepository;
  let workspaceFileRoot: WorkspaceFileRoot | undefined;
  let patchJournal: TextPatchJournal | undefined;
  try {
    patchJournal = options.patchJournal;
    if (!isWorkspaceFileRoot(options.workspaceFileRoot)) throw new TypeError('Local tool host requires an adopted WorkspaceFileRoot.');
    workspaceFileRoot = options.workspaceFileRoot;
  } catch (error) {
    patchJournal?.close(); workspaceFileRoot?.close(); throw error;
  }
  const adoptedRoot = workspaceFileRoot;
  const workspaceFileSelector = new WorkspaceFileSelector(adoptedRoot, configuration.fileSelection);
  let commandExecution: LocalCommandExecution | undefined;
  try {
    commandExecution = options.processLedgerDirectory === undefined ? undefined : new LocalCommandExecution({
        artifactRepository,
        workspaceFileRoot: adoptedRoot,
        ledgerDirectory: path.resolve(options.processLedgerDirectory),
        ...configuration.process,
        ...(options.ptyFactory ? { ptyFactory: options.ptyFactory } : {})
      });
  } catch (error) {
    patchJournal?.close(); adoptedRoot.close(); throw error;
  }
  const services = Object.freeze({
    workspaceFileRoot: adoptedRoot,
    artifactRepository,
    localToolConfiguration: configuration,
    ...(commandExecution ? { commandExecution } : {}),
    workspaceFileSelector,
    ...(patchJournal ? { patchJournal } : {})
  });
  const allTools: readonly CompiledToolDefinition[] = Object.freeze([
    listDirectoryTool,
    findFilesTool,
    readFilesTool,
    searchTextTool,
    applyPatchTool,
    createExecCommandTool({ ptySupported: commandExecution?.descriptor.supportsPty ?? false }),
    writeStdinTool,
    stopProcessTool,
    viewImageTool,
    readArtifactTool
  ]);
  const tools = selectTools(allTools, enabledTools);
  const noProcesses: CommandReconciliationResult = Object.freeze({ resolved: Object.freeze([]), unresolved: Object.freeze([]) });
  let reconciliation = commandExecution?.reconcile() ?? Promise.resolve(noProcesses);
  let blocker: ToolResourceLease | undefined;
  const ensureBlocker = async (result: CommandReconciliationResult): Promise<void> => {
    if (!commandExecution) return;
    if (result.unresolved.length > 0 && !blocker) {
      blocker = await commandExecution.resourceLeases.acquire({
        accesses: [{ mode: 'execute', scope: 'workspace/processes' }],
        lockScopes: ['workspace/files'],
        recovery: { kind: 'unknown' }
      }, 'unresolved-process-reconciliation');
    }
    if (result.unresolved.length === 0 && blocker) { blocker.release(); blocker = undefined; }
  };
  const deliverRecovered = async (): Promise<void> => {
    if (!commandExecution || !options.deliverRecoveredTerminalReport) return;
    for (const report of commandExecution.recoveredTerminalReports()) {
      if (await options.deliverRecoveredTerminalReport(report)) await commandExecution.acknowledgeTerminalReport(report.result.processId);
    }
  };
  return Object.freeze({
    tools,
    services,
    capabilities: Object.freeze([...(commandExecution?.descriptor.capabilities ?? [])]),
    artifactRepository,
    ...(commandExecution ? { commandExecution } : {}),
    async ready() { await ensureBlocker(await reconciliation); await deliverRecovered(); },
    reconciliation: () => reconciliation,
    async resolveReconciliation(input: { readonly acknowledgeProcessIds?: readonly string[] } = {}) {
      if (!commandExecution) return noProcesses;
      if (input.acknowledgeProcessIds?.length) await commandExecution.acknowledgeUnresolved(input.acknowledgeProcessIds);
      reconciliation = commandExecution.retryReconciliation();
      const result = await reconciliation;
      await ensureBlocker(result);
      await deliverRecovered();
      return result;
    },
    async close() { blocker?.release(); blocker = undefined; await commandExecution?.close(); patchJournal?.close(); adoptedRoot.close(); }
  });
}

function ownEnabledTools(enabled: readonly string[]): readonly string[] {
  if (new Set(enabled).size !== enabled.length) throw new Error('Configured local tools must be unique.');
  return Object.freeze([...enabled]);
}

function selectTools(tools: readonly CompiledToolDefinition[], enabled: readonly string[]): readonly CompiledToolDefinition[] {
  return Object.freeze(tools.filter((tool) => enabled.includes(tool.name)));
}

function assertKnownTools(enabled: readonly string[]): void {
  const known = new Set(['list_directory', 'find_files', 'read_files', 'search_text', 'apply_patch', 'exec_command', 'write_stdin', 'stop_process', 'view_image', 'read_artifact']);
  const unknown = enabled.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown configured local tools: ${unknown.join(', ')}.`);
}
