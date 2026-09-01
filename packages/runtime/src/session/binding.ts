import { hashJson } from '@agent-core/persistence';
import { normalizeJsonSafe, parseJsonObject, type JsonValue } from '@agent-core/json';

export interface SessionBindingInput {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly subject: JsonValue;
}

export interface SessionBinding extends SessionBindingInput {
  readonly bindingSha256: string;
}

export class SessionBindingMismatchError extends Error {
  constructor(
    readonly expectedBindingSha256: string,
    readonly storedBindingSha256: string,
    readonly expectedSchemaId: string,
    readonly storedSchemaId: string
  ) {
    super(`Session binding mismatch: expected ${expectedSchemaId}/${expectedBindingSha256}, stored ${storedSchemaId}/${storedBindingSha256}.`);
    this.name = 'SessionBindingMismatchError';
  }
}

export function createSessionBinding(input: SessionBindingInput): SessionBinding {
  const schemaId = sessionBindingSchemaId(input.schemaId);
  const schemaVersion = sessionBindingSchemaVersion(input.schemaVersion);
  const subject = normalizeJsonSafe(input.subject).value;
  const canonical = Object.freeze({ schemaId, schemaVersion, subject });
  return Object.freeze({ ...canonical, bindingSha256: hashJson(canonical) });
}

export function decodeSessionBinding(value: unknown): SessionBinding {
  const object = parseJsonObject(value);
  const fields = Object.keys(object);
  if (fields.length !== 4 || !fields.every((field) => field === 'schemaId' || field === 'schemaVersion' || field === 'subject' || field === 'bindingSha256')) {
    throw new TypeError('Session binding has unsupported or missing fields.');
  }
  if (object.subject === undefined) throw new TypeError('Session binding subject is required.');
  const binding = createSessionBinding({
    schemaId: sessionBindingSchemaId(object.schemaId),
    schemaVersion: sessionBindingSchemaVersion(object.schemaVersion),
    subject: object.subject
  });
  if (object.bindingSha256 !== binding.bindingSha256) throw new TypeError('Session binding hash is invalid.');
  return binding;
}

export function sameSessionBinding(left: SessionBindingInput, right: SessionBindingInput): boolean {
  const leftBinding = createSessionBinding(left);
  const rightBinding = createSessionBinding(right);
  return leftBinding.schemaId === rightBinding.schemaId
    && leftBinding.schemaVersion === rightBinding.schemaVersion
    && leftBinding.bindingSha256 === rightBinding.bindingSha256;
}

export function assertSessionBinding(expected: SessionBindingInput, stored: SessionBinding): void {
  const canonicalExpected = createSessionBinding(expected);
  const canonicalStored = createSessionBinding(stored);
  if (stored.bindingSha256 !== canonicalStored.bindingSha256 || !sameSessionBinding(canonicalExpected, canonicalStored)) {
    throw new SessionBindingMismatchError(
      canonicalExpected.bindingSha256,
      stored.bindingSha256,
      canonicalExpected.schemaId,
      stored.schemaId
    );
  }
}

function sessionBindingSchemaId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > 512 || hasControlCharacter(value)) {
    throw new TypeError('Session binding schemaId must be a non-empty stable identifier.');
  }
  return value;
}

function sessionBindingSchemaVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Session binding schemaVersion must be a positive safe integer.');
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 31 || unit === 127) return true;
  }
  return false;
}
