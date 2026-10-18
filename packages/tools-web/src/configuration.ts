import * as z from 'zod';
import type { WebConfiguration } from './contracts.js';
import type { ArtifactRepository } from '@agent-core/persistence';
import { createWebTools } from './definitions.js';
import { createWebPolicy, webPolicyInputSchema } from './policy.js';
import { createNodeWebTransport } from './node-transport.js';
import { createBraveSearchAdapter } from './brave.js';

export const webConfigurationSchema = z.strictObject({
  policy: webPolicyInputSchema,
  search: z.strictObject({
    provider: z.literal('brave'),
    credentialEnvironmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).max(128)
  }).optional()
});
export type { WebConfiguration } from './contracts.js';
/** Parse explicit application configuration. It contains an environment-variable name, never a secret. */
export function parseWebConfiguration(value: unknown): WebConfiguration {
  const configuration = webConfigurationSchema.parse(value);
  const policy = createWebPolicy(configuration.policy);
  return Object.freeze({ policy: Object.freeze({ id: policy.id, limits: policy.limits,
    ...(policy.allowedOrigins === undefined ? {} : { allowedOrigins: policy.allowedOrigins }) }),
    ...(configuration.search === undefined ? {} : { search: Object.freeze(configuration.search) }) });
}
/** Construct real services only after an explicit opt-in configuration. Missing requested credentials fail precisely. */
export function createConfiguredWebTools(configuration: WebConfiguration, host: {
  readonly artifacts: ArtifactRepository;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}) {
  const value = parseWebConfiguration(configuration);
  const transport = createNodeWebTransport();
  if (!value.search) return createWebTools({ policy: value.policy, artifacts: host.artifacts, transport });
  const environment = host.environment ?? process.env;
  const apiKey = environment[value.search.credentialEnvironmentVariable];
  if (!apiKey?.trim()) throw new Error(`Brave search is configured but environment variable ${value.search.credentialEnvironmentVariable} is missing or empty.`);
  const search = createBraveSearchAdapter({ apiKey, transport });
  return createWebTools({ policy: value.policy, artifacts: host.artifacts, transport, search });
}
