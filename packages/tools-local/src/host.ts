import path from 'node:path';
import { LocalArtifactRepository } from '@agent-core/evidence/node';
import type { ToolDefinition, ToolResourceLease } from '@agent-core/tools';
import { parseLocalToolConfiguration, DEFAULT_LOCAL_TOOL_CONFIGURATION, type LocalToolConfiguration } from './core/configuration.js';
import { ProcessManager, type ProcessReconciliationResult, type ProcessTerminalReport, type PtyProcessFactory } from './core/process-manager.js';
import { WorkspaceFileSelector } from './core/workspace-file-selection.js';
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
  readonly workspaceRoot: string;
  readonly artifactDirectory: string;
  readonly processLedgerDirectory: string;
  readonly patchTransactionDirectory?: string;
  readonly configuration?: LocalToolConfiguration;
  readonly enabledTools?: readonly string[];
  readonly ptyFactory?: PtyProcessFactory;
  readonly deliverRecoveredTerminalReport?: (report: ProcessTerminalReport) => Promise<boolean>;
}

export interface LocalToolHost {
  readonly tools: readonly ToolDefinition[];
  readonly services: Readonly<Record<string, unknown>> & {
    readonly workspaceRoot: string;
    readonly artifactRepository: LocalArtifactRepository;
    readonly localToolConfiguration: LocalToolConfiguration;
    readonly processManager: ProcessManager;
    readonly workspaceFileSelector: WorkspaceFileSelector;
    readonly patchTransactionDirectory?: string;
  };
  readonly capabilities: readonly string[];
  readonly artifactRepository: LocalArtifactRepository;
  readonly processManager: ProcessManager;
  ready(): Promise<void>;
  reconciliation(): Promise<ProcessReconciliationResult>;
  resolveReconciliation(input?: { readonly acknowledgeProcessIds?: readonly string[] }): Promise<ProcessReconciliationResult>;
  close(): Promise<void>;
}

/** Compose and own the Node-local built-in tool host without application policy. */
export function createLocalToolHost(options: LocalToolHostOptions): LocalToolHost {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const configuration = options.configuration === undefined
    ? DEFAULT_LOCAL_TOOL_CONFIGURATION
    : parseLocalToolConfiguration(options.configuration);
  const artifactRepository = new LocalArtifactRepository({ rootDir: path.resolve(options.artifactDirectory) });
  const processManager = new ProcessManager({
    artifactRepository,
    ledgerDirectory: path.resolve(options.processLedgerDirectory),
    ...configuration.process,
    ...(options.ptyFactory ? { ptyFactory: options.ptyFactory } : {})
  });
  const workspaceFileSelector = new WorkspaceFileSelector(workspaceRoot, configuration.fileSelection);
  const services = Object.freeze({
    workspaceRoot,
    artifactRepository,
    localToolConfiguration: configuration,
    processManager,
    workspaceFileSelector,
    ...(options.patchTransactionDirectory ? { patchTransactionDirectory: path.resolve(options.patchTransactionDirectory) } : {})
  });
  const allTools: readonly ToolDefinition[] = Object.freeze([
    listDirectoryTool,
    findFilesTool,
    readFilesTool,
    searchTextTool,
    applyPatchTool,
    createExecCommandTool({ ptySupported: processManager.supportsPty() }),
    writeStdinTool,
    stopProcessTool,
    viewImageTool,
    readArtifactTool
  ]);
  const tools = selectTools(allTools, options.enabledTools);
  let reconciliation = processManager.reconcileOrphanProcesses();
  let blocker: ToolResourceLease | undefined;
  const ensureBlocker = async (result: ProcessReconciliationResult): Promise<void> => {
    if (result.unresolved.length > 0 && !blocker) {
      blocker = await processManager.resourceLeases.acquire({
        accesses: [{ mode: 'execute', scope: 'workspace/processes' }],
        lockScopes: ['workspace/files'],
        idempotency: 'non_idempotent'
      }, 'unresolved-process-reconciliation');
    }
    if (result.unresolved.length === 0 && blocker) { blocker.release(); blocker = undefined; }
  };
  const deliverRecovered = async (): Promise<void> => {
    if (!options.deliverRecoveredTerminalReport) return;
    for (const report of processManager.recoveredTerminalReports()) {
      if (await options.deliverRecoveredTerminalReport(report)) await processManager.markTerminalReported(report.result.processId);
    }
  };
  return Object.freeze({
    tools,
    services,
    capabilities: Object.freeze([...processManager.capabilities()]),
    artifactRepository,
    processManager,
    async ready() { await ensureBlocker(await reconciliation); await deliverRecovered(); },
    reconciliation: () => reconciliation,
    async resolveReconciliation(input: { readonly acknowledgeProcessIds?: readonly string[] } = {}) {
      if (input.acknowledgeProcessIds?.length) await processManager.acknowledgeUnresolvedProcesses(input.acknowledgeProcessIds);
      reconciliation = processManager.retryOrphanReconciliation();
      const result = await reconciliation;
      await ensureBlocker(result);
      await deliverRecovered();
      return result;
    },
    async close() { blocker?.release(); blocker = undefined; await processManager.close(); }
  });
}

function selectTools(tools: readonly ToolDefinition[], enabled: readonly string[] | undefined): readonly ToolDefinition[] {
  if (!enabled) return tools;
  const known = new Set(tools.map((tool) => tool.name));
  const unknown = enabled.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown configured local tools: ${unknown.join(', ')}.`);
  return Object.freeze(tools.filter((tool) => enabled.includes(tool.name)));
}
