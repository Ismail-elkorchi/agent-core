import { parseJsonObject } from '@agent-core/json';

/** Explicit host choice; endpoint capabilities still gate each requested mode. */
export interface NativeToolExposure {
  readonly discovery?: boolean;
  readonly programmatic?: boolean;
}

export function parseNativeToolExposure(value: unknown): NativeToolExposure {
  const input = parseJsonObject(value, { maxDepth: 2, maxCollectionEntries: 4, maxStringBytes: 100, maxTotalBytes: 500 });
  if (Object.keys(input).some(key => key !== 'discovery' && key !== 'programmatic') ||
      (input.discovery !== undefined && typeof input.discovery !== 'boolean') ||
      (input.programmatic !== undefined && typeof input.programmatic !== 'boolean') ||
      (input.discovery !== true && input.programmatic !== true))
    throw new TypeError('Native tool exposure requires discovery and/or programmatic set to true; no other fields are accepted.');
  return Object.freeze({
    ...(typeof input.discovery === 'boolean' ? { discovery: input.discovery } : {}),
    ...(typeof input.programmatic === 'boolean' ? { programmatic: input.programmatic } : {})
  });
}
