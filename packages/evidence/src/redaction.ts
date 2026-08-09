import { parseJsonValue, type JsonValue, type SafeJsonParseLimits } from '@agent-core/json';

export interface RedactedJson {
  readonly value: JsonValue;
  readonly redactions: number;
}

/** Apply the shared durable/model-visible secret redaction policy to owned JSON. */
export function redactJson(value: unknown, limits: Partial<SafeJsonParseLimits> = {}): RedactedJson {
  const state = { redactions: 0 };
  const redacted = redactValue(parseJsonValue(value, limits), [], state);
  return Object.freeze({ value: parseJsonValue(redacted, limits), redactions: state.redactions });
}

function redactValue(value: JsonValue, pathParts: readonly string[], state: { redactions: number }): JsonValue {
  if (typeof value === 'string') return redactString(value, pathParts, state);
  if (Array.isArray(value)) return value.map((item, index) => redactValue(item, [...pathParts, String(index)], state));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, [...pathParts, key], state)]));
}

function redactString(value: string, pathParts: readonly string[], state: { redactions: number }): string {
  const key = pathParts.at(-1) ?? '';
  if (/(authorization|credential|password|secret|token|api[-_]?key)/iu.test(key) && value.length > 0) {
    state.redactions += 1;
    return '[REDACTED]';
  }
  const patterns = [
    /(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu,
    /(Basic\s+)[A-Za-z0-9+/=]+/giu,
    /(sk-(?:or-v1-)?[A-Za-z0-9_-]{16,})/gu,
    /(\b[A-Za-z_][A-Za-z0-9_]{0,127}(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]{0,127}=)[^\s]+/giu,
    /((?:password|secret|token|api[-_]?key)\s*[:=]\s*)[^\s,;]+/giu
  ];
  let result = value;
  for (const pattern of patterns) {
    result = result.replace(pattern, (_match: string, prefix?: string) => {
      state.redactions += 1;
      return prefix ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }
  return result;
}

/** Redact process-stream text while preserving UTF-16 length for deterministic chunk re-splitting. */
export function redactTextPreservingLength(value: string): { readonly text: string; readonly redactions: number } {
  let text = value;
  let redactions = 0;
  for (const pattern of secretPatterns()) {
    text = text.replace(pattern, (match: string) => {
      redactions += 1;
      const marker = '[REDACTED]';
      return marker.length >= match.length ? marker.slice(0, match.length) : marker + '*'.repeat(match.length - marker.length);
    });
  }
  return Object.freeze({ text, redactions });
}

function secretPatterns(): RegExp[] {
  return [
    /Bearer\s+[A-Za-z0-9._~+/=-]+/giu,
    /Basic\s+[A-Za-z0-9+/=]+/giu,
    /sk-(?:or-v1-)?[A-Za-z0-9_-]{16,}/gu,
    /\b[A-Za-z_][A-Za-z0-9_]{0,127}(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]{0,127}=[^\s]+/giu,
    /(?:password|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu
  ];
}
