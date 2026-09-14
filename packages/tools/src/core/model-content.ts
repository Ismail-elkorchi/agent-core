import type { JsonValue } from '@agent-core/json';
import type { ToolCall, ToolContent, ToolObservation } from './definition.js';
import { encodeToolFailureOutput } from './observation.js';

/** A derived representation of the original observation, selected once for delivery. */
export interface ToolModelContentRequest<TInput = unknown, TOutput = unknown> {
  readonly call: ToolCall;
  readonly input: TInput | JsonValue | undefined;
  readonly observation: ToolObservation<TOutput>;
}

/** Plain tools need no formatter. Structured output remains useful original information. */
export function defaultToolModelContent(observation: ToolObservation): readonly ToolContent[] {
  return Object.freeze([
    Object.freeze({
      type: 'text' as const,
      text:
        observation.kind === 'failure'
          ? `${observation.summary}\n${JSON.stringify(encodeToolFailureOutput(observation.output), null, 2)}`
          : typeof observation.output === 'string'
            ? observation.output
            : JSON.stringify(observation.output, null, 2)
    }),
    ...(observation.execution
      ? [
          Object.freeze({
            type: 'text' as const,
            text: `Execution state: ${observation.execution.state}.`
          })
        ]
      : []),
    ...(observation.content ?? [])
  ]);
}

export function serializeToolModelContent(content: readonly ToolContent[]): string {
  return content
    .flatMap((part) =>
      part.type === 'text'
        ? [part.text]
        : part.type === 'artifact'
          ? [JSON.stringify({ artifact: part.artifact })]
          : []
    )
    .join('\n\n');
}
