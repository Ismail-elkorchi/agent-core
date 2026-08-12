import {
  AuthError,
  type AuthSourceInfo,
  type BearerToken,
  type BearerTokenProvider,
  type CredentialRecord,
  type CredentialStore,
  FileCredentialStore,
  type OAuthRefreshRequest,
  type OAuthTokenRefresher,
  type ProviderAuth,
  RefreshingStoredBearerTokenProvider,
  createBearerTokenProvider,
  pollDeviceCode
} from '@agent-core/auth';
import { readBoundedJsonResponse } from '@agent-core/provider-openai-responses';

import {
  CHATGPT_ACCOUNT_CLAIM,
  CONTENT_TYPE_JSON,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_CREDENTIAL_KEY,
  OPENAI_CODEX_DEVICE_EXPIRES_SECONDS,
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  OPENAI_CODEX_DEVICE_TOKEN_URL,
  OPENAI_CODEX_DEVICE_USER_CODE_URL,
  OPENAI_CODEX_DEVICE_VERIFICATION_URI,
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_CODEX_TOKEN_URL
} from './constants.js';
import { errorMessage, isJsonObject, numericValue, parseJsonText } from './utils.js';

export interface OpenAICodexDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export interface OpenAICodexDeviceCodeLoginOptions {
  store?: CredentialStore;
  key?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onDeviceCode?: (info: OpenAICodexDeviceCodeInfo) => void;
}

interface DeviceAuthStartResponse {
  device_auth_id?: string;
  user_code?: string;
  interval?: number | string;
  expires_in?: number | string;
}

interface DeviceAuthTokenResponse {
  authorization_code?: string;
  code_verifier?: string;
  error?: string | { code?: string };
}

interface CodexTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export class OpenAICodexTokenRefresher implements OAuthTokenRefresher {
  private readonly fetchImpl: typeof fetch;

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  describe(): AuthSourceInfo {
    return {
      type: 'oauth',
      label: 'OpenAI Codex OAuth refresh',
      provider: OPENAI_CODEX_PROVIDER_ID
    };
  }

  async refresh(request: OAuthRefreshRequest): Promise<CredentialRecord> {
    if (!request.credentials.refreshToken) {
      throw new AuthError({
        code: 'expired_credentials',
        message: 'OpenAI Codex credentials do not include a refresh token.',
        source: this.describe()
      });
    }
    const token = await requestCodexToken(this.fetchImpl, {
      grant_type: 'refresh_token',
      refresh_token: request.credentials.refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID
    }, request.signal, 'refresh');
    return credentialFromTokenResponse(token);
  }
}

export async function loginOpenAICodexDeviceCode(options: OpenAICodexDeviceCodeLoginOptions = {}): Promise<CredentialRecord> {
  const fetchImpl = options.fetch ?? fetch;
  const device = await startDeviceAuth(fetchImpl, options.signal);
  options.onDeviceCode?.({
    userCode: device.userCode,
    verificationUri: OPENAI_CODEX_DEVICE_VERIFICATION_URI,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: OPENAI_CODEX_DEVICE_EXPIRES_SECONDS
  });
  const authorization = await pollDeviceCode({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: OPENAI_CODEX_DEVICE_EXPIRES_SECONDS,
    ...(options.signal ? { signal: options.signal } : {}),
    poll: () => pollDeviceAuth(fetchImpl, device, options.signal)
  });
  const token = await requestCodexToken(fetchImpl, {
    grant_type: 'authorization_code',
    client_id: OPENAI_CODEX_CLIENT_ID,
    code: authorization.authorizationCode,
    code_verifier: authorization.codeVerifier,
    redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI
  }, options.signal, 'exchange');
  const credentials = credentialFromTokenResponse(token);
  if (options.store) {
    await options.store.write(options.key ?? OPENAI_CODEX_CREDENTIAL_KEY, credentials);
  }
  return credentials;
}

export function resolveTokenProvider(
  options: { auth?: ProviderAuth | BearerTokenProvider; credentialStore?: CredentialStore; credentialKey?: string },
  fetchImpl: typeof fetch
): BearerTokenProvider {
  if (options.auth) {
    return isBearerTokenProvider(options.auth) ? options.auth : createBearerTokenProvider(options.auth);
  }
  return new RefreshingStoredBearerTokenProvider(
    options.credentialStore ?? new FileCredentialStore(),
    options.credentialKey ?? OPENAI_CODEX_CREDENTIAL_KEY,
    new OpenAICodexTokenRefresher({ fetch: fetchImpl }),
    {
      provider: OPENAI_CODEX_PROVIDER_ID,
      label: 'OpenAI Codex stored ChatGPT OAuth token'
    }
  );
}

