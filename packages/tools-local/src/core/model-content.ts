import {
  defaultToolModelContent,
  type ToolContent,
  type ToolDefinition,
  type ToolModelContentRequest,
  type ToolObservation
} from '@agent-core/tools';
import type { ReadFilesOutput } from '../tools/read-files/schema.js';
import type { ProcessOutput } from '../tools/process-output.js';
import type { ReadArtifactOutput } from '../tools/read-artifact/schema.js';
import type { SearchTextOutput } from '../tools/search-text/schema.js';

const text = (value: string): ToolContent => ({ type: 'text', text: value });
const json = (value: unknown): string => JSON.stringify(value, null, 2);

export function buildReadFilesContent({
  observation
}: ToolModelContentRequest<unknown, ReadFilesOutput>): readonly ToolContent[] {
  if (observation.kind === 'failure') return defaultToolModelContent(observation);
  const output: ReadFilesOutput = observation.output;
  const { files, ...facts } = output;
  return [
    text(json(facts)),
    ...files.flatMap(({ content, ...source }) => [text(json(source)), text(content)])
  ];
}

export function buildProcessContent({
  observation
}: ToolModelContentRequest<unknown, ProcessOutput>): readonly ToolContent[] {
  if (observation.kind === 'failure') return defaultToolModelContent(observation);
  const output: ProcessOutput = observation.output;
  const modelFacts = Object.fromEntries(
    Object.entries(output).filter(
      ([key]) =>
        ![
          'owner',
          'stdout',
          'stderr',
          'combined',
          'progressDroppedEvents',
          'progressDeliveryErrors'
        ].includes(key)
    )
  );
  const { combined } = output;
  const { text: log, ...coverage } = combined;
  return [text(json({ ...modelFacts, ...coverage })), text(log)];
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
  const facts = Object.fromEntries(Object.entries(output).filter(([key]) => key !== 'results'));
  if (output.mode !== 'matches') return [text(json(facts)), text(json(output.results))];
  return [
    text(json(facts)),
    ...output.results.flatMap(({ text: source, ...location }) => [
      text(json(location)),
      text(source)
    ])
  ];
}

export const buildApplyPatchContent: NonNullable<ToolDefinition['buildModelContent']> = ({
  observation
}) => mutationContent(observation);
export const buildEditTextContent: NonNullable<ToolDefinition['buildModelContent']> = ({
  observation
}) => mutationContent(observation);

function mutationContent(observation: ToolObservation): readonly ToolContent[] {
  return [
    ...defaultToolModelContent(observation),
    ...(observation.scope.coverage === 'partial'
      ? [
          text(
            json({
              coverage: observation.scope.coverage,
              omitted: observation.scope.omitted,
              causes: observation.scope.causes
            })
          )
        ]
      : [])
  ];
}
