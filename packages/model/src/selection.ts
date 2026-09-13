import { parseJsonObject } from '@agent-core/json';
import type { ModelSelection } from './index.js';
import { parseModelReasoningRequest } from './validation.js';

/** Captures a complete user selection at a wire or persistence boundary. */
export function parseModelSelection(input: unknown): ModelSelection {
  const value = parseJsonObject(input, { maxTotalBytes: 64 * 1024 });
  if (
    Object.keys(value).some(
      (key) => !['provider', 'model', 'endpoint', 'reasoning', 'temperature'].includes(key)
    )
  )
    throw new TypeError('Unknown model selection field.');
  if (
    typeof value.provider !== 'string' ||
    !value.provider.trim() ||
    typeof value.model !== 'string' ||
    !value.model.trim()
  )
    throw new TypeError('A model selection requires a provider and model.');
  if (value.endpoint !== undefined && (typeof value.endpoint !== 'string' || !value.endpoint.trim()))
    throw new TypeError('The endpoint must be a nonempty URL.');
  if (
    value.temperature !== undefined &&
    (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature))
  )
    throw new TypeError('Temperature must be a finite number.');
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    ...(value.endpoint === undefined ? {} : { endpoint: value.endpoint }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.reasoning === undefined ? {} : { reasoning: parseModelReasoningRequest(value.reasoning) })
  });
}