export function accountIdFromToken(token: BearerToken): string {
  const metadataAccountId = isJsonObject(token.metadata) && typeof token.metadata.accountId === 'string' ? token.metadata.accountId : undefined;
  return metadataAccountId ?? accountIdFromRawToken(token.token);
}

function isBearerTokenProvider(value: ProviderAuth | BearerTokenProvider): value is BearerTokenProvider {
  return 'getBearerToken' in value && typeof value.getBearerToken === 'function';
}

async function startDeviceAuth(fetchImpl: typeof fetch, signal: AbortSignal | undefined): Promise<{ deviceAuthId: string; userCode: string; intervalSeconds: number }> {
  const response = await fetchImpl(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
    ...(signal ? { signal } : {})
  });
  const json = decodeDeviceAuthStart(await readAuthJsonResponse(response, 'OpenAI Codex device-code response'));
  const intervalSeconds = numericValue(json.interval, 5);
  if (!json.device_auth_id || !json.user_code || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: 'OpenAI Codex device-code response did not include the required fields.'
    });
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds
  };
}

async function pollDeviceAuth(
  fetchImpl: typeof fetch,
  device: { deviceAuthId: string; userCode: string },
  signal: AbortSignal | undefined
): Promise<{ status: 'pending' } | { status: 'slow_down' } | { status: 'failed'; message: string } | { status: 'complete'; value: { authorizationCode: string; codeVerifier: string } }> {
  const response = await fetchImpl(OPENAI_CODEX_DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({
      device_auth_id: device.deviceAuthId,
      user_code: device.userCode
    }),
    ...(signal ? { signal } : {})
  });
  const body = await response.text();
  if (response.ok) {
    const json = decodeDeviceAuthToken(parseJsonText(body, 'OpenAI Codex device token response'));
    if (!json.authorization_code || !json.code_verifier) {
      return { status: 'failed', message: 'OpenAI Codex device token response did not include authorization fields.' };
    }
    return {
      status: 'complete',
      value: {
        authorizationCode: json.authorization_code,
        codeVerifier: json.code_verifier
      }
    };
  }
  if (response.status === 403 || response.status === 404) {
    return { status: 'pending' };
  }
  const errorCode = errorCodeFromDeviceBody(body);
  if (errorCode === 'deviceauth_authorization_pending') {
    return { status: 'pending' };
  }
  if (errorCode === 'slow_down') {
    return { status: 'slow_down' };
  }
  return {
    status: 'failed',
    message: `OpenAI Codex device auth failed with HTTP ${String(response.status)}: ${body || response.statusText}`
  };
}

async function requestCodexToken(
  fetchImpl: typeof fetch,
  fields: Record<string, string>,
  signal: AbortSignal | undefined,
  operation: 'exchange' | 'refresh'
): Promise<CodexTokenResponse> {
  const response = await fetchImpl(OPENAI_CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    ...(signal ? { signal } : {})
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `OpenAI Codex token ${operation} failed with HTTP ${String(response.status)}: ${text || response.statusText}`
    });
  }
  const json = decodeCodexToken(parseJsonText(text, `OpenAI Codex token ${operation} response`), `OpenAI Codex token ${operation} response`);
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `OpenAI Codex token ${operation} response did not include access_token, refresh_token, and expires_in.`
    });
  }
  return json;
}

function credentialFromTokenResponse(token: CodexTokenResponse): CredentialRecord {
  const accessToken = token.access_token?.trim() ?? '';
  const refreshToken = token.refresh_token?.trim() ?? '';
  if (!accessToken || !refreshToken || typeof token.expires_in !== 'number') {
    throw new AuthError({
      code: 'invalid_credentials',
      message: 'OpenAI Codex token response was missing required token fields.'
    });
  }
  const accountId = accountIdFromRawToken(accessToken);
  const issuedAt = Date.now();
  return {
    token: accessToken,
    refreshToken,
    issuedAt,
    expiresAt: issuedAt + token.expires_in * 1000,
    ...(token.token_type ? { tokenType: token.token_type } : {}),
    ...(token.scope ? { scopes: token.scope.split(/\s+/).filter((item) => item.length > 0) } : {}),
    metadata: {
      provider: OPENAI_CODEX_PROVIDER_ID,
      accountId
    }
  };
}

