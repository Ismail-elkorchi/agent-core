import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  evaluateContextPolicies,
  parseArguments,
  summarizeTrials,
  POLICIES
} from '../scripts/evaluate-context-policies.mjs';
import { contextWorkloads, scoreAnswer } from './fixtures/context-policies/workloads.mjs';

const gates = { minimumTrials: 10, maximumSuccessRegression: 0.05, maximumCostRatio: 1.25 };
const codexEndpoint = 'https://chatgpt.com/backend-api/codex';

async function codexFixture(t, { expires = 4102444800 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'context-policy-codex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: expires, marker: 'private-access-token' })).toString('base64url')}.signature`;
  const authFile = path.join(directory, 'private-auth-file.json');
  const credentials = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: token,
      account_id: 'private-account-id',
      id_token: 'private-id-token',
      refresh_token: 'private-refresh-token'
    },
    last_refresh: '2026-09-07T00:00:00Z'
  });
  await writeFile(authFile, credentials, { mode: 0o400 });
  const before = await stat(authFile, { bigint: true });
  return {
    directory,
    token,
    credentials,
    authFile,
    options: {
      provider: 'codex',
      model: 'gpt-5.6',
      endpoint: codexEndpoint,
      modelVersion: 'fixture-deployment-v1',
      codexAuthFile: authFile
    },
    async assertUnchanged() {
      assert.equal(await readFile(authFile, 'utf8'), credentials);
      const after = await stat(authFile, { bigint: true });
      assert.equal(after.mtimeNs, before.mtimeNs);
      assert.equal(after.ctimeNs, before.ctimeNs);
    },
    assertPrivate(text) {
      for (const secret of [
        token,
        'private-account-id',
        'private-id-token',
        'private-refresh-token',
        authFile
      ])
        assert.ok(
          !text.includes(secret),
          'Private auth material must stay out of reports and diagnostics.'
        );
    }
  };
}

test('Codex flags are explicit, dry mode does not read auth, and subscription endpoints are restricted', async (t) => {
  const fixture = await codexFixture(t);
  const discovery = t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(new URL(url).pathname.endsWith('/models'), true);
    assert.equal(init?.method ?? 'GET', 'GET');
    return Promise.resolve(
      new Response(JSON.stringify({ models: [] }), { headers: { 'content-type': 'application/json' } })
    );
  });
  const argv = [
    '--provider',
    'codex',
    '--model',
    'gpt-5.6',
    '--endpoint',
    codexEndpoint,
    '--model-version',
    'fixture-deployment-v1',
    '--codex-auth-file',
    fixture.authFile
  ];
  const options = parseArguments(argv, {
    CONTEXT_EVAL_MODEL: 'overridden',
    CONTEXT_EVAL_API_KEY: 'unused-api-secret'
  });
  assert.equal(options.model, 'gpt-5.6');
  assert.equal(options.codexAuthFile, fixture.authFile);
  const dry = await evaluateContextPolicies(
    { ...options, codexAuthFile: path.join(fixture.directory, 'does-not-exist') },
    {}
  );
  assert.ok(dry.availability.every((item) => item.status === 'not-probed'));
  assert.equal(dry.provider.credentialsPresent, null);
  assert.equal(discovery.mock.callCount(), 0);
  const report = await evaluateContextPolicies({ ...options, mode: 'capabilities' }, {});
  assert.equal(report.provider.id, 'openai-codex');
  assert.equal(report.provider.model, 'gpt-5.6');
  assert.equal(report.provider.credentialsPresent, true);
  assert.equal(report.provider.endpoint, `${codexEndpoint}/responses`);
  assert.equal(report.configuration.generation.outputLimit, 'admission-reservation-only');
  assert.equal(report.availability.find((item) => item.policy === 'provider-native').status, 'unavailable');
  fixture.assertPrivate(JSON.stringify(report));
  await fixture.assertUnchanged();
  for (const endpoint of [
    'https://example.invalid/codex',
    'http://chatgpt.com/backend-api',
    'https://chatgpt.com/backend-api/private',
    'https://chatgpt.com/backend-api/codex?key=secret'
  ]) {
    assert.throws(() => parseArguments(['--provider', 'codex', '--endpoint', endpoint], {}));
  }
  const absent = await evaluateContextPolicies(
    { ...fixture.options, mode: 'live', codexAuthFile: undefined },
    { OPENAI_API_KEY: 'ignored' }
  );
  assert.match(absent.availability[0].reason, /no implicit credential discovery/u);
  const unknown = await evaluateContextPolicies(
    { ...fixture.options, mode: 'capabilities', model: 'invented-codex-model' },
    {}
  );
  assert.match(unknown.availability[0].reason, /model_unavailable/u);
});

