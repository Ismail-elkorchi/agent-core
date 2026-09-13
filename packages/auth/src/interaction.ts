import type { CredentialStore } from './index.js';

export type ProviderAuthentication =
  | {
      readonly kind: 'api_key';
      readonly externalSource?: string;
      save(secret: string, signal: AbortSignal): Promise<void>;
      logout(): Promise<void>;
    }
  | {
      readonly kind: 'device_code';
      begin(signal: AbortSignal): Promise<DeviceAuthenticationChallenge>;
      logout(): Promise<void>;
    };

export interface DeviceAuthenticationChallenge {
  readonly url: string;
  readonly code: string;
  complete(signal: AbortSignal): Promise<void>;
}

export function apiKeyAuthentication(
  store: CredentialStore,
  key: string,
  environmentVariable: string
): ProviderAuthentication {
  return {
    kind: 'api_key',
    ...(process.env[environmentVariable] ? { externalSource: environmentVariable } : {}),
    async save(secret, signal) {
      signal.throwIfAborted();
      if (!secret.trim()) throw new Error('An API key is required.');
      await store.write(key, { token: secret.trim() });
    },
    logout: () => store.delete(key)
  };
}
