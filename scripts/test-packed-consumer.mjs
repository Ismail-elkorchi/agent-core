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
for await (const file of glob(
  workspaceManifest.workspaces.map((workspace) => `${workspace}/package.json`),
  { cwd: root }
)) {
  const manifest = JSON.parse(await readFile(path.join(root, file), 'utf8'));
  if (!manifest.private) packageDirs.push(path.dirname(file));
}
packageDirs.sort();

function assertCleanArchivePaths(paths) {
  const forbidden = paths.filter((name) =>
    /(^|\/)node_modules(\/|$)|(^|\/)\.agent-core(\/|$)|\.tsbuildinfo$|(^|\/)\.env($|\.)|(^|\/)(credentials?|secrets?)\.(json|ya?ml|txt)$/iu.test(
      name.replaceAll('\\', '/')
    )
  );
  if (forbidden.length > 0)
    throw new Error(`Archive contains forbidden paths:\n${forbidden.join('\n')}`);
}

function assertNoDistImports(source, file) {
  if (/from\s+['"][^'"]*\/dist\/|import\(['"][^'"]*\/dist\//u.test(source))
    throw new Error(`${file} imports generated package internals.`);
}

function exportedFiles(value) {
  return typeof value === 'string'
    ? [value.replace(/^\.\//u, '')]
    : Object.values(value ?? {}).flatMap(exportedFiles);
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
    const { stdout } = await exec(
      process.execPath,
      [npmCli, 'pack', '--json', '--pack-destination', packs],
      { cwd: directory, maxBuffer: 10 * 1024 * 1024 }
    );
    const packed = JSON.parse(stdout)[0];
    const files = packed.files.map((file) => file.path);
    assertCleanArchivePaths(files);
    for (const entry of exportedFiles([manifest.main, manifest.types, manifest.exports]))
      if (!files.includes(entry))
        throw new Error(`${relative} is missing exported file ${entry}.`);
    for (const file of files.filter((name) => name.endsWith('.d.ts'))) {
      const declaration = await readFile(path.join(directory, file), 'utf8');
      const retired =
        /\b(?:WorkingState\w*|workingState\w*|SessionStateContent|SessionStateBlock|SessionStateRevision|SessionStateSequence|SessionStateNotice|decodeSessionStateContent|sessionStateContentSchema|sessionStateRevisionId|expectedSessionStateRevisionId|currentSessionState|stateSequence|ModelChangeOptions|ModelContinuationRequiredError|parseModelChangeRequest|freshContinuation|freshContext|compactContext|createWorkingStateTool|createContextTools|SessionWorkingStateEntry|SessionQueuedSubmission|commitWorkingState|enqueueSubmission|findBranchMatches|ModelMessage|ModelProviderState|CompleteRequestEstimator|SimpleTokenEstimator|TokenEstimator|SessionCompactionEntry|AgentSessionCompactionRequest|appendCompaction|summarizeConversation|executeAssistantToolCalls|nextObservationIndex|normalizeJsonSafe|JsonNormalizationDiagnostic|JsonNormalizationResult|outputNormalization|toObservationJsonObject|toJsonValue)\b/u.exec(
          declaration
        );
      if (retired)
        throw new Error(`${relative}/${file} still exports retired contract ${retired[0]}.`);
    }
    dependencies[manifest.name] = `file:${path.join(packs, packed.filename)}`;
  }
  for (const name of ['@ismail-elkorchi/terminal-ui', 'markspan']) {
    const directory = path.join(root, 'node_modules', name);
    const { stdout } = await exec(
      process.execPath,
      [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', packs],
      { cwd: directory, maxBuffer: 10 * 1024 * 1024 }
    );
    dependencies[name] = `file:${path.join(packs, JSON.parse(stdout)[0].filename)}`;
  }
  await mkdir(consumer, { recursive: true });
  await writeFile(
    path.join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'agent-core-consumer',
        private: true,
        type: 'module',
        dependencies,
        devDependencies: { '@types/node': workspaceManifest.devDependencies['@types/node'] },
        overrides: {
          '@ismail-elkorchi/terminal-ui': '$@ismail-elkorchi/terminal-ui',
          markspan: '$markspan'
        }
      },
      null,
      2
    )}\n`
  );
  await exec(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumer,
    maxBuffer: 20 * 1024 * 1024
  });

  // Exercise the packed worker URL, WASM dependency, and explicit Node adapter exports.
  await writeFile(path.join(consumer, 'optional-tools.mjs'), String.raw`
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:worker_threads' || /^(quickjs-emscripten|@jitl\/quickjs|acorn)/u.test(specifier))
    throw new Error('Portable program contract import initialized an isolation adapter: ' + specifier);
  return next(specifier, context);
} });
const programmatic = await import('@agent-core/tools-programmatic');
hook.deregister();
const { createQuickJSProgramRunner } = await import('@agent-core/tools-programmatic/node');
const web = await import('@agent-core/tools-web');
const nodeWeb = await import('@agent-core/tools-web/node');
const mcp = await import('@agent-core/tools-mcp');
const nodeMcp = await import('@agent-core/tools-mcp/node');
const { InMemoryArtifactRepository } = await import('@agent-core/persistence');
const { ToolCatalog } = await import('@agent-core/tools');
const limits = programmatic.parseProgramLimits({ calls: 2, concurrentPrograms: 1 });
const tool = programmatic.createProgrammaticTool({ limits });
const runner = createQuickJSProgramRunner({ limits });
assert.deepEqual(tool.invocationModes, ['direct']);
assert.equal(runner.maxConcurrentPrograms, 1);
assert.match(runner.configurationRevision, /^[a-f0-9]{64}$/u);
const result = await runner.run({ source: 'return await call("echo", {value: 7});',
  tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
  signal: new AbortController().signal,
  call: async (name, input) => { assert.equal(name, 'echo'); assert.deepEqual(input, { value: 7 }); return { observationId: 'packed-observation', value: input.value }; }
});
assert.deepEqual(result, { status: 'completed', value: { observationId: 'packed-observation', value: 7 } });
const artifacts = new InMemoryArtifactRepository();
const configuration = nodeWeb.parseWebConfiguration({ policy: { id: 'packed', allowedOrigins: ['https://example.com'] } });
const webTools = web.createWebTools({ policy: configuration.policy, artifacts, transport: nodeWeb.createNodeWebTransport() });
assert.ok(webTools.some(definition => definition.name === 'fetch_source' && definition.outputJsonSchema));
assert.equal(nodeWeb.createConfiguredWebTools(configuration, { artifacts, environment: {} }).length, 1);
assert.equal(typeof mcp.MCP_PROTOCOL_VERSION, 'string');
const source = new mcp.McpToolSource({ id: 'packed', binding: { endpointId: 'endpoint', accountId: 'account', policyRevision: 'policy' }, createTransport: () => undefined, tools: {}, watchChanges: false });
const catalog = new ToolCatalog({ tools: [tool, ...webTools], sources: [source] });
assert.ok(catalog.current().some(definition => definition.name === 'run_program'));
await source.close();
const http = nodeMcp.createMcpHttpTransport({ endpoint: 'https://example.invalid/mcp' });
assert.equal(typeof http.start, 'function');
await http.close();
assert.equal(typeof nodeMcp.createMcpStdioTransport, 'function');
const configured = nodeMcp.createConfiguredMcpSources(nodeMcp.parseMcpConfiguration({ servers: [] }), { artifacts, environment: {} });
assert.deepEqual(configured.sources, []);
await configured.close();
`);
  await exec(process.execPath, ['optional-tools.mjs'], { cwd: consumer });
  await writeFile(path.join(consumer, 'optional-tools.ts'), String.raw`
