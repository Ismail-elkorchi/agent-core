import type { JsonValue } from '@agent-core/json';
import type { ToolCall, ToolContent, ToolObservation } from './definition.js';
import { encodeToolFailureOutput } from './observation.js';

/** A derived representation of the original observation, selected once for delivery. */
export interface ToolModelContentRequest<TInput = unknown, TOutput = unknown> {
  readonly call: ToolCall;
  readonly input: TInput | JsonValue | undefined;
  readonly observation: ToolObservation<TOutput>;
}

/** Select payload content. The delivery boundary adds authoritative observation facts. */
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
    ...(observation.content ?? [])
  ]);
}

/** Coverage of delivery relative to the selected presentation, not the tool's scope. */
export type ToolModelPresentationCoverage =
  | { readonly coverage: 'complete' }
  | { readonly coverage: 'partial'; readonly causes: readonly string[] };

/**
 * These facts belong to the shared delivery boundary, outside replaceable formatters.
 * Append them after selected payload content and reserve them when bounding delivery.
 * Complete settled results preserve the selected payload contract without a notice.
 * Incomplete scope, delivery, and unsettled execution cannot be hidden by a formatter.
 */
export function toolModelContentFacts(
  observation: ToolObservation,
  presentation: ToolModelPresentationCoverage
): readonly ToolContent[] {
  const discloseCoverage = observation.scope.coverage === 'partial' ||
    presentation.coverage === 'partial' || observation.kind === 'failure';
  if (!discloseCoverage && (!observation.execution || observation.execution.state === 'settled'))
    return Object.freeze([]);
  const { coverage, ...scope } = observation.scope;
  return Object.freeze([Object.freeze({
    type: 'text' as const,
    text: [
      ...(discloseCoverage ? [
        `Original result coverage: ${coverage}. Original scope: ${JSON.stringify(scope)}.`,
        `Presentation coverage: ${presentation.coverage}.${presentation.coverage === 'partial'
          ? ` Presentation omission causes: ${JSON.stringify(presentation.causes)}.` : ''}`
      ] : []),
      `Invocation disposition: ${observation.kind}; execution state: ${observation.execution?.state ?? 'not established'}.`
    ].join('\n')
  })]);
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
