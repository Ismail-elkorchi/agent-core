import { defaultToolModelContent, type ToolModelContentRequest } from '../core/model-content.js';
import type { ToolContent } from '../core/definition.js';
import type { ReadArtifactOutput } from './schema.js';

const text = (value: string): ToolContent => ({ type: 'text', text: value });
const json = (value: unknown): string => JSON.stringify(value);

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