function accountIdFromRawToken(token: string): string {
  try {
    const parts = token.split('.');
    const payload = parts[1];
    if (parts.length !== 3 || !payload) {
      throw new Error('token is not a JWT');
    }
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isJsonObject(parsed)) {
      throw new Error('JWT payload is not an object');
    }
    const claim = parsed[CHATGPT_ACCOUNT_CLAIM];
    if (!isJsonObject(claim) || typeof claim.chatgpt_account_id !== 'string' || claim.chatgpt_account_id.length === 0) {
      throw new Error('JWT payload does not include ChatGPT account id');
    }
    return claim.chatgpt_account_id;
  } catch (error) {
    throw new AuthError({
      code: 'invalid_credentials',
      message: `OpenAI Codex access token does not contain a ChatGPT account id: ${errorMessage(error)}`,
      cause: error
    });
  }
}

function errorCodeFromDeviceBody(body: string): string | undefined {
  if (!body) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isJsonObject(parsed)) {
      return undefined;
    }
    const error = parsed.error;
    if (typeof error === 'string') {
      return error;
    }
    if (isJsonObject(error) && typeof error.code === 'string') {
      return error.code;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readAuthJsonResponse(response: Response, label: string): Promise<unknown> {
  try {
    return await readBoundedJsonResponse(response);
  } catch (error) {
    throw new AuthError({ code: 'invalid_credentials', message: `${label} was not valid bounded JSON: ${errorMessage(error)}`, cause: error });
  }
}

function decodeDeviceAuthStart(value: unknown): DeviceAuthStartResponse {
  if (!isJsonObject(value)) throw new AuthError({ code: 'invalid_credentials', message: 'OpenAI Codex device-code response must be an object.' });
  if (typeof value.device_auth_id !== 'string' || typeof value.user_code !== 'string') throw new AuthError({ code: 'invalid_credentials', message: 'OpenAI Codex device-code response did not include the required fields.' });
  if (value.interval !== undefined && typeof value.interval !== 'number' && typeof value.interval !== 'string') throw new AuthError({ code: 'invalid_credentials', message: 'OpenAI Codex device-code interval must be a number or numeric string.' });
  if (value.expires_in !== undefined && typeof value.expires_in !== 'number' && typeof value.expires_in !== 'string') throw new AuthError({ code: 'invalid_credentials', message: 'OpenAI Codex device-code expiry must be a number or numeric string.' });
  return Object.freeze({ device_auth_id: value.device_auth_id, user_code: value.user_code, ...(value.interval === undefined ? {} : { interval: value.interval }), ...(value.expires_in === undefined ? {} : { expires_in: value.expires_in }) });
}

function decodeDeviceAuthToken(value: Record<string, unknown>): DeviceAuthTokenResponse {
  if (value.authorization_code !== undefined && typeof value.authorization_code !== 'string') throw new AuthError({ code: 'invalid_credentials', message: 'OpenAI Codex device authorization_code must be a string.' });
  if (value.code_verifier !== undefined && typeof value.code_verifier !== 'string') throw new AuthError({ code: 'invalid_credentials', message: 'OpenAI Codex device code_verifier must be a string.' });
  const error = value.error;
  let decodedError: DeviceAuthTokenResponse['error'];
  if (typeof error === 'string') decodedError = error;
  else if (error !== undefined) {
    if (!isJsonObject(error) || (error.code !== undefined && typeof error.code !== 'string')) throw new AuthError({ code: 'invalid_credentials', message: 'OpenAI Codex device error must be a string or coded object.' });
    decodedError = Object.freeze({ ...(typeof error.code === 'string' ? { code: error.code } : {}) });
  }
  return Object.freeze({
    ...(value.authorization_code === undefined ? {} : { authorization_code: value.authorization_code }),
    ...(value.code_verifier === undefined ? {} : { code_verifier: value.code_verifier }),
    ...(decodedError === undefined ? {} : { error: decodedError })
  });
}

function decodeCodexToken(value: Record<string, unknown>, label: string): CodexTokenResponse {
  if (typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string' || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new AuthError({ code: 'invalid_credentials', message: `${label} did not include valid access_token, refresh_token, and expires_in fields.` });
  if (value.token_type !== undefined && typeof value.token_type !== 'string') throw new AuthError({ code: 'invalid_credentials', message: `${label}.token_type must be a string.` });
  if (value.scope !== undefined && typeof value.scope !== 'string') throw new AuthError({ code: 'invalid_credentials', message: `${label}.scope must be a string.` });
  return Object.freeze({ access_token: value.access_token, refresh_token: value.refresh_token, expires_in: value.expires_in, ...(value.token_type === undefined ? {} : { token_type: value.token_type }), ...(value.scope === undefined ? {} : { scope: value.scope }) });
}
