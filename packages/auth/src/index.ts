import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type AuthSourceType = 'api_key' | 'oauth' | 'bearer' | 'command';

export interface AuthSourceInfo {
  type: AuthSourceType;
  label: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface BearerToken {
  token: string;
  issuedAt?: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface BearerTokenProvider {
  describe(): AuthSourceInfo;
  getBearerToken(signal?: AbortSignal): Promise<BearerToken>;
  invalidate?(reason?: string): Promise<void>;
}

export interface CredentialRecord extends BearerToken {
  refreshToken?: string;
  tokenType?: string;
  scopes?: string[];
}

export interface CredentialStore {
  read(key: string): Promise<CredentialRecord | undefined>;
  write(key: string, record: CredentialRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OAuthRefreshRequest {
  credentials: CredentialRecord;
  signal?: AbortSignal;
}

export interface OAuthTokenRefresher {
  describe(): AuthSourceInfo;
  refresh(request: OAuthRefreshRequest): Promise<CredentialRecord>;
}

export type DeviceCodePollResult<T> =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'complete'; value: T }
  | { status: 'failed'; message: string };

export interface DeviceCodePollOptions<T> {
  intervalSeconds: number;
  expiresInSeconds: number;
  signal?: AbortSignal;
  poll: () => Promise<DeviceCodePollResult<T>>;
}

export type ProviderAuth =
  | { type: 'api_key'; envVar: string; value?: string; label?: string }
  | { type: 'oauth'; provider: string; credentialStore: CredentialStore; key?: string; label?: string }
  | { type: 'bearer'; tokenProvider: BearerTokenProvider };

export type AuthErrorCode =
  | 'missing_credentials'
  | 'expired_credentials'
  | 'invalid_credentials'
  | 'io_error'
  | 'unsupported'
  | 'aborted';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly retryable: boolean;
  readonly source?: AuthSourceInfo;
  readonly causeValue: unknown;

  constructor(options: {
    code: AuthErrorCode;
    message: string;
    retryable?: boolean;
    source?: AuthSourceInfo;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = 'AuthError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    if (options.source) {
      this.source = options.source;
    }
    this.causeValue = options.cause;
  }
}

export class StaticBearerTokenProvider implements BearerTokenProvider {
  private readonly token: BearerToken;
  private readonly info: AuthSourceInfo;

  constructor(token: string | BearerToken, info: Partial<AuthSourceInfo> = {}) {
    this.token = typeof token === 'string' ? { token } : token;
    this.info = {
      type: info.type ?? 'bearer',
      label: info.label ?? 'static bearer token',
      ...(info.provider ? { provider: info.provider } : {}),
      ...(info.metadata ? { metadata: info.metadata } : {})
    };
  }

  describe(): AuthSourceInfo {
    return this.info;
  }

  getBearerToken(signal?: AbortSignal): Promise<BearerToken> {
    return Promise.resolve().then(() => {
      throwIfAborted(signal, this.info);
      const token = this.token.token.trim();
      if (!token) {
        throw new AuthError({
          code: 'missing_credentials',
          message: `${this.info.label} is empty.`,
          source: this.info
        });
      }
      return { ...this.token, token };
    });
  }
}

export class EnvBearerTokenProvider implements BearerTokenProvider {
  private readonly info: AuthSourceInfo;

  constructor(
    private readonly envVar: string,
    options: { env?: NodeJS.ProcessEnv; label?: string; provider?: string } = {}
  ) {
    this.env = options.env ?? process.env;
    this.info = {
      type: 'api_key',
      label: options.label ?? `${envVar} environment variable`,
      ...(options.provider ? { provider: options.provider } : {}),
      metadata: { envVar }
    };
  }

  private readonly env: NodeJS.ProcessEnv;

  describe(): AuthSourceInfo {
    return this.info;
  }

  getBearerToken(signal?: AbortSignal): Promise<BearerToken> {
    return Promise.resolve().then(() => {
      throwIfAborted(signal, this.info);
      const token = this.env[this.envVar]?.trim();
      if (!token) {
        throw new AuthError({
          code: 'missing_credentials',
          message: `${this.envVar} is not set.`,
          source: this.info
        });
      }
      return { token };
    });
  }
}

export class CachedBearerTokenProvider implements BearerTokenProvider {
  private cached: BearerToken | undefined;

  constructor(
    private readonly inner: BearerTokenProvider,
    private readonly expirySkewMs = 60_000
  ) {}

  describe(): AuthSourceInfo {
    return {
      ...this.inner.describe(),
      metadata: {
        ...(this.inner.describe().metadata ?? {}),
        cached: true
      }
    };
  }

  async getBearerToken(signal?: AbortSignal): Promise<BearerToken> {
    throwIfAborted(signal, this.describe());
    if (this.cached && !isExpired(this.cached, this.expirySkewMs)) {
      return this.cached;
    }
    this.cached = await this.inner.getBearerToken(signal);
    return this.cached;
  }

  async invalidate(reason?: string): Promise<void> {
    this.cached = undefined;
    await this.inner.invalidate?.(reason);
  }
}

export class StoredBearerTokenProvider implements BearerTokenProvider {
  private readonly info: AuthSourceInfo;

  constructor(
    private readonly store: CredentialStore,
    private readonly key: string,
    options: { label?: string; provider?: string; type?: AuthSourceType } = {}
  ) {
    this.info = {
      type: options.type ?? 'oauth',
      label: options.label ?? `${key} stored bearer token`,
      ...(options.provider ? { provider: options.provider } : {})
    };
  }

  describe(): AuthSourceInfo {
    return this.info;
  }

  async getBearerToken(signal?: AbortSignal): Promise<BearerToken> {
    throwIfAborted(signal, this.info);
    const record = await this.store.read(this.key);
    if (!record) {
      throw new AuthError({
        code: 'missing_credentials',
        message: `No stored credentials found for ${this.key}.`,
        source: this.info
      });
    }
    if (isExpired(record, 0)) {
      throw new AuthError({
        code: 'expired_credentials',
        message: `Stored credentials for ${this.key} are expired.`,
        source: this.info
      });
    }
    return record;
  }

  async invalidate(): Promise<void> {
    await this.store.delete(this.key);
  }
}

export class RefreshingStoredBearerTokenProvider implements BearerTokenProvider {
  private readonly info: AuthSourceInfo;

  constructor(
    private readonly store: CredentialStore,
    private readonly key: string,
    private readonly refresher: OAuthTokenRefresher,
    private readonly options: { label?: string; provider?: string; expirySkewMs?: number } = {}
  ) {
    this.info = {
      type: 'oauth',
      label: options.label ?? `${key} stored OAuth token`,
      ...(options.provider ? { provider: options.provider } : {})
    };
  }

  describe(): AuthSourceInfo {
    return this.info;
  }

  async getBearerToken(signal?: AbortSignal): Promise<BearerToken> {
    throwIfAborted(signal, this.info);
    const record = await this.store.read(this.key);
    if (!record) {
      throw new AuthError({
        code: 'missing_credentials',
        message: `No stored credentials found for ${this.key}.`,
        source: this.info
      });
    }
    const expirySkewMs = this.options.expirySkewMs ?? 60_000;
    if (isExpired(record, expirySkewMs)) {
      if (!record.refreshToken) {
        throw new AuthError({
          code: 'expired_credentials',
          message: `Stored credentials for ${this.key} are expired and cannot be refreshed.`,
          source: this.info
        });
      }
      const refreshed = await this.refresher.refresh({
        credentials: record,
        ...(signal ? { signal } : {})
      });
      await this.store.write(this.key, refreshed);
      return credentialToBearer(refreshed);
    }
    return credentialToBearer(record);
  }

  async invalidate(): Promise<void> {
    await this.store.delete(this.key);
  }
}

export interface FileCredentialStoreOptions {
  rootDir?: string;
}

export class FileCredentialStore implements CredentialStore {
  readonly rootDir: string;

  constructor(options: FileCredentialStoreOptions = {}) {
    this.rootDir = options.rootDir ?? defaultCredentialStoreDir();
  }

  async read(key: string): Promise<CredentialRecord | undefined> {
    try {
      const text = await readFile(this.filePath(key), 'utf8');
      const parsed: unknown = JSON.parse(text);
      return parseCredentialRecord(parsed, key);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined;
      }
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError({
        code: 'io_error',
        message: `Failed to read credentials for ${key}: ${errorMessage(error)}`,
        cause: error
      });
    }
  }

  async write(key: string, record: CredentialRecord): Promise<void> {
    const parsed = parseCredentialRecord(record, key);
    if (!parsed) {
      throw new AuthError({
        code: 'invalid_credentials',
        message: `Credential record for ${key} is empty.`
      });
    }
    try {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      await writeFile(this.filePath(key), `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      throw new AuthError({
        code: 'io_error',
        message: `Failed to write credentials for ${key}: ${errorMessage(error)}`,
        retryable: true,
        cause: error
      });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.filePath(key), { force: true });
    } catch (error) {
      throw new AuthError({
        code: 'io_error',
        message: `Failed to delete credentials for ${key}: ${errorMessage(error)}`,
        retryable: true,
        cause: error
      });
    }
  }

  private filePath(key: string): string {
    const safeKey = credentialStoreKey(key);
    return path.join(this.rootDir, `${safeKey}.json`);
  }
}

export function createBearerTokenProvider(auth: ProviderAuth): BearerTokenProvider {
  switch (auth.type) {
    case 'api_key':
      if (auth.value !== undefined) {
        return new StaticBearerTokenProvider(auth.value, {
          type: 'api_key',
          label: auth.label ?? `${auth.envVar} configured API key`,
          metadata: { envVar: auth.envVar }
        });
      }
      return new EnvBearerTokenProvider(auth.envVar, {
        ...(auth.label ? { label: auth.label } : {})
      });
    case 'oauth':
      return new StoredBearerTokenProvider(auth.credentialStore, auth.key ?? auth.provider, {
        provider: auth.provider,
        label: auth.label ?? `${auth.provider} stored OAuth token`,
        type: 'oauth'
      });
    case 'bearer':
      return auth.tokenProvider;
  }
}

export function defaultCredentialStoreDir(): string {
  return path.join(process.env.AGENT_CORE_HOME ?? path.join(os.homedir(), '.agent-core'), 'auth');
}

export async function pollDeviceCode<T>(options: DeviceCodePollOptions<T>): Promise<T> {
  if (!Number.isFinite(options.intervalSeconds) || options.intervalSeconds < 0) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `Device-code poll interval is invalid: ${String(options.intervalSeconds)}`
    });
  }
  if (!Number.isFinite(options.expiresInSeconds) || options.expiresInSeconds <= 0) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `Device-code expiry is invalid: ${String(options.expiresInSeconds)}`
    });
  }
  const startedAt = Date.now();
  let intervalMs = Math.max(1_000, options.intervalSeconds * 1_000);
  const expiresAt = startedAt + options.expiresInSeconds * 1_000;
  for (;;) {
    throwIfAborted(options.signal, { type: 'oauth', label: 'device-code polling' });
    if (Date.now() >= expiresAt) {
      throw new AuthError({
        code: 'expired_credentials',
        message: 'Device-code login expired before authorization completed.'
      });
    }
    const result = await options.poll();
    switch (result.status) {
      case 'complete':
        return result.value;
      case 'failed':
        throw new AuthError({
          code: 'invalid_credentials',
          message: result.message
        });
      case 'slow_down':
        intervalMs += 5_000;
        break;
      case 'pending':
        break;
    }
    await delay(Math.min(intervalMs, Math.max(1, expiresAt - Date.now())), options.signal);
  }
}

function credentialStoreKey(key: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/.test(key)) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `Credential key contains unsupported characters: ${key}`
    });
  }
  return key;
}

function parseCredentialRecord(value: unknown, key: string): CredentialRecord | undefined {
  if (!isJsonObject(value)) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `Credential record for ${key} must be a JSON object.`
    });
  }
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  if (!token) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `Credential record for ${key} is missing a bearer token.`
    });
  }
  const issuedAt = optionalNumber(value.issuedAt, 'issuedAt', key);
  const expiresAt = optionalNumber(value.expiresAt, 'expiresAt', key);
  const metadata = isJsonObject(value.metadata) ? value.metadata : undefined;
  const refreshToken = typeof value.refreshToken === 'string' && value.refreshToken.trim().length > 0 ? value.refreshToken.trim() : undefined;
  const tokenType = typeof value.tokenType === 'string' && value.tokenType.trim().length > 0 ? value.tokenType.trim() : undefined;
  const scopes = parseScopes(value.scopes, key);
  return {
    token,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(scopes ? { scopes } : {}),
    ...(metadata ? { metadata } : {})
  };
}

function credentialToBearer(record: CredentialRecord): BearerToken {
  return {
    token: record.token,
    ...(record.issuedAt !== undefined ? { issuedAt: record.issuedAt } : {}),
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    ...(record.metadata ? { metadata: record.metadata } : {})
  };
}

function parseScopes(value: unknown, key: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `Credential record for ${key} has invalid scopes.`
    });
  }
  const scopes: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new AuthError({
        code: 'invalid_credentials',
        message: `Credential record for ${key} has invalid scopes.`
      });
    }
    scopes.push(item.trim());
  }
  return scopes;
}

function optionalNumber(value: unknown, field: string, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `Credential record for ${key} has invalid ${field}.`
    });
  }
  return value;
}

function isExpired(token: BearerToken, skewMs: number): boolean {
  return token.expiresAt !== undefined && token.expiresAt <= Date.now() + skewMs;
}

function throwIfAborted(signal: AbortSignal | undefined, source: AuthSourceInfo): void {
  if (!signal?.aborted) {
    return;
  }
  throw new AuthError({
    code: 'aborted',
    message: typeof signal.reason === 'string' ? signal.reason : 'Credential request aborted.',
    source,
    cause: signal.reason
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      reject(new AuthError({
        code: 'aborted',
        message: typeof reason === 'string' ? reason : 'Device-code polling aborted.',
        cause: reason
      }));
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      const reason: unknown = signal?.reason;
      reject(new AuthError({
        code: 'aborted',
        message: typeof reason === 'string' ? reason : 'Device-code polling aborted.',
        cause: reason
      }));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