import { createProgrammaticTool, parseProgramLimits, type ProgramLimits, type ProgrammaticToolOptions, type ProgramRunnerInput, type ProgramRunnerResult, type RuntimeProgramRunner } from '@agent-core/tools-programmatic';
import { createQuickJSProgramRunner, type QuickJSProgramRunnerOptions } from '@agent-core/tools-programmatic/node';
import { McpToolSource, type McpBinding, type McpToolPolicy, type McpToolSourceOptions, type McpLimits } from '@agent-core/tools-mcp';
import { createMcpHttpTransport, createMcpStdioTransport, parseMcpConfiguration, createConfiguredMcpSources, type McpHttpTransportOptions, type McpStdioTransportOptions, type NodeMcpConfiguration, type ConfiguredMcpSources } from '@agent-core/tools-mcp/node';
import { createWebTools, type WebConfiguration, type WebToolOptions, type WebTransport, type WebResponse } from '@agent-core/tools-web';
import { createNodeWebTransport, createConfiguredWebTools, parseWebConfiguration, type NodeWebTransportOptions } from '@agent-core/tools-web/node';
import { InMemoryArtifactRepository } from '@agent-core/persistence';
import { ToolCatalog, type ToolCatalogSource, type ToolReference, type ToolInvocationMode } from '@agent-core/tools';
import { parseNativeToolExposure, type NativeToolExposure, type AgentRuntimeOptions } from '@agent-core/runtime';
const limits: ProgramLimits = parseProgramLimits({ calls: 2, concurrentPrograms: 1 });
const programOptions: ProgrammaticToolOptions = { name: 'run_program', limits };
const runnerOptions: QuickJSProgramRunnerOptions = { toolName: programOptions.name ?? 'run_program', limits };
const runner: RuntimeProgramRunner = createQuickJSProgramRunner(runnerOptions);
const configurationRevision: string = runner.configurationRevision;
const tool = createProgrammaticTool(programOptions);
const input: ProgramRunnerInput = { source: 'return await call("echo", {});', tools: [], signal: new AbortController().signal, call: async (_name, value) => value };
const result: Promise<ProgramRunnerResult> = runner.run(input);
// @ts-expect-error isolation limits are immutable owned configuration
limits.calls = 3;
// @ts-expect-error bridge arguments must be JSON objects
input.call('echo', []);
const mode: ToolInvocationMode = 'programmatic';
// @ts-expect-error recursive program mode does not exist
const recursive: ToolInvocationMode = 'recursive';
const reference: ToolReference = { sourceId: 'source', toolId: 'echo', revision: 'definition', bindingRevision: 'authority' };
const binding: McpBinding = { endpointId: 'endpoint', accountId: 'account', policyRevision: 'policy' };
const mcpLimits: Partial<McpLimits> = { maxPages: 2, maxResultBytes: 1024 };
const policy: McpToolPolicy = { effectEnvelope: { accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] }, invocationModes: ['direct', mode], deriveEffects: () => ({ accesses: [{ mode: 'read', scope: 'memory' }], lockScopes: [] }) };
const sourceOptions: McpToolSourceOptions = { id: 'source', binding, createTransport: () => undefined, tools: { echo: policy }, limits: mcpLimits, watchChanges: false };
const source: ToolCatalogSource = new McpToolSource(sourceOptions);
const catalog = new ToolCatalog({ tools: [tool], sources: [source] });
const httpOptions: McpHttpTransportOptions = { endpoint: 'https://example.invalid/mcp', limits: mcpLimits, headers: () => ({ 'x-client': 'packed' }) };
const stdioOptions: McpStdioTransportOptions = { command: process.execPath, args: [], cwd: process.cwd(), env: {}, limits: mcpLimits };
const http = createMcpHttpTransport(httpOptions);
const stdio = createMcpStdioTransport(stdioOptions);
const mcpConfiguration: NodeMcpConfiguration = parseMcpConfiguration({ servers: [] });
const configuredMcp: ConfiguredMcpSources = createConfiguredMcpSources(mcpConfiguration, { environment: {}, allowedRisks: ['read', 'network'] });
const artifacts = new InMemoryArtifactRepository();
const response: WebResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body: new Uint8Array(), transferredBytes: 0 };
const transport: WebTransport = { id: 'packed', get: async () => response };
const webConfiguration: WebConfiguration = parseWebConfiguration({ policy: { id: 'packed', allowedOrigins: ['https://example.com'], limits: { maxResponseBytes: 1024 } } });
const webOptions: WebToolOptions = { policy: webConfiguration.policy, transport, artifacts };
const webTools = createWebTools(webOptions);
const nodeWebOptions: NodeWebTransportOptions = { id: 'packed-node', resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }] };
const nodeTransport: WebTransport = createNodeWebTransport(nodeWebOptions);
const configuredWeb = createConfiguredWebTools(webConfiguration, { artifacts, environment: {} });
const native: NativeToolExposure = parseNativeToolExposure({ discovery: true });
const runtimeOptions: Pick<AgentRuntimeOptions, 'programRunner' | 'nativeToolExposure'> = { programRunner: runner, nativeToolExposure: native };
// @ts-expect-error Node isolation host is only available through the explicit adapter export
import { createQuickJSProgramRunner as wrongRunner } from '@agent-core/tools-programmatic';
// @ts-expect-error Node network transport is only available through the explicit adapter export
import { createNodeWebTransport as wrongWeb } from '@agent-core/tools-web';
// @ts-expect-error Node MCP transport is only available through the explicit adapter export
import { createMcpHttpTransport as wrongMcp } from '@agent-core/tools-mcp';
void [result, configurationRevision, recursive, reference, catalog, http, stdio, configuredMcp, webTools, nodeTransport, configuredWeb, runtimeOptions];
`);
  await writeFile(
    path.join(consumer, 'runtime.mjs'),
    [
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
      "if (!runtime.decodeAgentTerminalSnapshot || !runtime.AgentRuntime || !runtime.AgentSession || !runtime.InMemorySessionRepository || !nodeRuntime.JsonlSessionRepository || !model.parseModelResponse || !json.parseJsonObject || !effects.decodeExternalEffectIntent || !persistence.InMemoryEventRepository || !nodePersistence.JsonlEventRepository || !tools.planToolCall || !tools.invokeToolCallPlan || !tools.isCommandExecution || !tools.createReadArtifactTool || local.readArtifactTool !== undefined || !runtime.resolveEffectiveToolCatalog || !runtime.SessionProviderBinding || !local.LocalCommandExecution) throw new Error('public runtime exports missing');",
      "if (!runtime.HistoryReader || !runtime.ContextService || !runtime.InferenceService || !runtime.InMemoryInferenceRepository || !nodeRuntime.JsonlInferenceRepository || !runtime.createHistoryTools || typeof runtime.ContextService.prototype.toolDefinitions !== 'function' || !runtime.EffectExecutor || !runtime.createObservationAccess || !tools.commandExecutionResources || !tools.contextRequiredObservation || !model.accountModelRequest || !model.compileModelRequest) throw new Error('persistent context exports missing');",
      "for (const name of ['decodeSessionStateContent', 'sessionStateContentSchema', 'sessionStateBlockSchema', 'sessionStateRevisionSchema', 'sessionStateView', 'sessionStateTextRange', 'applySessionStateEdits', 'sessionStateBatchStorageBytes', 'sessionStateRevisionIdentity', 'sessionStateItemIdentity', 'plannedSessionStateRefs', 'validateSessionStateCommit', 'contextControlRole', 'captureInferenceCapabilities', 'captureContextCapabilities', 'sessionStatePageSchema', 'SESSION_STATE_RETRIEVAL_LIMITS']) if (name in runtime) throw new Error('Retired state export remains: ' + name);",
      "if ('recordAdmittedCapabilities' in runtime.InferenceService.prototype || 'recordAdmittedCapabilities' in runtime.ContextService.prototype) throw new Error('Internal capability capture leaked through public classes');",
      "const content = runtime.sessionStateItemContentSchema.parse({ text: 'Answer the question 文😀' });",
      "if (!Object.isFrozen(content) || runtime.sessionStateItemContentSchema.safeParse({ blocks: [] }).success || runtime.sessionStateItemContentSchema.safeParse({ text: 'No identity', id: 'caller-owned' }).success || runtime.sessionStateItemRefSchema.safeParse({ itemId: 'item' }).success) throw new Error('item-state schema boundary failed');",
      "const sessions = new runtime.InMemorySessionRepository(); const session = await sessions.create({ binding: { schemaId: 'packed/session-state', schemaVersion: 1, subject: {} } }); const artifacts = new persistence.InMemoryArtifactRepository(); const history = new runtime.HistoryReader({ repository: sessions, session, artifacts }); const context = new runtime.ContextService({ repository: sessions, session, artifacts, history, assertStateWrite: async () => {}, policy: { maxSourceBytes: 8192, historyRead: { history, isAvailable: () => true } } });",
      "if ('currentSessionState' in sessions || (await context.sessionState()).id !== null || (await context.sessionState()).items.length) throw new Error('empty selected view boundary failed');",
      "const requestRef = await artifacts.storeProtected({ label: 'packed-inference', content: new TextEncoder().encode('{}') }); const cut = await history.capture(); const batch = { idempotencyKey: 'packed-save', branchId: cut.branchId, capturedHistoryCut: cut, inference: { ownerId: 'owner', invocationId: 'invocation', requestRef }, operations: [{ kind: 'create', ...content }] }; const receipt = await context.saveSessionState(batch); const ref = receipt.revisions[0];",
      "if (!ref.itemId || !ref.revisionId || (await context.sessionState()).id !== null || (await context.listSessionState({ limit: 1 })).items[0].itemId !== ref.itemId || (await context.readSessionState(ref)).text !== content.text || (await context.searchSessionState({ query: 'Answer', limit: 1 })).matches[0].revisionId !== ref.revisionId) throw new Error('independent save/list/read/search failed');",
      "if ((await context.saveSessionState(batch)).entryId !== receipt.entryId) throw new Error('durable save retry changed identity');",
      "const selected = { ...ref, range: { offset: 0, bytes: 6 } }; await context.transition({ expectedWindowId: null, idempotencyKey: 'packed-view', reason: 'Select exact saved span', renewal: true, selection: { retained: [], sessionState: [selected] } }, { admit: async input => ({ compiledInputIdentity: 'packed-input', capabilityRevision: 'packed', selection: { ...input.selection, continuity: { kind: 'fresh', resetId: 'packed-reset', historyPosition: input.cut, model: { provider: 'packed', model: 'packed' }, sources: input.selection.retained } } }) });",
      "const snapshot = await context.sessionState(); if (!snapshot.id || snapshot.items.length !== 1 || snapshot.items[0].text !== 'Answer' || snapshot.items[0].revisionId !== ref.revisionId) throw new Error('exact selected item view failed');",
      "const nextCut = await history.capture(); await context.saveSessionState({ ...batch, idempotencyKey: 'packed-replace', capturedHistoryCut: nextCut, operations: [{ kind: 'replace', itemId: ref.itemId, expectedRevisionId: ref.revisionId, text: 'New stored understanding' }] }); if ((await context.sessionState()).id !== snapshot.id || (await context.readSessionState(ref)).text !== content.text) throw new Error('saved revision changed pinned view or historical content');"
    ].join('\n')
  );
  await exec(process.execPath, ['runtime.mjs'], { cwd: consumer });
  await writeFile(
    path.join(consumer, 'neutral.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { registerHooks } from 'node:module';",
      "const hook = registerHooks({ resolve(specifier, context, next) { const resolved = next(specifier, context); if (resolved.url.includes('/terminal-ui/') || /@agent-core\\/(tui|rpc)\\//u.test(resolved.url)) throw new Error('Headless import initialized a presentation or transport package: ' + resolved.url); return resolved; } });",
      "await import('@agent-core/runtime'); await import('@agent-core/model'); hook.deregister();",
      "const { sessionRpcMethods } = await import('@agent-core/rpc'); await import('@agent-core/rpc/node');",
      "const session = { id: 'memory-conversation' };",
      'const methods = sessionRpcMethods({ async readSession() { return session; }, async listSessions() { return [session]; }, async selectSession(id) { assert.equal(id, session.id); return session; } });',
      "assert.deepEqual(await methods['session.read'].invoke({}), session); assert.deepEqual(await methods['session.select'].invoke({ sessionId: session.id }), session); await assert.rejects(methods['session.select'].invoke({ sessionId: 4 }));",
      "const { panel } = await import('@agent-core/tui'); await import('@agent-core/tui/node');",
      "const { createMemoryTerminalHost } = await import('@ismail-elkorchi/terminal-ui/host');",
      "const { text } = await import('@ismail-elkorchi/terminal-ui/components');",
      "const { defineTui, createTuiRuntime } = await import('@ismail-elkorchi/terminal-ui/tui');",
      'const host = createMemoryTerminalHost({ terminalSize: { columns: 48, rows: 18 } });',
      "const app = defineTui({ id: 'neutral', init: () => ({ state: { open: true } }), update: (state, message) => ({ state: { open: message.type !== 'close' } }), view: (state) => state.open ? panel({ id: 'neutral', title: 'Conversation', width: 44, height: 14, onClose: () => ({ type: 'close' }), slots: { content: text({ content: 'No file, process or domain authority required.' }) } }) : text({ content: 'Closed' }) });",
      "const runtime = createTuiRuntime({ app, host }); await runtime.start(); const pending = await runtime.handleInputChunk({ data: '\u001b' }); host.clock.advance(100); await pending.pending; assert.equal(runtime.state().open, false); await runtime.dispose(); await host.dispose();"
    ].join('\n')
  );
  await exec(process.execPath, ['neutral.mjs'], { cwd: consumer });

  await writeFile(
    path.join(consumer, 'consumer.ts'),
    [
      "import { applyPanelResult, mountPanel } from '@agent-core/tui';",
      "import { combineTuiResults, createTuiChild, reconcileTuiChildren, type TuiContext } from '@ismail-elkorchi/terminal-ui/tui';",
      "import { text } from '@ismail-elkorchi/terminal-ui/components';",
      'declare const tuiContext: TuiContext;',
      "const child = createTuiChild({ init: () => ({ state: 0 }), update: (state: number, message: number) => ({ state: state + message }), view: () => text({ content: 'child' }) }, (child) => ({ type: 'child' as const, child }));",
      "const mounted = mountPanel({ panelGeneration: 0 as const, overlay: { kind: 'none' as const }, owned: true }, 'example', child, tuiContext);",
      '// @ts-expect-error scoped panel work is opaque, not an effect descriptor array',
      'mounted.effects;',
      '// @ts-expect-error scoped panel focus is forwarded as owned work',
      'mounted.focus;',
      "if (mounted.state.overlay.kind === 'example') {",
      '  const value: number = mounted.state.overlay.state.state;',
      "  const applied = applyPanelResult(mounted.state, 'example', child.update(mounted.state.overlay.state, { id: 'example', generation: mounted.state.panelGeneration, message: value }, tuiContext));",
      '  combineTuiResults(applied.state, applied, reconcileTuiChildren([mounted.state.overlay.state], [], (child) => child));',
      '}',
      "import type { JsonObject } from '@agent-core/json';",
      "import { renderDiagnostic } from '@agent-core/json/diagnostics';",
      "const diagnostic = renderDiagnostic(new Error('example'));",
      '// @ts-expect-error diagnostic text is not an authoritative JSON payload',
      'diagnostic.value;',
      "import type { ModelInputItem, ModelOutputItem, ProviderContextState, CompiledModelRequest, RequestAccounting } from '@agent-core/model';",
      "import { settleExternalEffect, type EffectExecutionState, type EffectRecoveryCapability } from '@agent-core/effects';",
      "import type { AgentModelOutput, AgentRunControl, AgentSessionState, AgentTerminalSnapshot, AgentRuntimeOptions, ContextWindowRecord, EffectExecutionEvent, HistorySourceRef, HistorySourceCut, ContextService, ContextSelection, SessionRepository, SessionStateItemContent, SessionStateItemRef, SessionStateSelectedItem, SessionStateItemRevision, SessionStateOperation, SessionStateBatch, SessionStateBatchReceipt, SessionStateInference, SessionStatePage, SessionStateSnapshot } from '@agent-core/runtime';",
      "import type { ExecutionResources, ToolEffects, ToolObservation, ToolObservationInput } from '@agent-core/tools';",
      "const json: JsonObject = { nested: { ok: true }, values: [1, 'two'] };",
      "declare const unsettledState: Exclude<EffectExecutionState, { phase: 'settled' }>;",
      "const unsettledEvent: EffectExecutionEvent = { type: 'execution.state.changed', state: unsettledState };",
      '// @ts-expect-error unsettled effects cannot own observations',
      "const invalidUnsettled: EffectExecutionEvent = { type: 'execution.state.changed', state: unsettledState, observation: json };",
      "const settled = settleExternalEffect(unsettledState, unsettledState.settlementPermit, { outcome: 'succeeded', resultDigest: 'a'.repeat(64), exposure: { status: 'known', quantities: [] } });",
      "if (settled.status === 'settled') {",
      "  const outcome: 'succeeded' = settled.state.settlement.outcome;",
      "  const event: EffectExecutionEvent = { type: 'execution.state.changed', state: settled.state, observation: json };",
      '  // @ts-expect-error settled effects require their observation',
      "  const missing: EffectExecutionEvent = { type: 'execution.state.changed', state: settled.state };",
      '  // @ts-expect-error undefined is not a settled observation under either optional-property setting',
      "  const undefinedObservation: EffectExecutionEvent = { type: 'execution.state.changed', state: settled.state, observation: undefined };",
      '}',
      "const unknown = settleExternalEffect(unsettledState, unsettledState.settlementPermit, { outcome: 'unknown', exposure: { status: 'unknown', reserved: [] } });",
      "if (unknown.status === 'settled') {",
      '  // @ts-expect-error an unknown settlement cannot identify an observed result',
      "  const invalidUnknown: EffectExecutionEvent = { type: 'execution.state.changed', state: unknown.state, observation: json };",
      '  // @ts-expect-error runtime execution events do not admit unknown settlements without observations either',
      "  const missingUnknown: EffectExecutionEvent = { type: 'execution.state.changed', state: unknown.state };",
      '}',
      'declare const executionEvent: EffectExecutionEvent;',
      'if (executionEvent.observation !== undefined) {',
      "  const phase: 'settled' = executionEvent.state.phase;",
      '  const digest: string = executionEvent.state.settlement.resultDigest;',
      '}',
      "const providerState: ProviderContextState = { version: 1, provider: 'test', model: 'test-model', endpoint: 'https://provider.invalid', kind: 'response', data: { responseId: 'resp' }, origin: { requestId: 'request', inputIdentity: 'input' }, compatibility: { model: 'test-model', endpoint: 'https://provider.invalid', protocolRevision: 'conservative-v1', requiresExactPrefix: true, toolsIdentity: 'tools' }, replay: 'required' };",
      '// @ts-expect-error bound reasoning requires its original catalog identity',
      "const incompleteBinding: ProviderContextState = { ...providerState, compatibility: { model: 'test-model', endpoint: 'https://provider.invalid', protocolRevision: 'conservative-v1', requiresExactPrefix: true } };",
      "const developerInput: ModelInputItem = { role: 'developer', content: 'Application-owned instruction.' };",
      'declare const outputItem: ModelOutputItem;',
      'declare const compiled: CompiledModelRequest;',
      'declare const accounting: RequestAccounting;',
      'declare const window: ContextWindowRecord;',
      'declare const source: HistorySourceRef;',
      "const interpretation: SessionStateItemContent = { text: 'Useful, unverified context for this request', sources: [source] };",
      "const ref: SessionStateItemRef = { itemId: 'runtime-item', revisionId: 'runtime-revision', range: { offset: 0, bytes: 6 } };",
      "const selectedItem: SessionStateSelectedItem = { ...ref, ...interpretation };",
      "const snapshot: SessionStateSnapshot = { id: 'exact-view', items: [selectedItem] };",
      "const emptyView: SessionStateSnapshot = { id: null, items: [] };",
      "const selection: ContextSelection = { retained: [source], sessionState: [ref] };",
      "declare const cut: HistorySourceCut; declare const inference: SessionStateInference; declare const context: ContextService;",
      "const operations: readonly SessionStateOperation[] = [{ kind: 'create', ...interpretation }, { kind: 'replace', itemId: ref.itemId, expectedRevisionId: ref.revisionId, text: 'Correction' }, { kind: 'edit', itemId: ref.itemId, expectedRevisionId: ref.revisionId, edits: [{ offset: 0, bytes: 6, text: 'Revised' }] }, { kind: 'remove', itemId: ref.itemId, expectedRevisionId: ref.revisionId }];",
      "const batch: SessionStateBatch = { idempotencyKey: 'save', branchId: cut.branchId, capturedHistoryCut: cut, inference, operations };",
      "const saved: Promise<SessionStateBatchReceipt> = context.saveSessionState(batch);",
      "const listed: Promise<SessionStatePage> = context.listSessionState({ limit: 1, maxBytes: 1024 });",
      "const read: Promise<SessionStateSelectedItem | undefined> = context.readSessionState(ref);",
      "const viewed: Promise<SessionStateSnapshot> = context.selectedSessionState([ref], cut);",
      "declare const revision: SessionStateItemRevision; declare const repository: SessionRepository;",
      "// @ts-expect-error state revision body is artifact-backed, not an inline duplicate",
      "revision.text;",
      "// @ts-expect-error no global revision remains on a selected item view",
      "snapshot.revision;",
      "// @ts-expect-error no whole-body content remains on a selected item view",
      "snapshot.content;",
      "// @ts-expect-error selected item sequence is immutable",
      "snapshot.items.push(selectedItem);",
      "// @ts-expect-error narrative item content is immutable",
      "interpretation.text = 'changed';",
      "// @ts-expect-error exact evidence references are readonly",
      "interpretation.sources?.push(source);",
      "// @ts-expect-error exact ranges are immutable",
      "ref.range!.offset = 1;",
      "// @ts-expect-error item replacement must condition on its prior revision",
      "const unguarded: SessionStateOperation = { kind: 'replace', itemId: ref.itemId, text: 'unsafe' };",
      "// @ts-expect-error create does not accept caller-assigned item identities",
      "const callerIdentity: SessionStateOperation = { kind: 'create', itemId: 'caller', text: 'unsafe' };",
      "// @ts-expect-error active selection requires an exact item revision",
      "const incompleteRef: SessionStateItemRef = { itemId: 'item' };",
      "// @ts-expect-error runtime assigns revision identities; builders are internal",
      "import { sessionStateRevisionIdentity } from '@agent-core/runtime';",
      "// @ts-expect-error runtime assigns item identities; builders are internal",
      "import { sessionStateItemIdentity } from '@agent-core/runtime';",
      "// @ts-expect-error planned item refs are transaction implementation details",
      "import { plannedSessionStateRefs } from '@agent-core/runtime';",
      "// @ts-expect-error repository commit validation is not a consumer API",
      "import { validateSessionStateCommit } from '@agent-core/runtime';",
      "// @ts-expect-error retired whole-body content has no forwarding alias",
      "import type { SessionStateContent } from '@agent-core/runtime';",
      "// @ts-expect-error retired narrative blocks have no forwarding alias",
      "import type { SessionStateBlock } from '@agent-core/runtime';",
      "// @ts-expect-error global revision storage API is removed",
      "repository.currentSessionState();",
      "// @ts-expect-error whole-body payload cannot be saved through the item API",
      "context.saveSessionState({ blocks: [interpretation] });",
      "void [snapshot, emptyView, selection, saved, listed, read, viewed];",
      "const modelOutput: AgentModelOutput = { status: 'complete', message: 'done', source: 'content', turnIndex: 1 };",
      "const recovery: EffectRecoveryCapability = { kind: 'unknown' };",
      "const effects: ToolEffects = { accesses: [{ mode: 'read', scope: 'workspace' }], lockScopes: [], recovery };",
      "const rawObservation: ToolObservationInput<{ value: string }> = { kind: 'result', summary: 'raw', scope: { resources: [], coverage: 'complete' }, output: { value: 'raw' } };",
      '// @ts-expect-error raw extension output is not an owned observation',
      'const ownedObservation: ToolObservation = rawObservation;',
      'declare const immutableObservation: ToolObservation;',
      '// @ts-expect-error owned observation fields are readonly',
      'immutableObservation.output = {};',
      'declare const terminal: AgentTerminalSnapshot;',
      'declare const options: AgentRuntimeOptions;',
      '// @ts-expect-error application checks are not a kernel option',
      'options.checks;',
      '// @ts-expect-error application disposition is not a kernel option',
      'options.disposition;',
      '// @ts-expect-error application verification is not execution truth',
      'terminal.verificationStatus;',
      'declare const resources: ExecutionResources;',
      'const lifetime = resources.lifetime;',
      'declare const run: AgentRunControl;',
      'declare const sessionState: AgentSessionState;',
      'void [json, providerState, developerInput, outputItem, compiled, accounting, window, source, modelOutput, recovery, effects, rawObservation, ownedObservation, immutableObservation, terminal, options, lifetime, run, sessionState];'
    ].join('\n')
  );
  for (const exactOptionalPropertyTypes of [true, false]) {
    const config = `tsconfig-${String(exactOptionalPropertyTypes)}.json`;
    await writeFile(
      path.join(consumer, config),
      `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'], strict: true, skipLibCheck: false, exactOptionalPropertyTypes, noEmit: true }, files: ['consumer.ts', 'optional-tools.ts'] }, null, 2)}\n`
    );
    await exec(process.execPath, [tscCli, '-p', config, '--pretty', 'false'], {
      cwd: consumer,
      maxBuffer: 20 * 1024 * 1024
    });
  }
  const testFiles = (await exec('rg', ['--files', 'tests'], { cwd: root })).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const file of testFiles)
    assertNoDistImports(await readFile(path.join(root, file), 'utf8'), file);
  console.log(
    'Packed consumer runtime and exactOptionalPropertyTypes=true/false declaration checks passed.'
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
