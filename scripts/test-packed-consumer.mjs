import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required to verify packed consumers.');
const tscCli = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const packageDirs = [
  'packages/auth', 'packages/json', 'packages/effects', 'packages/persistence', 'packages/model', 'packages/runtime', 'packages/tools', 'packages/tools-local',
  'packages/providers/ollama', 'packages/providers/openai-responses', 'packages/providers/openai', 'packages/providers/openai-codex', 'packages/providers/openrouter'
];

function assertCleanArchivePaths(paths) {
  const forbidden = paths.filter((name) => /(^|\/)node_modules(\/|$)|(^|\/)\.agent-core(\/|$)|\.tsbuildinfo$|(^|\/)\.env($|\.)|(^|\/)(credentials?|secrets?)\.(json|ya?ml|txt)$/iu.test(name.replaceAll('\\', '/')));
  if (forbidden.length > 0) throw new Error(`Archive contains forbidden paths:\n${forbidden.join('\n')}`);
}

function assertNoDistImports(source, file) {
  if (/from\s+['"][^'"]*\/dist\/|import\(['"][^'"]*\/dist\//u.test(source)) throw new Error(`${file} imports generated package internals.`);
}

const temporary = await mkdtemp(path.join(tmpdir(), 'agent-core-packed-consumer-'));
try {
  const packs = path.join(temporary, 'packs');
  const consumer = path.join(temporary, 'consumer');
  await mkdir(packs, { recursive: true });
  const dependencies = {};
  for (const relative of packageDirs) {
    const directory = path.join(root, relative);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const { stdout } = await exec(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', packs], { cwd: directory, maxBuffer: 10 * 1024 * 1024 });
    const packed = JSON.parse(stdout)[0];
    const files = packed.files.map((file) => file.path);
    assertCleanArchivePaths(files);
    if (!files.some((file) => file.startsWith('dist/'))) throw new Error(`${relative} is missing compiled output.`);
    dependencies[manifest.name] = `file:${path.join(packs, packed.filename)}`;
  }
  await mkdir(consumer, { recursive: true });
  await writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({
    name: 'agent-core-consumer',
    private: true,
    type: 'module',
    dependencies
  }, null, 2)}\n`);
  await exec(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer, maxBuffer: 20 * 1024 * 1024 });
  await writeFile(path.join(consumer, 'runtime.mjs'), [
    "import * as runtime from '@agent-core/runtime';",
    "import * as nodeRuntime from '@agent-core/runtime/node';",
    "import * as model from '@agent-core/model';",
    "import * as json from '@agent-core/json';",
    "import * as persistence from '@agent-core/persistence';",
    "import * as effects from '@agent-core/effects';",
    "import * as tools from '@agent-core/tools';",
    "import * as local from '@agent-core/tools-local';",
    "import * as nodePersistence from '@agent-core/persistence/node';",
    "if (!runtime.decodeAgentTerminalSnapshot || !runtime.AgentRuntime || !runtime.AgentSession || !runtime.InMemorySessionRepository || !nodeRuntime.JsonlSessionRepository || !model.parseModelResponse || !json.parseJsonObject || !effects.decodeExternalEffectIntent || !persistence.InMemoryEventRepository || !nodePersistence.JsonlEventRepository || !tools.planToolCall || !tools.invokeToolCallPlan || !tools.isCommandExecution || !local.LocalCommandExecution) throw new Error('public runtime exports missing');"
  ].join('\n'));
  await exec(process.execPath, ['runtime.mjs'], { cwd: consumer });

  await writeFile(path.join(consumer, 'consumer.ts'), [
    "import type { JsonObject } from '@agent-core/json';",
    "import type { ModelProviderState } from '@agent-core/model';",
    "import type { EffectRecoveryCapability } from '@agent-core/effects';",
    "import type { AgentModelOutput, AgentRunControl, AgentSessionState, AgentTerminalSnapshot } from '@agent-core/runtime';",
    "import type { ToolEffects, ToolObservation, ToolObservationInput } from '@agent-core/tools';",
    "const json: JsonObject = { nested: { ok: true }, values: [1, 'two'] };",
    "const providerState: ModelProviderState = { provider: 'test', model: 'test-model', kind: 'response', data: { responseId: 'resp', nested: { count: 1 } } };",
    "const modelOutput: AgentModelOutput = { status: 'complete', message: 'done', source: 'content', turnIndex: 1 };",
    "const recovery: EffectRecoveryCapability = { kind: 'unknown' };",
    "const effects: ToolEffects = { accesses: [{ mode: 'read', scope: 'workspace' }], lockScopes: [], recovery };",
    "const rawObservation: ToolObservationInput<{ value: string }> = { kind: 'result', ok: true, summary: 'raw', scope: { resources: [], coverage: 'complete' }, output: { value: 'raw' } };",
    "// @ts-expect-error raw extension output is not an owned observation",
    "const ownedObservation: ToolObservation = rawObservation;",
    "declare const immutableObservation: ToolObservation;",
    "// @ts-expect-error owned observation fields are readonly",
    "immutableObservation.output = {};",
    "declare const terminal: AgentTerminalSnapshot;",
    "declare const run: AgentRunControl;",
    "declare const sessionState: AgentSessionState;",
    "void [json, providerState, modelOutput, recovery, effects, rawObservation, ownedObservation, immutableObservation, terminal, run, sessionState];"
  ].join('\n'));
  for (const exactOptionalPropertyTypes of [true, false]) {
    const config = `tsconfig-${String(exactOptionalPropertyTypes)}.json`;
    await writeFile(path.join(consumer, config), `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, exactOptionalPropertyTypes, noEmit: true }, files: ['consumer.ts'] }, null, 2)}\n`);
    await exec(process.execPath, [tscCli, '-p', config, '--pretty', 'false'], { cwd: consumer, maxBuffer: 20 * 1024 * 1024 });
  }
  const testFiles = (await exec('rg', ['--files', 'tests'], { cwd: root })).stdout.trim().split('\n').filter(Boolean);
  for (const file of testFiles) assertNoDistImports(await readFile(path.join(root, file), 'utf8'), file);
  console.log('Packed consumer runtime and exactOptionalPropertyTypes=true/false declaration checks passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
