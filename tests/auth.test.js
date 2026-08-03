import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AuthError,
  CachedBearerTokenProvider,
  EnvBearerTokenProvider,
  FileCredentialStore,
  RefreshingStoredBearerTokenProvider,
  StoredBearerTokenProvider
} from '@agent-core/auth';

test('EnvBearerTokenProvider reads bearer tokens from a configured environment variable', async () => {
  const provider = new EnvBearerTokenProvider('TEST_TOKEN', { env: { TEST_TOKEN: '  secret-token  ' }, provider: 'test' });
  assert.deepEqual(provider.describe(), {
    type: 'api_key',
    label: 'TEST_TOKEN environment variable',
    provider: 'test',
    metadata: { envVar: 'TEST_TOKEN' }
  });
  assert.deepEqual(await provider.getBearerToken(), { token: 'secret-token' });
});

test('EnvBearerTokenProvider fails cleanly when credentials are missing', async () => {
  const provider = new EnvBearerTokenProvider('MISSING_TOKEN', { env: {} });
  await assert.rejects(
    () => provider.getBearerToken(),
    (error) => error?.code === 'missing_credentials' && /MISSING_TOKEN/.test(error.message)
  );
});

test('CachedBearerTokenProvider reuses tokens until invalidated', async () => {
  let calls = 0;
  const inner = {
    describe() {
      return { type: 'bearer', label: 'test token source' };
    },
    async getBearerToken() {
      calls += 1;
      return { token: `token-${String(calls)}` };
    }
  };
  const provider = new CachedBearerTokenProvider(inner);

  assert.equal((await provider.getBearerToken()).token, 'token-1');
  assert.equal((await provider.getBearerToken()).token, 'token-1');
  await provider.invalidate();
  assert.equal((await provider.getBearerToken()).token, 'token-2');
});

test('FileCredentialStore stores credentials outside project state through a generic store interface', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-core-auth-'));
  const store = new FileCredentialStore({ rootDir });
  await store.write('provider-test', {
    token: 'stored-token',
    expiresAt: Date.now() + 60_000,
    metadata: { account: 'test' }
  });

  const storedProvider = new StoredBearerTokenProvider(store, 'provider-test', { provider: 'provider-test' });
  assert.equal((await storedProvider.getBearerToken()).token, 'stored-token');
  await store.delete('provider-test');
  assert.equal(await store.read('provider-test'), undefined);
});

test('RefreshingStoredBearerTokenProvider refreshes expired stored OAuth credentials', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agent-core-auth-'));
  const store = new FileCredentialStore({ rootDir });
  await store.write('oauth-test', {
    token: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() - 1_000
  });
  let refreshed = 0;
  const provider = new RefreshingStoredBearerTokenProvider(store, 'oauth-test', {
    describe() {
      return { type: 'oauth', label: 'test refresher', provider: 'oauth-test' };
    },
    async refresh(request) {
      refreshed += 1;
      assert.equal(request.credentials.refreshToken, 'old-refresh');
      return {
        token: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 60_000,
        metadata: { accountId: 'acct' }
      };
    }
  });

  const token = await provider.getBearerToken();
  assert.equal(token.token, 'new-access');
  assert.equal(refreshed, 1);
  assert.equal((await store.read('oauth-test')).refreshToken, 'new-refresh');
});
