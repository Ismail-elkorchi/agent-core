import type { ArtifactRepository } from '@agent-core/persistence';
import type {
  CommandExecution,
  CommandReconciliationResult,
  CompiledToolDefinition
} from '@agent-core/tools';
import { adoptCommandExecution } from '@agent-core/tools';
import {
  parseLocalToolConfiguration,
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  type LocalToolConfiguration
} from './core/configuration.js';
import { RootedFileSelector } from './core/rooted-file-selection.js';
import { isRootedFileAuthority, type RootedFileAuthority } from './core/rooted-file-authority.js';
import { TextPatchJournal } from './core/text-write.js';
import { applyPatchTool } from './tools/apply-patch/index.js';
import { editTextTool } from './tools/edit-text/index.js';
import { createExecCommandTool } from './tools/exec-command/index.js';
import { findFilesTool } from './tools/find-files/index.js';
import { listDirectoryTool } from './tools/list-directory/index.js';
import { createReadArtifactTool } from '@agent-core/tools';
import { readFilesTool } from './tools/read-files/index.js';
import { searchTextTool } from './tools/search-text/index.js';
import { stopProcessTool } from './tools/stop-process/index.js';
import { viewImageTool } from './tools/view-image/index.js';
import { writeStdinTool } from './tools/write-stdin/index.js';

export interface LocalToolHostOptions {
  readonly rootedFileAuthority: RootedFileAuthority;
  readonly artifactRepository: ArtifactRepository;
  /** Borrowed authority. Its owner manages reconciliation and lifetime. */
  readonly commandExecution?: CommandExecution;
  readonly patchJournal?: TextPatchJournal;
  readonly configuration?: LocalToolConfiguration;
  readonly enabledTools: readonly string[];
  readonly artifactReadMaxBytes: number;
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
  resolveReconciliation(input?: {
    readonly acknowledge?: readonly { readonly processId: string; readonly revision: string }[];
  }): Promise<CommandReconciliationResult>;
  close(): Promise<void>;
}

/** Compose and own the Node-local built-in tool host without application policy. */
export function createLocalToolHost(options: LocalToolHostOptions): LocalToolHost {
  const enabledTools = ownEnabledTools(options.enabledTools);
  assertKnownTools(enabledTools);
  const processToolsEnabled = enabledTools.some(
    (name) => name === 'exec_command' || name === 'write_stdin' || name === 'stop_process'
  );
  if (processToolsEnabled && options.commandExecution === undefined)
    throw new Error('Local process tools require an explicitly supplied command authority.');
  const configuration =
    options.configuration === undefined
      ? DEFAULT_LOCAL_TOOL_CONFIGURATION
      : parseLocalToolConfiguration(options.configuration);
  const readArtifact = createReadArtifactTool({ maxReadBytes: options.artifactReadMaxBytes });
  const artifactRepository = options.artifactRepository;
  let rootedFileAuthority: RootedFileAuthority | undefined;
  let patchJournal: TextPatchJournal | undefined;
  try {
    patchJournal = options.patchJournal;
    if (!isRootedFileAuthority(options.rootedFileAuthority))
      throw new TypeError('Local tool host requires an adopted RootedFileAuthority.');
    rootedFileAuthority = options.rootedFileAuthority;
  } catch (error) {
    patchJournal?.close();
    rootedFileAuthority?.close();
    throw error;
  }
  const adoptedRoot = rootedFileAuthority;
  const rootedFileSelector = new RootedFileSelector(adoptedRoot, configuration.fileSelection);
  let commandExecution: CommandExecution | undefined;
  try {
    commandExecution = options.commandExecution === undefined
      ? undefined
      : adoptCommandExecution(options.commandExecution);
  } catch (error) {
    patchJournal?.close();
    adoptedRoot.close();
    throw error;
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
    ...(enabledTools.includes('exec_command')
      ? [createExecCommandTool({ ptySupported: commandExecution?.descriptor.supportsPty ?? false })]
      : []),
    writeStdinTool,
    stopProcessTool,
    viewImageTool,
    readArtifact
  ]);
  const tools = selectTools(allTools, enabledTools);
  const noProcesses: CommandReconciliationResult = Object.freeze({
    resolved: Object.freeze([]),
    unresolved: Object.freeze([])
  });
  return Object.freeze({
    tools,
    services,
    capabilities: Object.freeze([...(commandExecution?.descriptor.capabilities ?? [])]),
    artifactRepository,
    ...(commandExecution ? { commandExecution } : {}),
    async ready() {
      await commandExecution?.reconcile();
    },
    reconciliation: async () => commandExecution ? commandExecution.reconcile() : noProcesses,
    async resolveReconciliation(
      input: {
        readonly acknowledge?: readonly { readonly processId: string; readonly revision: string }[];
      } = {}
    ) {
      if (!commandExecution) return noProcesses;
      if (input.acknowledge?.length)
        await commandExecution.acknowledgeUnresolved(input.acknowledge);
      return commandExecution.retryReconciliation();
    },
    close() {
      // Command authority is borrowed; its application owner closes it.
      try {
        patchJournal?.close();
      } finally {
        adoptedRoot.close();
      }
      return Promise.resolve();
    }
  });
}

function ownEnabledTools(enabled: readonly string[]): readonly string[] {
  if (new Set(enabled).size !== enabled.length)
    throw new Error('Configured local tools must be unique.');
  return Object.freeze([...enabled]);
}

function selectTools(
  tools: readonly CompiledToolDefinition[],
  enabled: readonly string[]
): readonly CompiledToolDefinition[] {
  return Object.freeze(tools.filter((tool) => enabled.includes(tool.name)));
}

function assertKnownTools(enabled: readonly string[]): void {
  const known = new Set([
    'list_directory',
    'find_files',
    'read_files',
    'search_text',
    'edit_text',
    'apply_patch',
    'exec_command',
    'write_stdin',
    'stop_process',
    'view_image',
    'read_artifact'
  ]);
  const unknown = enabled.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown configured local tools: ${unknown.join(', ')}.`);
}
