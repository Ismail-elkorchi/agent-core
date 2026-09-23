import type { ArtifactRepository } from '@agent-core/persistence';
import { adoptCommandExecution, isWorkspaceFiles, type CommandExecution, type CompiledToolDefinition, type WorkspaceFiles } from '@agent-core/tools';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, parseLocalToolConfiguration, type LocalToolConfiguration } from './configuration.js';
import { readFilesTool } from '../tools/read-files/definition.js';
import { editTextTool } from '../tools/edit-text/definition.js';
import { applyPatchTool } from '../tools/apply-patch/definition.js';
import { viewImageTool } from '../tools/view-image/definition.js';
import { searchTextTool } from '../tools/search-text/definition.js';
import { findFilesTool } from '../tools/find-files/definition.js';
import { listDirectoryTool } from '../tools/list-directory/definition.js';
import { createExecCommandTool } from '../tools/exec-command/definition.js';
import { readArtifactTool } from '../tools/read-artifact/definition.js';
import { stopProcessTool } from '../tools/stop-process/definition.js';
import { writeStdinTool } from '../tools/write-stdin/definition.js';

export interface WorkspaceToolHost {
  readonly tools: readonly CompiledToolDefinition[];
  readonly services: Readonly<Record<string, unknown>>;
}

/** Compose tools over one workspace and its native transaction authority. */
export function createWorkspaceToolHost(options: {
  readonly files: WorkspaceFiles;
  readonly artifacts: ArtifactRepository;
  readonly commandExecution?: CommandExecution;
  readonly enabledTools: readonly string[];
  readonly configuration?: LocalToolConfiguration;
}): WorkspaceToolHost {
  if (!isWorkspaceFiles(options.files)) throw new TypeError('Workspace tool host requires an adopted file authority.');
  const configuration = options.configuration === undefined
    ? DEFAULT_LOCAL_TOOL_CONFIGURATION : parseLocalToolConfiguration(options.configuration);
  const commandExecution = options.commandExecution === undefined
    ? undefined : adoptCommandExecution(options.commandExecution);
  if (!commandExecution && options.enabledTools.some((name) =>
    name === 'exec_command' || name === 'write_stdin' || name === 'stop_process'))
    throw new Error('Workspace process tools require a command authority.');
  const services = Object.freeze({
    workspaceFiles: options.files,
    artifactRepository: options.artifacts,
    localToolConfiguration: configuration,
    ...(commandExecution ? { commandExecution } : {})
  });
  const all = Object.freeze([
    listDirectoryTool,
    findFilesTool,
    readFilesTool,
    searchTextTool,
    editTextTool,
    applyPatchTool,
    ...(commandExecution
      ? [
          createExecCommandTool({
            ptySupported: commandExecution.descriptor.supportsPty,
            environmentLifetimeSupported:
              commandExecution.descriptor.capabilities.includes('environment-lifetime')
          })
        ]
      : []),
    writeStdinTool,
    stopProcessTool,
    viewImageTool,
    readArtifactTool
  ]);
  const known = new Set(all.map((tool) => tool.name));
  const unknown = options.enabledTools.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown workspace tools: ${unknown.join(', ')}.`);
  const tools = Object.freeze(all.filter((tool) => options.enabledTools.includes(tool.name)));
  return Object.freeze({
    tools,
    services
  });
}
