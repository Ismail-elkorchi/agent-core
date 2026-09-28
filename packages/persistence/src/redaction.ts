import type { JsonObject, JsonValue } from '@agent-core/json';

export interface RedactedJson {
  readonly value: JsonValue;
  readonly redactions: number;
}

const marker = '[REDACTED]';
const credentialFields = new Set([
  'authorization', 'credential', 'credentials', 'password', 'apikey',
  'accesstoken', 'refreshtoken', 'authtoken', 'clientsecret', 'privatekey'
]);

/** Each expression captures only the credential, at the end of its match. */
function credentialPatterns(): RegExp[] {
  return [
    /\bAuthorization:[ \t]*Bearer[ \t]+([A-Za-z0-9._~+/=-]+)/giu,
    /\bAuthorization:[ \t]*Basic[ \t]+([A-Za-z0-9+/=]+)/giu,
    /\b(sk-(?:or-v1-)?[A-Za-z0-9_-]{16,})\b/gu,
    /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/gu,
    /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/gu,
    /(-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----)/gu,
    // Environment dumps have a line-oriented grammar. Source-language identifiers do not.
    /^(?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|KEY|API_KEY)=([^\r\n]+)/gmu
  ];
}

function masked(value: string): boolean {
  return /^(?:\[REDACTED\]\**|\*+)$/u.test(value);
}

function redactText(value: string, preserveLength: boolean): { text: string; redactions: number } {
  let redactions = 0;
  let text = value;
  for (const pattern of credentialPatterns()) {
    text = text.replace(pattern, (match: string, credential: string) => {
      if (masked(credential)) return match;
      redactions++;
      const replacement = preserveLength
        ? credential.length < marker.length
          ? '*'.repeat(credential.length)
          : marker.padEnd(credential.length, '*')
        : marker;
      return match.slice(0, match.length - credential.length) + replacement;
    });
  }
  return { text, redactions };
}

/** Redact explicit credential fields and recognizable credential syntax, not arbitrary source code. */
export function redactJson(value: string): RedactedJson & { readonly value: string };
export function redactJson(value: JsonObject): RedactedJson & { readonly value: JsonObject };
export function redactJson(value: JsonValue): RedactedJson;
export function redactJson(value: JsonValue): RedactedJson {
  let redactions = 0;
  const visit = (item: JsonValue, key = ''): JsonValue => {
    if (typeof item === 'string') {
      if (credentialFields.has(key.replace(/[-_]/gu, '').toLowerCase()) && item.length > 0 && !masked(item)) {
        redactions++;
        return marker;
      }
      const result = redactText(item, false);
      redactions += result.redactions;
      return result.text;
    }
    if (Array.isArray(item)) return Object.freeze(item.map((entry: JsonValue) => visit(entry)));
    if (item === null || typeof item !== 'object') return item;
    return Object.freeze(
      Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]))
    );
  };
  return Object.freeze({ value: visit(value), redactions });
}

/** Keep UTF-16 offsets stable when splitting a redacted process stream back into chunks. */
export function redactTextPreservingLength(value: string): { readonly text: string; readonly redactions: number } {
  return Object.freeze(redactText(value, true));
}
