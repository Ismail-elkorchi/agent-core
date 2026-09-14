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
      readonly details: readonly { readonly id: string; readonly content: string }[];
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
        ...(output.exitCode === undefined ? [] : [`Exit code: ${String(output.exitCode)}`]),
        `Output cursor ${String(output.cursorStart)}–${String(output.cursorEnd)}`,
        ...(combined.omittedBytes ? [`${String(combined.omittedBytes)} output bytes omitted`] : []),
        ...(typeof output.diagnostic === 'string' ? [output.diagnostic] : []),
        combined.text
      ].join('\n');
      status =
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
      if (output.failures.length) content += `\n${JSON.stringify(output.failures, null, 2)}`;
      if (output.coverage === 'partial') content += '\nCoverage: partial';
      break;
    }
    case 'search_text': {
      const output = searchTextOutputSchema.parse(observation.output);
      content = (
        output.mode === 'matches'
          ? output.results.map((item) => `${item.path}:${String(item.lineNumber)}\n${item.text}`)
          : output.results.map((item) => JSON.stringify(item))
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
      content = `${output.applicationStatus} · root ${output.rootState}\n${JSON.stringify(output.files, null, 2)}`;
      if (output.transaction !== undefined)
        content += `\n${JSON.stringify(output.transaction, null, 2)}`;
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
