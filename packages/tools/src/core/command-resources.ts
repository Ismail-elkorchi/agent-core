import { parseJsonObject } from '@agent-core/json';
import type {
  CommandExecution,
  CommandExecutionReport
} from './command-execution.js';
import type {
  ExecutionResources,
  ResourceLifetime,
  ResourceReleaseReport
} from './execution-resources.js';

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
    outcome: result.status === 'running' || result.finalizationPending ? 'unknown' : 'released',
    ...(report.settlementReference ? { settlementReference: report.settlementReference } : {}),
    details: parseJsonObject({
      status: result.status,
      ...(result.finalizationPending ? { finalizationPending: true } : {}),
      owner: result.owner,
      cursorEnd: result.cursorEnd,
      // Receipt facts are independent of a query's output window and recovery diagnostics.
      stdout: report.terminalOutput?.stdout ?? { observedBytes: result.stdout.observedBytes },
      stderr: report.terminalOutput?.stderr ?? { observedBytes: result.stderr.observedBytes },
      combined: report.terminalOutput?.combined ?? { observedBytes: result.combined.observedBytes },
      ...(report.terminalDiagnostic === undefined ? {} : { diagnostic: report.terminalDiagnostic }),
      ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      ...(report.protectedArtifact === undefined
        ? {}
        : { protectedArtifact: report.protectedArtifact })
    })
  });
}
