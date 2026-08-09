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
  'packages/auth', 'packages/cli', 'packages/json', 'packages/evidence', 'packages/model', 'packages/runtime', 'packages/tools', 'packages/tools-local', 'packages/tui',
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
    if (manifest.name === '@agent-core/cli' && files.some((file) => file.startsWith('dist/tui/'))) {
      throw new Error('@agent-core/cli still contains packed TUI output.');
    }
    if (manifest.name === '@agent-core/tui' && !files.includes('dist/index.js')) {
      throw new Error('@agent-core/tui is missing its public runtime entry point.');
    }
    dependencies[manifest.name] = `file:${path.join(packs, packed.filename)}`;
  }
  const terminalUiDirectory = path.join(root, 'node_modules', '@ismail-elkorchi', 'terminal-ui');
  const terminalUiManifest = JSON.parse(await readFile(path.join(terminalUiDirectory, 'package.json'), 'utf8'));
  const { stdout: terminalUiPackOutput } = await exec(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', packs], {
    cwd: terminalUiDirectory,
    maxBuffer: 10 * 1024 * 1024
  });
  const terminalUiPack = JSON.parse(terminalUiPackOutput)[0];
  const terminalUiFiles = terminalUiPack.files.map((file) => file.path);
  assertCleanArchivePaths(terminalUiFiles);
  if (!terminalUiFiles.some((file) => file.startsWith('dist/host/'))) throw new Error('terminal-ui is missing compiled host output.');
  dependencies[terminalUiManifest.name] = `file:${path.join(packs, terminalUiPack.filename)}`;
  await mkdir(consumer, { recursive: true });
  await writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({
    name: 'agent-core-consumer',
    private: true,
    type: 'module',
    dependencies,
    overrides: { '@ismail-elkorchi/terminal-ui': '$@ismail-elkorchi/terminal-ui' }
  }, null, 2)}\n`);
  await exec(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer, maxBuffer: 20 * 1024 * 1024 });
  await writeFile(path.join(consumer, 'runtime.mjs'), [
    "import * as runtime from '@agent-core/runtime';",
    "import * as nodeRuntime from '@agent-core/runtime/node';",
    "import * as model from '@agent-core/model';",
    "import * as json from '@agent-core/json';",
    "import * as evidence from '@agent-core/evidence';",
    "import * as tools from '@agent-core/tools';",
    "import * as local from '@agent-core/tools-local';",
    "import * as tui from '@agent-core/tui';",
    "import * as nodeEvidence from '@agent-core/evidence/node';",
    "if (!runtime.parseAgentTerminalSnapshot || !runtime.AgentRuntime || !runtime.InMemorySessionRepository || !nodeRuntime.JsonlSessionRepository || !model.parseModelResponse || !json.parseJsonObject || !evidence.InMemoryEventRepository || !nodeEvidence.JsonlEventRepository || !tools.prepareToolCall || !tools.invokePreparedToolCall || !local.ProcessManager || !tui.createAgentTuiApp) throw new Error('public runtime exports missing');"
  ].join('\n'));
  await exec(process.execPath, ['runtime.mjs'], { cwd: consumer });

  await writeFile(path.join(consumer, 'consumer.ts'), [
    "import type { JsonObject } from '@agent-core/json';",
    "import type { ModelProviderStateObject } from '@agent-core/model';",
    "import type { AgentCandidate, AgentTerminalSnapshot } from '@agent-core/runtime';",
    "import type { ToolEffects } from '@agent-core/tools';",
    "import type { AgentTuiAppRunOptions, AgentTuiRuntimeDetails } from '@agent-core/tui';",
    "const json: JsonObject = { nested: { ok: true }, values: [1, 'two'] };",
    "const providerState: ModelProviderStateObject = { responseId: 'resp', nested: { count: 1 } };",
    "const candidate: AgentCandidate = { status: 'complete', message: 'done', source: 'content', turnIndex: 1 };",
    "const effects: ToolEffects = { accesses: [{ mode: 'read', scope: 'workspace' }], lockScopes: [], idempotency: 'pure' };",
    "const tuiDetails: AgentTuiRuntimeDetails = { modelId: 'test-model', permissions: { workspaceWrites: 'denied', shell: 'denied' } };",
    "const tuiOptions: AgentTuiAppRunOptions = { runtimeDetails: tuiDetails, exitOnCompletion: true };",
    "declare const terminal: AgentTerminalSnapshot;",
    "void [json, providerState, candidate, effects, terminal, tuiOptions];"
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