test(
  'bounded Codex generation uses public provider/auth composition without auth writes or secret reporting',
  { timeout: 60_000 },
  async (t) => {
    const fixture = await codexFixture(t);
    const requests = [];
    const logs = [];
    for (const method of ['log', 'warn', 'error'])
      t.mock.method(console, method, (...args) => logs.push(args.join(' ')));
    t.mock.method(globalThis, 'fetch', (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      assert.equal(String(url), `${codexEndpoint}/responses`);
      assert.equal(init.redirect, 'error');
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${fixture.token}`);
      assert.equal(new Headers(init.headers).get('chatgpt-account-id'), 'private-account-id');
      assert.ok(init.signal instanceof AbortSignal);
      const response = {
        id: `fixture-response-${requests.length}`,
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ACK' }] }],
        usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 }
      };
      return Promise.resolve(
        new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
          headers: { 'content-type': 'text/event-stream' }
        })
      );
    });
    const report = await evaluateContextPolicies(
      {
        ...fixture.options,
        mode: 'live',
        trials: 1,
        delay: 1,
        policies: ['retained-history'],
        maxTotalInvocations: 1
      },
      {}
    );
    assert.equal(requests.length, 1, report.trials[0]?.failure);
    assert.equal(report.totalInvocations, 1);
    assert.equal(report.trials[0].metrics.settledInvocations, 1);
    assert.equal(report.trials[0].metrics.promptTokens, 20);
    assert.equal(report.trials[0].metrics.completionTokens, 4);
    assert.equal(report.trials[0].metrics.costStatus, 'unknown-or-partial');
    assert.equal(requests[0].body.max_output_tokens, undefined);
    fixture.assertPrivate(JSON.stringify(report));
    const notes = await evaluateContextPolicies(
      {
        ...fixture.options,
        mode: 'live',
        trials: 1,
        delay: 1,
        transitionEvery: 2,
        policies: ['notes-retrieval'],
        maxTotalInvocations: 4
      },
      {}
    );
    assert.equal(notes.totalInvocations, 4);
    assert.equal(notes.trials[0].metrics.noteWrites, 1, JSON.stringify(notes.trials[0]));
    assert.equal(notes.trials[0].metrics.contextTransitions, 1);
    assert.equal(notes.trials[0].metrics.settledInvocations, 4);
    assert.equal(notes.trials[0].metrics.promptTokens, 80);
    assert.equal(notes.trials[0].metrics.completionTokens, 16);
    assert.equal(notes.trials[0].metrics.costStatus, 'unknown-or-partial');
    fixture.assertPrivate(JSON.stringify(notes));
    assert.equal(requests.length, 5);
    assert.ok(requests.every(({ body }) => body.max_output_tokens === undefined));
    fixture.assertPrivate(JSON.stringify(requests));
    fixture.assertPrivate(logs.join('\n'));
    await fixture.assertUnchanged();
  }
);

test('Codex auth and provider failures keep file contents and private errors out of CLI output', async (t) => {
  const fixture = await codexFixture(t, { expires: 1 });
  const output = path.join(fixture.directory, 'expired-report.json');
  const args = [
    'scripts/evaluate-context-policies.mjs',
    '--mode',
    'live',
    '--provider',
    'codex',
    '--model',
    'gpt-5.6',
    '--model-version',
    'fixture',
    '--endpoint',
    codexEndpoint,
    '--codex-auth-file',
    fixture.authFile,
    '--output',
    output
  ];
  const expired = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(expired.status, 2);
  const expiredReport = await readFile(output, 'utf8');
  fixture.assertPrivate(expiredReport + expired.stdout + expired.stderr);
  assert.equal(JSON.parse(expiredReport).trials.length, 0);
  await fixture.assertUnchanged();

  const valid = await codexFixture(t);
  const preload = path.join(valid.directory, 'fake-transport.mjs');
  const dispatchMarker = path.join(valid.directory, 'dispatches');
  await writeFile(
    preload,
    `import { appendFile } from 'node:fs/promises';\nglobalThis.fetch = async (_url, init) => { await appendFile(${JSON.stringify(dispatchMarker)}, 'x'); throw new Error('upstream private error: ' + new Headers(init.headers).get('authorization')); };\n`
  );
  const failedOutput = path.join(valid.directory, 'failure-report.json');
  const failed = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(preload).href,
      ...args.slice(0, -2).map((arg) => (arg === fixture.authFile ? valid.authFile : arg)),
      '--output',
      failedOutput,
      '--trials',
      '1',
      '--delay',
      '1',
      '--policies',
      'retained-history',
      '--max-total-invocations',
      '1'
    ],
    { encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(failed.status, 1, failed.stderr);
  const failedReport = await readFile(failedOutput, 'utf8');
  valid.assertPrivate(failedReport + failed.stdout + failed.stderr);
  assert.ok(!failedReport.includes('upstream private error'));
  assert.equal(JSON.parse(failedReport).totalInvocations, 1);
  assert.equal(await readFile(dispatchMarker, 'utf8'), 'x');
  await valid.assertUnchanged();

  const malformedFile = path.join(valid.directory, 'malformed-auth.json');
  const malformed = `{"tokens": private-refresh-token ${valid.token}`;
  await writeFile(malformedFile, malformed, { mode: 0o400 });
  const invalid = await evaluateContextPolicies(
    { ...valid.options, mode: 'capabilities', codexAuthFile: malformedFile },
    {}
  );
  assert.ok(invalid.availability.every((item) => item.status === 'unavailable'));
  valid.assertPrivate(JSON.stringify(invalid));
  assert.equal(await readFile(malformedFile, 'utf8'), malformed);
});

test('dry configuration never calls a provider and never reports environment credentials', async () => {
  const secret = 'secret-that-must-stay-in-transport';
  const env = {
    CONTEXT_EVAL_PROVIDER: 'openai',
    CONTEXT_EVAL_MODEL: 'unresolved-model',
    CONTEXT_EVAL_ENDPOINT: 'https://example.invalid/v1',
    CONTEXT_EVAL_API_KEY: secret
  };
  const options = parseArguments([], env);
  assert.equal(options.mode, 'dry');
  assert.ok(!JSON.stringify(options).includes(secret));
  const report = await evaluateContextPolicies(options, env);
  assert.equal(report.measurement, 'capability-report');
  assert.equal(report.provider.credentialsPresent, true);
  assert.deepEqual(report.trials, []);
  assert.ok(report.availability.every((item) => item.status === 'not-probed'));
  assert.equal(report.defaultRecommendation, null);
  assert.ok(!JSON.stringify(report).includes(secret));
  const unavailable = await evaluateContextPolicies(
    { mode: 'live', provider: 'openai', model: 'example', endpoint: 'https://example.invalid/v1' },
    {}
  );
  assert.ok(
    unavailable.availability.every(
      (item) => item.status === 'unavailable' && item.reason.includes('Missing credentials')
    )
  );
  assert.deepEqual(unavailable.trials, []);
  for (const provider of ['constructor', '__proto__']) {
    const unsupported = await evaluateContextPolicies(
      { mode: 'capabilities', provider, model: 'model', endpoint: 'https://example.invalid' },
      {}
    );
    assert.ok(unsupported.availability.every((item) => item.status === 'unavailable'));
  }
});

test('runner rejects unbounded/ambiguous inputs and credential-bearing endpoints', () => {
  for (const argv of [
    ['--trials', 'Infinity'],
    ['--trials', '0'],
    ['--max-total-invocations', '501'],
    ['--timeout-ms', '0'],
    ['--policies', 'notes-retrieval,notes-retrieval'],
    ['--mode', 'unknown'],
    ['--policies', 'mystery'],
    ['--trials'],
    ['--secret', 'value']
  ])
    assert.throws(() => parseArguments(argv, {}));
  for (const endpoint of [
    'https://user:password@example.invalid',
    'https://example.invalid?api_key=secret',
    'file:///tmp/provider'
  ]) {
    assert.throws(() => parseArguments([], { CONTEXT_EVAL_ENDPOINT: endpoint }));
  }
  assert.throws(() => parseArguments(['--delay', '1.5'], {}));
});

test('delayed workloads distinguish continuing constraints, corrections, and explicit supersession', () => {
  for (const workload of contextWorkloads(2)) {
    assert.ok(workload.turns[0].task.indexOf('STATE[') > 800);
    const checkpoints = workload.turns.filter((turn) => turn.expected);
    assert.equal(checkpoints.length, 2);
    assert.notEqual(checkpoints[0].expected.code, checkpoints[1].expected.code);
    assert.notEqual(checkpoints[0].expected.objective, checkpoints[1].expected.objective);
    assert.equal(checkpoints[0].expected.access, checkpoints[1].expected.access);
    const correct = scoreAnswer(JSON.stringify(checkpoints[1].expected), checkpoints[1], workload);
    assert.equal(correct.success, true);
    assert.equal(correct.staleFactErrors, 0);
    const stale = scoreAnswer(JSON.stringify(checkpoints[0].expected), checkpoints[1], workload);
    assert.equal(stale.success, false);
    assert.equal(stale.continuingConstraintAdherence, true);
    assert.equal(stale.latestCorrectionUsed, false);
    assert.equal(stale.staleFactErrors, 2);
    assert.equal(scoreAnswer('not JSON', checkpoints[1], workload).validJson, false);
  }
});

test('comparison gates cannot turn low prompt usage or missing costs into quality evidence', () => {
  // Synthetic numbers test gate arithmetic only. Production trial metrics come from Core.
  const row = (policy, trial, success, promptTokens) => ({
    policy,
    workload: 'gate-arithmetic',
    trial,
    success,
    mechanicalCoverage: 'observed-trial',
    mechanical: {
      inputLoss: 0,
      unauthorizedScopeExpansion: 0,
      orphanToolResults: 0,
      duplicateSettlements: 0
    },
    metrics: {
      promptTokens,
      completionTokens: 10,
      latencyMs: 1,
      knownCosts: { USD: 0.01 },
      costStatus: 'known'
    }
  });
  const trials = Array.from({ length: 20 }, (_, index) => [
    row('retained-history', index, true, 1000),
    row('notes-retrieval', index, false, 10)
  ]).flat();
  const summary = summarizeTrials(trials, gates);
  const notes = summary.find((item) => item.policy === 'notes-retrieval');
  assert.equal(notes.sampleSize, 20);
  assert.equal(notes.successRate, 0);
  assert.equal(notes.qualityGate, 'failed');
  assert.ok(notes.successInterval95[1] > 0); // A finite sample is not certainty.
  assert.ok(
    summarizeTrials(trials, gates, 'deterministic-simulation').every(
      (item) => item.qualityGate === 'not-measured'
    )
  );
  const unknownCosts = trials.map((trial) => ({
    ...trial,
    success: true,
    metrics: { ...trial.metrics, costStatus: 'unknown-or-partial' }
  }));
  assert.ok(
    summarizeTrials(unknownCosts, gates).every(
      (item) => item.qualityGate === 'inconclusive' && item.meanCostUSD === null
    )
  );
  unknownCosts[0].mechanical = { ...unknownCosts[0].mechanical, duplicateSettlements: 1 };
  assert.equal(
    summarizeTrials(unknownCosts, gates).find((item) => item.policy === 'retained-history').qualityGate,
    'failed-mechanical'
  );
  const estimatedCosts = trials.map((trial) => ({
    ...trial,
    metrics: { ...trial.metrics, tokenUsageSource: 'includes-estimates' }
  }));
  assert.ok(summarizeTrials(estimatedCosts, gates).every((item) => item.meanCostUSD === null));
});

test('CLI writes a caller-selected report and preserves an existing output file', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'context-policy-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'report.json');
  const command = ['scripts/evaluate-context-policies.mjs', '--mode', 'dry', '--output', output];
  const env = {
    ...process.env,
    CONTEXT_EVAL_PROVIDER: 'openai',
    CONTEXT_EVAL_MODEL: 'model',
    CONTEXT_EVAL_ENDPOINT: 'https://example.invalid/v1',
    CONTEXT_EVAL_API_KEY: 'transport-secret'
  };
  const first = spawnSync(process.execPath, command, { env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const contents = await readFile(output, 'utf8');
  assert.equal(JSON.parse(contents).measurement, 'capability-report');
  assert.ok(!contents.includes('transport-secret'));
  const second = spawnSync(process.execPath, command, { env, encoding: 'utf8' });
  assert.equal(second.status, 1);
  assert.equal(await readFile(output, 'utf8'), contents);
});

test(
  'deterministic policy trials execute Core inference, context transitions, notes and authorized retrieval',
  { timeout: 120_000 },
  async () => {
    const report = await evaluateContextPolicies({
      mode: 'simulation',
      trials: 2,
      delay: 1,
      transitionEvery: 2,
      maxTotalInvocations: 200
    });
    assert.equal(report.measurement, 'deterministic-simulation');
    assert.equal(report.defaultRecommendation, null);
    assert.equal(report.configuration.gates.maximumSuccessRegression, gates.maximumSuccessRegression);
    assert.match(report.configuration.source.runnerSha256, /^[a-f0-9]{64}$/u);
    assert.ok(
      report.configuration.source.dirty === null || typeof report.configuration.source.dirty === 'boolean'
    );
    assert.equal(report.trials.length, 16);
    assert.deepEqual(
      report.availability.map((item) => item.policy),
      POLICIES
    );
    assert.equal(report.availability.find((item) => item.policy === 'provider-native').status, 'available');
    for (const trial of report.trials) {
      assert.equal(trial.status, 'completed', JSON.stringify(trial));
      assert.equal(trial.success, true, JSON.stringify(trial));
      assert.ok(trial.metrics.invocations > 0);
      assert.equal(trial.metrics.settledInvocations, trial.metrics.invocations);
      assert.equal(trial.metrics.uncertainInvocations, 0);
      assert.ok(trial.metrics.promptTokens > 0);
      assert.ok(trial.metrics.completionTokens > 0);
      assert.equal(trial.metrics.tokenUsageSource, 'includes-estimates');
      assert.equal(trial.mechanicalCoverage, 'observed-trial');
      assert.ok(Object.values(trial.mechanical).every((count) => count === 0));
      assert.equal(trial.checkpoints.length, 2);
      assert.equal(trial.requestFingerprints.length, trial.metrics.invocations);
      if (trial.policy === 'notes-retrieval') {
        assert.ok(trial.metrics.noteWrites > 0);
        assert.ok(trial.metrics.noteDeliveries > 0);
        assert.equal(trial.invocationIds.length, trial.metrics.noteWrites);
      } else assert.equal(trial.metrics.noteWrites, 0);
      if (trial.policy === 'provider-native') {
        assert.ok(trial.metrics.nativeTransforms > 0);
        assert.equal(trial.metrics.nativeTransforms, trial.metrics.contextTransitions);
        assert.ok(trial.metrics.nativeStateDeliveries > 0);
      } else assert.equal(trial.metrics.nativeTransforms, 0);
      assert.equal(
        trial.metrics.retrievalCalls > 0,
        ['history-retrieval', 'notes-retrieval'].includes(trial.policy)
      );
      assert.equal(trial.metrics.retrievalFailures, 0);
    }
    assert.equal(
      report.totalInvocations,
      report.trials.reduce((sum, trial) => sum + trial.metrics.invocations, 0)
    );
    assert.ok(
      report.summary.every(
        (item) => item.sampleSize === 2 && item.qualityGate === 'not-measured' && item.meanCostUSD === null
      )
    );
  }
);

test(
  'a whole-comparison invocation ceiling stops work and retains unmeasured checkpoints as failures',
  { timeout: 60_000 },
  async () => {
    const report = await evaluateContextPolicies({
      mode: 'simulation',
      trials: 1,
      delay: 1,
      policies: ['retained-history'],
      maxTotalInvocations: 1
    });
    assert.equal(report.totalInvocations, 1);
    assert.ok(report.trials.every((trial) => trial.status === 'budget-exhausted' && !trial.success));
    assert.ok(
      report.trials.every(
        (trial) =>
          trial.checkpoints.length === 2 &&
          trial.checkpoints.every((point) => point.unavailable && !point.success)
      )
    );
  }
);

test(
  'primary and auxiliary costs use durable public pricing, including cache rates and explicit partial costs',
  { timeout: 60_000 },
  async (t) => {
    const { MemorySimulationProvider, simulationProfile } = await import(
      './fixtures/context-policies/simulation.mjs'
    );
    const { InMemoryInferenceRepository } = await import('@agent-core/runtime');
    const complete = MemorySimulationProvider.prototype.complete;
    const append = InMemoryInferenceRepository.prototype.append;
    const records = [];
    let pricing;
    t.mock.method(MemorySimulationProvider.prototype, 'describeModel', async () => ({
      ...simulationProfile,
      pricing
    }));
    t.mock.method(MemorySimulationProvider.prototype, 'complete', async function (request) {
      return {
        ...(await complete.call(this, request)),
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cacheReadTokens: 40 }
      };
    });
    t.mock.method(InMemoryInferenceRepository.prototype, 'append', async function (ownerId, event, tail) {
      const committed = await append.call(this, ownerId, event, tail);
      if (committed) records.push({ ownerId, event });
      return committed;
    });
    for (const known of [true, false]) {
      pricing = { currency: 'USD', rates: { input: 2, output: 8, ...(known ? { cacheRead: 0.5 } : {}) } };
      const report = await evaluateContextPolicies({
        mode: 'simulation',
        trials: 1,
        delay: 1,
        transitionEvery: 2,
        policies: ['notes-retrieval'],
        maxTotalInvocations: 100
      });
      for (const trial of report.trials) {
        assert.equal(trial.status, 'completed', trial.failure);
        assert.ok(trial.metrics.noteWrites > 0);
        const settlements = records
          .filter(
            ({ ownerId, event }) => trial.runIds.includes(ownerId) && event.type === 'inference.settled'
          )
          .map(({ event }) => event);
        const notes = settlements.filter((event) => trial.invocationIds.includes(event.invocationId));
        assert.equal(notes.length, trial.metrics.noteWrites);
        assert.equal(settlements.length, trial.metrics.settledInvocations);
        // Fixture prices: 60 uncached input * $2/M + 40 cached * $0.50/M + 10 output * $8/M.
        const pricePerInvocation = known ? 0.00022 : 0.0002;
        assert.ok(settlements.every((event) => Math.abs(event.cost.amount - pricePerInvocation) < 1e-12));
        assert.ok(Math.abs(trial.metrics.knownCosts.USD - settlements.length * pricePerInvocation) < 1e-12);
        assert.equal(trial.metrics.costStatus, known ? 'known' : 'unknown-or-partial');
        assert.equal(trial.metrics.tokenUsageSource, 'provider');
      }
      assert.ok(report.summary.every((item) => (known ? item.meanCostUSD > 0 : item.meanCostUSD === null)));
    }
  }
);

test('deterministic native transform settles and replays through the shared inference owner budget', async () => {
  const { MemorySimulationProvider, simulationProfile } = await import(
    './fixtures/context-policies/simulation.mjs'
  );
  const { InferenceService, InMemoryInferenceRepository, InferenceBudgetExceededError } = await import(
    '@agent-core/runtime'
  );
  const { InMemoryArtifactRepository } = await import('@agent-core/persistence');
  const provider = new MemorySimulationProvider();
  const repository = new InMemoryInferenceRepository();
  const artifacts = new InMemoryArtifactRepository();
  const options = {
    provider,
    repository,
    artifacts,
    budget: { maxInvocations: 2, maxPromptTokens: 10000, maxCompletionTokens: 256 }
  };
  const service = new InferenceService(options);
  const request = {
    model: simulationProfile.id,
    maxOutputTokens: 64,
    messages: [{ role: 'user', content: 'STATE[000] {"code":"HERON"}' }]
  };
  await service.invoke({
    invocationId: 'primary',
    ownerId: 'native-owner',
    purpose: 'agent-step',
    request
  });
  const input = {
    invocationId: 'native-transform',
    ownerId: 'native-owner',
    purpose: 'context-transition',
    transformId: 'simulation.compact',
    request
  };
  const transformed = await service.transformContext(input);
  assert.equal(transformed.status, 'settled');
  assert.equal(transformed.replayed, false);
  assert.equal(transformed.cost.status, 'unknown');
  assert.match(transformed.result.state.data.memory, /HERON/u);
  assert.equal(provider.transforms.length, 1);
  const replay = await new InferenceService(options).transformContext(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.artifact, transformed.artifact);
  assert.deepEqual(replay.result, transformed.result);
  assert.equal(provider.transforms.length, 1);
  const owner = await repository.load('native-owner');
  assert.equal(owner.settledUsage.invocations, 2);
  assert.equal((await repository.load('native-owner', { invocationId: 'primary' })).invocation.start.operation, 'generation');
  assert.equal((await repository.load('native-owner', { invocationId: 'native-transform' })).invocation.start.operation, 'context_transform');
  await assert.rejects(
    service.invoke({ invocationId: 'too-many', ownerId: 'native-owner', purpose: 'agent-step', request }),
    InferenceBudgetExceededError
  );
  assert.equal(provider.calls.length, 1);
});

test(
  'native policy commits protected transform references and delivers their exact output to the next runtime',
  { timeout: 60_000 },
  async (t) => {
    const { MemorySimulationProvider } = await import('./fixtures/context-policies/simulation.mjs');
    const { InMemorySessionRepository, InMemoryInferenceRepository } = await import('@agent-core/runtime');
    const complete = MemorySimulationProvider.prototype.complete;
    const transform = MemorySimulationProvider.prototype.transformContextCompiled;
    const commit = InMemorySessionRepository.prototype.commitContextTransition;
    const append = InMemoryInferenceRepository.prototype.append;
    const steps = [];
    const windows = [];
    const invocations = [];
    t.mock.method(MemorySimulationProvider.prototype, 'complete', async function (request) {
      steps.push({ kind: 'generation', request });
      return complete.call(this, request);
    });
    t.mock.method(
      MemorySimulationProvider.prototype,
      'transformContextCompiled',
      async function (transformId, compiled) {
        const result = await transform.call(this, transformId, compiled);
        steps.push({ kind: 'transform', compiled, result });
        return result;
      }
    );
    t.mock.method(
      InMemorySessionRepository.prototype,
      'commitContextTransition',
      async function (session, input) {
        const committed = await commit.call(this, session, input);
        windows.push(committed.window);
        return committed;
      }
    );
    t.mock.method(InMemoryInferenceRepository.prototype, 'append', async function (ownerId, event, tail) {
      const committed = await append.call(this, ownerId, event, tail);
      if (committed && event.type === 'inference.started') invocations.push(event);
      return committed;
    });
    const report = await evaluateContextPolicies({
      mode: 'simulation',
      trials: 1,
      delay: 1,
      transitionEvery: 2,
      policies: ['provider-native'],
      maxTotalInvocations: 100
    });
    assert.ok(report.trials.every((trial) => trial.success));
    assert.ok(!JSON.stringify(report).includes('STATE[000]'));
    const transforms = steps.filter((step) => step.kind === 'transform');
    assert.ok(transforms.length > 0);
    assert.equal(windows.length, transforms.length);
    assert.equal(
      invocations.filter((item) => item.operation === 'context_transform').length,
      transforms.length
    );
    for (const step of transforms) {
      const window = windows.find(
        (item) => item.selection.providerState.transformId === step.result.transformId
      );
      assert.equal(window.selection.strategy, 'provider');
      assert.equal(window.selection.providerState.artifact.visibility, 'protected');
      assert.ok(window.selection.providerState.sources.length > 0);
      const invocation = invocations.find(
        (item) => item.invocationId === window.selection.providerState.invocationId
      );
      assert.equal(invocation.ownerId, window.selection.providerState.ownerId);
      assert.ok(report.trials.some((trial) => trial.runIds.includes(invocation.ownerId)));
      const next = steps.slice(steps.indexOf(step) + 1).find((item) => item.kind === 'generation');
      assert.ok(next);
      for (const item of step.result.input)
        assert.ok(next.request.messages.some((message) => isDeepStrictEqual(message, item)));
      assert.ok(!next.request.messages.some((item) => item.content.includes('Background detail')));
      assert.match(step.result.state.data.memory, /STATE\[000\]/u);
    }
  }
);

test('comparison ceiling prevents auxiliary native dispatch and leaves the previous window active', async () => {
  const report = await evaluateContextPolicies({
    mode: 'simulation',
    trials: 1,
    delay: 1,
    transitionEvery: 1,
    policies: ['provider-native'],
    maxTotalInvocations: 1
  });
  assert.equal(report.totalInvocations, 1);
  assert.ok(
    report.trials.every(
      (trial) => trial.status === 'budget-exhausted' && trial.budgetStop === 'comparison_invocations'
    )
  );
  assert.equal(report.trials[0].metrics.settledInvocations, 1);
  assert.ok(
    report.trials.every(
      (trial) =>
        trial.metrics.uncertainInvocations === 0 &&
        trial.metrics.nativeTransforms === 0 &&
        trial.metrics.contextTransitions === 0
    )
  );
});

test(
  'OpenAI native policy counts opaque state and dispatches the committed window through the public adapter',
  { timeout: 60_000 },
  async (t) => {
    const { ContextService, InMemoryInferenceRepository } = await import('@agent-core/runtime');
    const transition = ContextService.prototype.transition;
    const append = InMemoryInferenceRepository.prototype.append;
    const failures = [];
    t.mock.method(ContextService.prototype, 'transition', async function (...args) {
      try {
        return await transition.apply(this, args);
      } catch (error) {
        failures.push(error.message);
        throw error;
      }
    });
    t.mock.method(InMemoryInferenceRepository.prototype, 'append', async function (ownerId, event, tail) {
      if (event.type === 'inference.uncertain') failures.push(event.message);
      return append.call(this, ownerId, event, tail);
    });
    const requests = [];
    const opaque = 'private-fixture-compaction-state';
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const pathname = new URL(url).pathname;
      const body = JSON.parse(init.body);
      requests.push({ pathname, body });
      assert.ok(init.signal instanceof AbortSignal);
      if (pathname === '/v1/responses/input_tokens') return Response.json({ input_tokens: 60 });
      if (pathname === '/v1/responses/compact') {
        assert.equal(body.tools, undefined);
        assert.equal(body.max_output_tokens, undefined);
        return Response.json({
          id: 'compact-fixture',
          output: [{ type: 'compaction', encrypted_content: opaque }],
          usage: { input_tokens: 60, output_tokens: 12, total_tokens: 72 }
        });
      }
      assert.equal(pathname, '/v1/responses');
      const response = {
        id: `response-fixture-${requests.length}`,
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ACK' }] }],
        usage: { input_tokens: 60, output_tokens: 4, total_tokens: 64 }
      };
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' }
      });
    });
    const report = await evaluateContextPolicies(
      {
        mode: 'live',
        provider: 'openai',
        model: 'gpt-6-astra',
        modelVersion: 'fixture-deployment',
        endpoint: 'https://api.openai.com/v1',
        trials: 1,
        delay: 1,
        transitionEvery: 2,
        policies: ['provider-native'],
        maxTotalInvocations: 4
      },
      { CONTEXT_EVAL_API_KEY: 'fake-openai-key' }
    );
    assert.equal(
      report.totalInvocations,
      4,
      failures.join('\n') ||
        JSON.stringify(report.trials.map(({ status, failure }) => ({ status, failure })))
    );
    assert.equal(report.trials[0].metrics.nativeTransforms, 1, JSON.stringify(report.trials[0]));
    assert.equal(report.trials[0].metrics.contextTransitions, 1, failures.join('\n'));
    assert.equal(report.trials[0].metrics.nativeStateDeliveries, 1);
    assert.equal(report.trials[0].metrics.settledInvocations, 4);
    assert.equal(
      report.accounting.requests,
      requests.filter((item) => item.pathname.endsWith('/input_tokens')).length
    );
    assert.ok(
      report.accounting.requests > 0 && report.accounting.requests <= report.accounting.maxRequests
    );
    assert.equal(report.accounting.costStatus, 'unknown');
    assert.equal(report.trials[0].metrics.costStatus, 'unknown-or-partial');
    const generations = requests.filter((item) => item.pathname === '/v1/responses');
    assert.equal(generations.length, 3);
    assert.ok(
      generations
        .at(-1)
        .body.input.some((item) => item.type === 'compaction' && item.encrypted_content === opaque)
    );
    assert.ok(
      requests.some(
        (item) => item.pathname.endsWith('/input_tokens') && JSON.stringify(item.body).includes(opaque)
      )
    );
    assert.ok(!JSON.stringify(report).includes(opaque));
    assert.ok(!JSON.stringify(report).includes('fake-openai-key'));
    assert.ok(report.summary.every((item) => item.meanCostUSD === null));
  }
);
import { isDeepStrictEqual } from 'node:util';
