import type { CommandOutputView } from './command-execution.js';

/** Byte counts describe capture coverage; presentation markers are not captured bytes. */
export function createCommandOutputView(
  input: Omit<CommandOutputView, 'omittedBytes'>
): CommandOutputView {
  return Object.freeze({
    ...input,
    segments: Object.freeze(input.segments.filter((segment) => segment.length > 0)),
    omittedBytes: Math.max(0, input.observedBytes - input.capturedBytes)
  });
}

/** Render gaps where they occur, without making markers part of the captured source. */
export function renderCommandOutput(view: CommandOutputView): string {
  if (view.segments.length === 0)
    return view.observedBytes > 0 ? '[No output included in this view.]' : '';
  return [
    ...(!view.startsAtOutputStart ? ['[Earlier output not included.]'] : []),
    view.segments.join('\n[... output omitted ...]\n'),
    ...(!view.endsAtOutputEnd ? ['[Later output not included.]'] : [])
  ].join('\n');
}
