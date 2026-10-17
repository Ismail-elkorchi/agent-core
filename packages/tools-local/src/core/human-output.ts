import { renderCommandOutput } from '@agent-core/tools';
import { searchPassages } from './search-passages.js';
import { processOutputSchema } from '../tools/process-output.js';
import { readFilesOutputSchema } from '../tools/read-files/schema.js';
import { searchTextOutputSchema } from '../tools/search-text/schema.js';
import { applyPatchOutputSchema } from '../tools/apply-patch/schema.js';
import { editTextOutputSchema } from '../tools/edit-text/schema.js';
import { readArtifactOutputSchema } from '../tools/read-artifact/schema.js';
import { listDirectoryOutputSchema } from '../tools/list-directory/schema.js';
import { findFilesOutputSchema } from '../tools/find-files/schema.js';

/** Human rendering of local-tool structured facts; independent of model content. */
export function renderLocalToolObservation(
  toolName: string,
  observation: {
    readonly kind: 'result' | 'failure';
    readonly output?: unknown;
  }
):
  | {
      readonly status?: 'running' | 'complete' | 'failed' | 'warning';
      readonly details: readonly {
        readonly id: string;
        readonly content: string;
      }[];
    }
  | undefined {
  if (observation.kind !== 'result') return undefined;
  let content: string | undefined;
  let status: 'running' | 'complete' | 'failed' | 'warning' | undefined;
  switch (toolName) {
    case 'exec_command':
    case 'write_stdin':
    case 'stop_process': {
      const output = processOutputSchema.parse(observation.output);
      const { combined } = output;
      content = [
        `Process ${output.processId} · ${output.status}`,
        ...(output.finalizationPending ? ['Terminal receipt finalization is pending'] : []),
        ...(output.exitCode === undefined ? [] : [`Exit code: ${String(output.exitCode)}`]),
        `Output cursor ${String(output.cursorStart)}–${String(output.cursorEnd)}`,
        ...(combined.omittedBytes ? [`${String(combined.omittedBytes)} output bytes omitted`] : []),
        ...(typeof output.diagnostic === 'string' ? [output.diagnostic] : []),
        renderCommandOutput(combined)
      ].join('\n');
      status = output.finalizationPending ? 'warning' :
        output.status === 'running'
          ? 'running'
          : output.status === 'exited'
            ? output.exitCode === 0
              ? 'complete'
              : 'failed'
            : output.status === 'failed' || output.status === 'timed_out'
              ? 'failed'
              : 'complete';
      break;
    }
    case 'read_files': {
      const output = readFilesOutputSchema.parse(observation.output);
      content = output.files
        .map((file) => {
          const source = file.content;
          const start = file.startLine;
          return `${file.path} · line ${String(start)}\n${source
            .split('\n')
            .map((line, index) => `${String(start + index)} │ ${line}`)
            .join('\n')}`;
        })
        .join('\n\n');
      if (output.failures.length)
        content += `\n${output.failures.map((failure) => `${failure.path}: ${failure.message}`).join('\n')}`;
      if (output.coverage === 'partial') content += '\nCoverage: partial';
      break;
    }
    case 'search_text': {
      const output = searchTextOutputSchema.parse(observation.output);
      content = (
        output.mode === 'matches'
          ? searchPassages(output.results).map((passage) => `${passage.header}\n${passage.text}`)
          : output.mode === 'files'
            ? output.results
            : output.results.map(
                (item) =>
                  `${item.path}: ${String(item.matchingLineCount)} matching lines · ${String(item.occurrenceCount)} occurrences`
              )
      ).join('\n');
      content += `\nResult coverage: ${output.resultCoverage}`;
      break;
    }
    case 'apply_patch':
    case 'edit_text': {
      const output =
        toolName === 'apply_patch'
          ? applyPatchOutputSchema.parse(observation.output)
          : editTextOutputSchema.parse(observation.output);
      content = [
        `${output.applicationStatus.replaceAll('_', ' ')} · filesystem state ${output.rootState}`,
        ...output.files.map((file) =>
          'operation' in file
            ? `${file.operation} ${file.path}${file.destinationPath ? ` → ${file.destinationPath}` : ''} · +${String(file.additions)} −${String(file.deletions)} · ${file.finalState}`
            : `${file.path} · ${String(file.changedRanges.length)} edited ranges · ${file.finalState}`
        ),
        ...('diffSummary' in output
          ? [
              output.diffSummary.text,
              ...(output.diffSummary.truncated
                ? ['Comparison excerpt; inspect original sources for the complete change.']
                : [])
            ]
          : [])
      ].join('\n');
      const transaction = output.transaction;
      if (transaction !== undefined) {
        content += `\nTransaction: ${transaction.outcome.replaceAll('_', ' ')}`;
        if ('failure' in transaction)
          content += `\n${transaction.failure.path}: ${transaction.failure.message}`;
        const recovery = 'rollback' in transaction ? transaction.rollback : transaction.cleanup;
        if (recovery !== undefined)
          content += `\n${[
            ...recovery.diagnostics.map((item) => `${item.action} ${item.path}: ${item.message}`),
            ...recovery.strandedPaths.map((path) => `Requires recovery: ${path}`)
          ].join('\n')}`;
      }
      status =
        output.rootState === 'uncertain' || output.applicationStatus === 'not_applied'
          ? 'warning'
          : 'complete';
      break;
    }
    case 'read_artifact': {
      const output = readArtifactOutputSchema.parse(observation.output);
      content = `${JSON.stringify(output.returnedRange)} · ${output.coverage}\n${typeof output.text === 'string' ? output.text : JSON.stringify(output.artifact)}`;
      break;
    }
    case 'list_directory':
    case 'find_files': {
      const output =
        toolName === 'list_directory'
          ? listDirectoryOutputSchema.parse(observation.output)
          : findFilesOutputSchema.parse(observation.output);
      content = output.entries.map((entry) => entry.path).join('\n');
      content += `\nCoverage: ${output.coverage}`;
      break;
    }
    default:
      return undefined;
  }
  return {
    ...(status ? { status } : {}),
    details: [{ id: 'output', content: bounded(content) }]
  };
}
function bounded(text: string): string {
  return text.length <= 32768
    ? text
    : `${text.slice(0, 32768)}\n[Display excerpt; inspect the original observation for the remaining content.]`;
}
