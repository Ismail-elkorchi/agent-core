import path from 'node:path';
import type { ArtifactRepository } from '@agent-core/evidence';
import type {
  CommandExecution,
  CommandExecutionReport,
  CommandReconciliationResult,
  CompiledToolDefinition,
  ToolResourceLease
} from '@agent-core/tools';
import { adoptCommandExecution } from '@agent-core/tools';
import { parseLocalToolConfiguration, DEFAULT_LOCAL_TOOL_CONFIGURATION, type LocalToolConfiguration } from './core/configuration.js';
import { LocalCommandExecution, type PtyProcessFactory } from './core/command-execution.js';
import { RootedFileSelector } from './core/rooted-file-selection.js';
import { isRootedFileAuthority, type RootedFileAuthority } from './core/rooted-file-authority.js';
import { TextPatchJournal } from './core/text-write.js';
import { applyPatchTool } from './tools/apply-patch/index.js';
import { editTextTool } from './tools/edit-text/index.js';
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
  readonly rootedFileAuthority: RootedFileAuthority;
  readonly artifactRepository: ArtifactRepository;
  readonly processLedgerDirectory?: string;
  /** Application-supplied command authority. The host owns and closes it. */
  readonly commandExecution?: CommandExecution;
  readonly patchJournal?: TextPatchJournal;
  readonly configuration?: LocalToolConfiguration;
  readonly enabledTools: readonly string[];
  readonly ptyFactory?: PtyProcessFactory;
  readonly deliverRecoveredTerminalReport?: (report: CommandExecutionReport) => Promise<boolean>;
}

export interface LocalToolHost {
  readonly tools: readonly CompiledToolDefinition[];
  readonly services: Readonly<Record<string, unknown>> & {
    readonly rootedFileAuthority: RootedFileAuthority;
    readonly artifactRepository: ArtifactRepository;
    readonly localToolConfiguration: LocalToolConfiguration;
    readonly commandExecution?: CommandExecution;
    readonly rootedFileSelector: RootedFileSelector;
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
  if (options.processLedgerDirectory !== undefined && options.commandExecution !== undefined) {
    throw new Error('Local tool host accepts either a process ledger or an application command authority, not both.');
  }
  if (processToolsEnabled && options.processLedgerDirectory === undefined && options.commandExecution === undefined) {
    throw new Error('Local process tools require an application command authority or a local process ledger.');
  }
  const configuration = options.configuration === undefined
    ? DEFAULT_LOCAL_TOOL_CONFIGURATION
    : parseLocalToolConfiguration(options.configuration);
  const artifactRepository = options.artifactRepository;
  let rootedFileAuthority: RootedFileAuthority | undefined;
  let patchJournal: TextPatchJournal | undefined;
  try {
    patchJournal = options.patchJournal;
    if (!isRootedFileAuthority(options.rootedFileAuthority)) throw new TypeError('Local tool host requires an adopted RootedFileAuthority.');
    rootedFileAuthority = options.rootedFileAuthority;
  } catch (error) {
    patchJournal?.close(); rootedFileAuthority?.close(); throw error;
  }
  const adoptedRoot = rootedFileAuthority;
  const rootedFileSelector = new RootedFileSelector(adoptedRoot, configuration.fileSelection);
  let commandExecution: CommandExecution | undefined;
  try {
    commandExecution = options.commandExecution === undefined
      ? options.processLedgerDirectory === undefined ? undefined : new LocalCommandExecution({
        artifactRepository,
        rootedFileAuthority: adoptedRoot,
        ledgerDirectory: path.resolve(options.processLedgerDirectory),
        ...configuration.process,
        ...(options.ptyFactory ? { ptyFactory: options.ptyFactory } : {})
      })
      : adoptCommandExecution(options.commandExecution);
  } catch (error) {
    patchJournal?.close(); adoptedRoot.close(); throw error;
  }
  const services = Object.freeze({
    rootedFileAuthority: adoptedRoot,
    artifactRepository,
    localToolConfiguration: configuration,
    ...(commandExecution ? { commandExecution } : {}),
    rootedFileSelector,
    ...(patchJournal ? { patchJournal } : {})
  });
  const allTools: readonly CompiledToolDefinition[] = Object.freeze([
    listDirectoryTool,
    findFilesTool,
    readFilesTool,
    searchTextTool,
    editTextTool,
    applyPatchTool,
    ...(enabledTools.includes('exec_command') ? [createExecCommandTool({ ptySupported: commandExecution?.descriptor.supportsPty ?? false })] : []),
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
        accesses: [{ mode: 'execute', scope: 'processes' }],
        lockScopes: ['files'],
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
  const known = new Set(['list_directory', 'find_files', 'read_files', 'search_text', 'edit_text', 'apply_patch', 'exec_command', 'write_stdin', 'stop_process', 'view_image', 'read_artifact']);
  const unknown = enabled.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown configured local tools: ${unknown.join(', ')}.`);
}
