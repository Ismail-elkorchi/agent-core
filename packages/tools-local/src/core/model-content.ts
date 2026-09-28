import {
  defaultToolModelContent,
  renderCommandOutput,
  type ToolContent,
  type ToolModelContentRequest
} from '@agent-core/tools';
import type { ReadFilesOutput } from '../tools/read-files/schema.js';
import type { ProcessOutput } from '../tools/process-output.js';
import type { ReadArtifactOutput } from '../tools/read-artifact/schema.js';
import type { SearchTextOutput } from '../tools/search-text/schema.js';
import type * as z from 'zod';
import type { ApplyPatchOutput } from '../tools/apply-patch/schema.js';
import type { EditTextOutput } from '../tools/edit-text/schema.js';
import { searchPassages } from './search-passages.js';
import type { findFilesOutputSchema } from '../tools/find-files/schema.js';
import type { listDirectoryOutputSchema } from '../tools/list-directory/schema.js';

type PathSelectionOutput = z.output<typeof findFilesOutputSchema> | z.output<typeof listDirectoryOutputSchema>;

const text = (value: string): ToolContent => ({ type: 'text', text: value });
const json = (value: unknown): string => JSON.stringify(value);

export function buildPathSelectionContent({
  observation
}: ToolModelContentRequest<unknown, PathSelectionOutput>): readonly ToolContent[] {
  if (observation.kind === 'failure') return defaultToolModelContent(observation);
  const output: PathSelectionOutput = observation.output;
  const { entries, ...facts } = output;
  return [
    text(json(facts)),
    text(entries.map(({ path, type, ...metadata }) =>
      `${json(path)} (${type})${Object.keys(metadata).length ? ` ${json(metadata)}` : ''}`
    ).join('\n'))
  ];
}

export function buildReadFilesContent({
  observation
}: ToolModelContentRequest<unknown, ReadFilesOutput>): readonly ToolContent[] {
  if (observation.kind === 'failure') return defaultToolModelContent(observation);
  const output: ReadFilesOutput = observation.output;
  return [
    text(`Requested file ranges: ${output.coverage}. Returned ${String(output.returnedFiles)} of ${String(output.requestedFiles)}.`),
    ...(output.failures.length ? [text(json({ failures: output.failures }))] : []),
    ...output.files.flatMap(({ content, eof, truncated, ...source }) => [
      text(`${json(source)}\n${eof ? 'Range reaches end of file.' : 'More file content follows.'}${truncated ? ' File content is partial.' : ''}`),
      text(content)
    ])
  ];
}

export function buildProcessContent({
  observation
}: ToolModelContentRequest<unknown, ProcessOutput>): readonly ToolContent[] {
  if (observation.kind === 'failure') return defaultToolModelContent(observation);
  const output: ProcessOutput = observation.output;
  const { combined, artifact, originalOutput } = output;
  const partial = !combined.startsAtOutputStart || !combined.endsAtOutputEnd || combined.omittedBytes > 0;
  return [
    text(json({
      status: output.status,
      ...(output.exitCode === undefined ? {} : { exitCode: output.exitCode }),
      ...(output.signal ? { signal: output.signal } : {}),
      ...(output.diagnostic ? { diagnostic: output.diagnostic } : {}),
      outputCoverage: partial ? 'partial' : 'complete',
      ...(output.status === 'running' || partial ? {
        processId: output.processId, cursorStart: output.cursorStart, cursorEnd: output.cursorEnd
      } : {}),
      ...(output.cursorExpired ? { cursorExpired: true } : {}),
      ...(partial ? { observedBytes: combined.observedBytes, capturedBytes: combined.capturedBytes, omittedBytes: combined.omittedBytes } : {}),
      ...(originalOutput?.kind === 'unavailable' || (originalOutput?.kind === 'captured' && originalOutput.omittedBytes > 0) ? { originalOutput } : {}),
      ...(partial && artifact ? { artifact } : {})
    })),
    ...(combined.segments.length || combined.observedBytes ? [text(renderCommandOutput(combined))] : [])
  ];
}

export function buildReadArtifactContent({
  observation
}: ToolModelContentRequest<unknown, ReadArtifactOutput>): readonly ToolContent[] {
  if (observation.kind === 'failure') return defaultToolModelContent(observation);
  const output: ReadArtifactOutput = observation.output;
  const { text: source, ...facts } = output;
  return [
    text(json(facts)),
    ...(source === undefined ? (observation.content ?? []) : [text(source)])
  ];
}

export function buildSearchTextContent({
  observation
}: ToolModelContentRequest<unknown, SearchTextOutput>): readonly ToolContent[] {
  if (observation.kind === 'failure') return defaultToolModelContent(observation);
  const output: SearchTextOutput = observation.output;
  const { mode, results, query, status, resultCoverage, countCoverage, diagnostic,
    examinedFileCount, matchingFileCount, matchingLineCount, occurrenceCount,
    omittedResultCount, countsCapped, omittedResultCountIsLowerBound, outputTruncated, perFileOmissions } = output;
  const facts = text(json({
    query, status, resultCoverage, countCoverage,
    examinedFileCount, matchingFileCount, matchingLineCount, occurrenceCount,
    ...(diagnostic ? { diagnostic } : {}),
    ...(omittedResultCount > 0 ? { omittedResultCount, omittedResultCountIsLowerBound } : {}),
    ...(countsCapped ? { countsCapped } : {}),
    ...(outputTruncated ? { outputTruncated } : {}),
    ...(perFileOmissions.length ? { perFileOmissions } : {})
  }));
  if (mode !== 'matches') return [facts, text(json(results))];
  return [facts, ...searchPassages(output.results).flatMap((passage) => [text(passage.header), text(passage.text)])];
}

export function buildMutationContent<Output extends ApplyPatchOutput | EditTextOutput>({ observation }: ToolModelContentRequest<unknown, Output>): readonly ToolContent[] {
  if (observation.kind === 'failure') return defaultToolModelContent(observation);
  const output = observation.output;
  return [
    text(`${output.applicationStatus}; workspace state ${output.rootState}.`),
    ...output.files.map((file) => text(json('operation' in file ? {
      path: file.path, operation: file.operation, finalState: file.finalState,
      ...(file.destinationPath ? { destinationPath: file.destinationPath } : {}),
      ...(output.dryRun ? { plannedChange: file.plannedChange } : {}),
      oldSha256: file.oldSha256, newSha256: file.newSha256,
      additions: file.additions, deletions: file.deletions,
      ...(file.exact === false ? { exact: false, matchModes: file.matchModes } : {})
    } : {
      path: file.path, finalState: file.finalState,
      ...(output.dryRun ? { plannedChange: file.changed } : {}),
      oldSha256: file.oldSha256, newSha256: file.newSha256,
      changedRanges: file.changedRanges
    }))),
    ...(output.transaction && output.transaction.outcome !== 'committed' ? [text(json({ transaction: output.transaction }))] : []),
    ...(output.potentiallyAffectedPaths.length ? [text(json({ potentiallyAffectedPaths: output.potentiallyAffectedPaths }))] : []),
    ...(observation.scope.coverage === 'partial' ? [text(json({
      coverage: observation.scope.coverage,
      omitted: observation.scope.omitted,
      causes: observation.scope.causes
    }))] : [])
  ];
}
