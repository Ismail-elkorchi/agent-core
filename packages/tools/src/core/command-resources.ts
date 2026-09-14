import { parseJsonObject } from '@agent-core/json';
import type { CommandExecution, CommandExecutionReport, CommandOutputView } from './command-execution.js';
import type { ExecutionResources, ResourceLifetime, ResourceReleaseReport } from './execution-resources.js';

/** Keep process termination and output handling in the command integration. */
export function commandExecutionResources(
  command: CommandExecution,
  lifetime: ResourceLifetime = { kind: 'run' }
): ExecutionResources {
  return Object.freeze({
    lifetime: Object.freeze({ ...lifetime }),
    capabilities: command.descriptor.capabilities,
    resourceLeases: command.resourceLeases,
    async release(ownerId: string) {
      return Object.freeze((await command.disposeOwner(ownerId)).map(commandReleaseReport));
    },
    acknowledge: (resourceId: string) => command.acknowledgeTerminalReport(resourceId)
  });
}

export function commandReleaseReport(report: CommandExecutionReport): ResourceReleaseReport {
  const result = report.result;
  return Object.freeze({
    resourceId: result.processId,
    outcome: result.status === 'running' ? 'unknown' : 'released',
    details: parseJsonObject({
      status: result.status,
      owner: result.owner,
      cursorEnd: result.cursorEnd,
      stdout: outputCounts(result.stdout),
      stderr: outputCounts(result.stderr),
      combined: outputCounts(result.combined),
      ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
      ...(result.originalOutput === undefined ? {} : { originalOutput: result.originalOutput }),
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      ...(report.protectedArtifact === undefined ? {} : { protectedArtifact: report.protectedArtifact })
    })
  });
}

function outputCounts(output: CommandOutputView) {
  return Object.freeze({
    observedBytes: output.observedBytes,
    capturedBytes: output.capturedBytes,
    omittedBytes: output.omittedBytes
  });
}
