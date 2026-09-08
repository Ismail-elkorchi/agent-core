import { execFile } from 'node:child_process';
import { glob, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required to verify packed consumers.');
const tscCli = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const workspaceManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const packageDirs = [];
for await (const file of glob(workspaceManifest.workspaces.map((workspace) => `${workspace}/package.json`), { cwd: root })) {
  const manifest = JSON.parse(await readFile(path.join(root, file), 'utf8'));
  if (!manifest.private) packageDirs.push(path.dirname(file));
}
packageDirs.sort();

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
    for (const file of files.filter((name) => name.endsWith('.d.ts'))) {
      const declaration = await readFile(path.join(directory, file), 'utf8');
      const retired = /\b(?:ModelMessage|ModelProviderState|SimpleTokenEstimator|TokenEstimator|SessionCompactionEntry|AgentSessionCompactionRequest|appendCompaction|summarizeConversation|executeAssistantToolCalls|nextObservationIndex|normalizeJsonSafe|JsonNormalizationDiagnostic|JsonNormalizationResult|outputNormalization|toObservationJsonObject|toJsonValue)\b/u.exec(declaration);
      if (retired) throw new Error(`${relative}/${file} still exports retired contract ${retired[0]}.`);
    }
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
    "import { renderDiagnostic } from '@agent-core/json/diagnostics';",
    "if (json.canonicalJsonString({ b: 1, a: 2 }) !== '{\"a\":2,\"b\":1}' || renderDiagnostic('large', { maxBytes: 1 }).bytes > 1) throw new Error('JSON boundary exports failed');",
    "import * as persistence from '@agent-core/persistence';",
    "import * as effects from '@agent-core/effects';",
    "import * as tools from '@agent-core/tools';",
    "import * as local from '@agent-core/tools-local';",
    "import * as nodePersistence from '@agent-core/persistence/node';",
    "if (!runtime.decodeAgentTerminalSnapshot || !runtime.AgentRuntime || !runtime.AgentSession || !runtime.InMemorySessionRepository || !nodeRuntime.JsonlSessionRepository || !model.parseModelResponse || !json.parseJsonObject || !effects.decodeExternalEffectIntent || !persistence.InMemoryEventRepository || !nodePersistence.JsonlEventRepository || !tools.planToolCall || !tools.invokeToolCallPlan || !tools.isCommandExecution || !local.LocalCommandExecution) throw new Error('public runtime exports missing');",
    "if (!runtime.HistoryReader || !runtime.ContextService || !runtime.InferenceService || !runtime.InMemoryNoteRepository || !runtime.InMemoryInferenceRepository || !nodeRuntime.JsonlNoteRepository || !nodeRuntime.JsonlInferenceRepository || !runtime.createHistoryTools || !runtime.createNotesTools || !runtime.createContextTools || !model.accountModelRequest || !model.compileModelRequest) throw new Error('persistent context exports missing');"
  ].join('\n'));
  await exec(process.execPath, ['runtime.mjs'], { cwd: consumer });

  await writeFile(path.join(consumer, 'consumer.ts'), [
    "import type { JsonObject } from '@agent-core/json';",
    "import { renderDiagnostic } from '@agent-core/json/diagnostics';",
    "const diagnostic = renderDiagnostic(new Error('example'));",
    "// @ts-expect-error diagnostic text is not an authoritative JSON payload",
    "diagnostic.value;",
    "import type { ModelInputItem, ModelOutputItem, ProviderContextState, CompiledModelRequest, RequestAccounting } from '@agent-core/model';",
    "import type { EffectRecoveryCapability } from '@agent-core/effects';",
    "import type { AgentModelOutput, AgentRunControl, AgentSessionState, AgentTerminalSnapshot, ContextWindowRecord, HistorySourceRef, NoteRepository } from '@agent-core/runtime';",
    "import type { ToolEffects, ToolObservation, ToolObservationInput } from '@agent-core/tools';",
    "const json: JsonObject = { nested: { ok: true }, values: [1, 'two'] };",
    "const providerState: ProviderContextState = { version: 1, provider: 'test', model: 'test-model', endpoint: 'https://provider.invalid', kind: 'response', data: { responseId: 'resp' }, origin: { requestId: 'request', inputIdentity: 'input' }, compatibility: { model: 'test-model', endpoint: 'https://provider.invalid', requiresExactPrefix: true }, replay: 'required' };",
    "const developerInput: ModelInputItem = { role: 'developer', content: 'Application-owned instruction.' };",
    "declare const outputItem: ModelOutputItem;",
    "declare const compiled: CompiledModelRequest;",
    "declare const accounting: RequestAccounting;",
    "declare const window: ContextWindowRecord;",
    "declare const source: HistorySourceRef;",
    "declare const notes: NoteRepository;",
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
    "void [json, providerState, developerInput, outputItem, compiled, accounting, window, source, notes, modelOutput, recovery, effects, rawObservation, ownedObservation, immutableObservation, terminal, run, sessionState];"
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
