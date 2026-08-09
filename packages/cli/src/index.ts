#!/usr/bin/env node
import { realpathSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { FileCredentialStore } from '@agent-core/auth';
import { AgentRuntime, agentEventCodec, type AgentApprovalSuspension, type AgentEvent, type AgentInstruction, type AgentProgressEvent, type AgentRunResult } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/evidence/node';
import { type ModelProvider, type ModelReasoningEffort, type ModelReasoningRequest, SimpleTokenEstimator } from '@agent-core/model';
import { loadAgentCoreConfiguration, type AgentCoreCheckConfiguration, type AgentCoreConfiguration } from './configuration.js';
import { loadWorkspace, type WorkspaceLayout } from './workspace.js';
import { OllamaProvider } from '@agent-core/provider-ollama';
import { OpenAICodexProvider, loginOpenAICodexDeviceCode } from '@agent-core/provider-openai-codex';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';
import type { AgentSession } from '@agent-core/runtime';
import type { AgentCheckDefinition } from '@agent-core/runtime';
import {
  accessRisk,
  type ToolCall,
  type ToolObservation,
  type ToolPolicy,
  type ToolProgress,
  type ToolRisk
} from '@agent-core/tools';
import type { ToolDefinition } from '@agent-core/tools';
import {
  DEFAULT_LOCAL_TOOL_CONFIGURATION,
  ProcessManager,
  WorkspaceFileSelector,
  applyPatchTool,
  createExecCommandTool,
  findFilesTool,
  listDirectoryTool,
  readArtifactTool,
  readFilesTool,
  searchTextTool,
  stopProcessTool,
  viewImageTool,
  writeStdinTool
} from '@agent-core/tools-local';
import { AgentTuiProgressRenderer, runAgentTuiApp, runAgentTuiTask } from './tui/index.js';
import type { AgentTuiRuntimeDetails } from './tui/index.js';
import { parseReasoningEffort } from './cli-values.js';
import { executeInteractiveCommand } from './interactive-commands.js';
import { normalizeTaskInput } from './task-input.js';

export {
  loadAgentCoreConfiguration,
  parseAgentCoreConfiguration,
  type AgentCoreCheckConfiguration,
  type AgentCoreConfiguration
} from './configuration.js';
export { describeWorkspace, loadWorkspace, type WorkspaceLayout } from './workspace.js';

type CliProviderId = 'ollama' | 'openrouter' | 'openai' | 'openai-codex';
type CliAuthProviderId = 'openai' | 'openai-codex';

interface CliOptions {
  root: string;
  provider: CliProviderId;
  model?: string;
  providerEndpoint?: string;
  maxOutputTokens?: number;
  apply: boolean;
  dryRun: boolean;
  allowShell: boolean;
  showReasoning: boolean;
  tui: boolean;
  plain: boolean;
  resume: boolean;
  session?: string;
  branch?: string;
  temperature?: number;
  reasoning?: ModelReasoningRequest;
  config?: string;
  configuration?: AgentCoreConfiguration;
}

export interface CliToolPolicyOptions {
  apply: boolean;
  dryRun: boolean;
  allowShell: boolean;
}

export interface CliProgressSink {
  handle(event: AgentProgressEvent): void | Promise<void>;
  consumeFinalAlreadyPrinted?(): boolean;
}

interface CliProviderRuntime {
  provider: ModelProvider;
  providerId: CliProviderId;
  model: string;
}

interface CliRuntime {
  agent: AgentRuntime;
  events: JsonlEventRepository<AgentEvent>;
  sessions: JsonlSessionRepository;
  session: AgentSession;
  progress: CliProgressSink;
  tuiDetails: AgentTuiRuntimeDetails;
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h')) {
    printHelp();
    return;
  }
  if (argv[0] === 'auth') {
    await runAuthCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'approval') {
    await runApprovalCommand(argv.slice(1));
    return;
  }

  const parsed = parseOptions(argv);
  const task = normalizeTaskInput(parsed.positionals.join(' '));
  const root = path.resolve(parsed.options.root);
  const workspace = await loadWorkspace(root);
  const options = parsed.options.config
    ? applyConfiguration(parsed.options, await loadAgentCoreConfiguration(workspace.workspaceRoot, parsed.options.config))
    : parsed.options;

  if (task) {
    if (options.tui) {
      const progress = new AgentTuiProgressRenderer();
      const runtime = await createRuntime(options, workspace, progress);
      const result = await runAgentTuiTask(runtime.agent, task, progress, {
        runtimeDetails: runtime.tuiDetails
      });
      printPersistenceLocations(runtime, result);
      process.exitCode = resultExitCode(result);
      return;
    }
    const progress = new CliProgressRenderer({ showReasoning: options.showReasoning });
    const runtime = await createRuntime(options, workspace, progress);
    const result = await runtime.agent.run({ task });
    printResult(result, progress);
    printPersistenceLocations(runtime, result);
    process.exitCode = resultExitCode(result);
    return;
  }

  if (process.stdin.isTTY) {
    if (!options.plain) {
      const progress = new AgentTuiProgressRenderer();
      const runtime = await createRuntime(options, workspace, progress);
      await runAgentTuiApp(runtime.agent, {
        progress,
        runtimeDetails: runtime.tuiDetails
      });
      console.error(`\nSession: ${runtime.sessions.location(runtime.session.id)}`);
      return;
    }
    const progress = new CliProgressRenderer({ showReasoning: options.showReasoning });
    const runtime = await createRuntime(options, workspace, progress);
    await runInteractive(runtime.agent, progress);
    console.error(`\nSession: ${runtime.sessions.location(runtime.session.id)}`);
    return;
  }

  throw new Error('agent-core requires a task string when stdin is not interactive.');
}

async function createRuntime(
  options: CliOptions,
  workspace: WorkspaceLayout,
  progress: CliProgressSink = new CliProgressRenderer({ showReasoning: options.showReasoning }),
  persistedSessionId?: string
): Promise<CliRuntime> {
  const providerRuntime = createProviderRuntime(options);
  const sessionBinding = await openSession(options, workspace, providerRuntime, persistedSessionId);
  const artifactStore = new LocalArtifactRepository({ rootDir: workspace.artifactsDir });
  const events = new JsonlEventRepository<AgentEvent>({ rootDir: workspace.runsDir, codec: agentEventCodec });
  const estimator = new SimpleTokenEstimator();
  const localHost = createCliLocalToolHost(workspace, artifactStore, options.configuration?.tools.enabled);
  const { localToolConfiguration, processManager } = localHost;
  const toolPolicy = toolPolicyFromOptions(options);
  const configuredTools = localHost.tools;
  const instructions = await loadWorkspaceInstructions(workspace.workspaceRoot, options.configuration);
  const checks = configuredChecks(options.configuration);
  const agent = new AgentRuntime({
    provider: providerRuntime.provider,
    model: providerRuntime.model,
    toolBoundary: { authorizationPolicyId: 'agent-core-cli/workspace-policy@1', executionTargetId: workspace.workspaceRoot },
    repositories: {
      events,
      session: { repository: sessionBinding.repository, sessionId: sessionBinding.session.id },
      artifacts: artifactStore
    },
    estimator,
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    tools: configuredTools,
    toolContext: {
      services: localHost.services
    },
    toolPolicy,
    ...(options.configuration?.authorization.requireApprovalFor.length ? { toolAuthorizer: request => {
      const approvalAccesses = request.effects.accesses.map((access) => accessRisk(access.mode))
        .filter((risk) => options.configuration?.authorization.requireApprovalFor.includes(risk));
      return approvalAccesses.length > 0
        ? { decision: 'require_approval' as const, reason: `Workspace configuration requires approval for ${[...new Set(approvalAccesses)].join(', ')} access.` }
        : { decision: 'allow' as const, reason: 'Allowed by workspace policy.' };
    } } : {}),
    ...(instructions.length > 0 ? { instructions } : {}),
    ...(checks.length > 0 ? { checks } : {}),
    ...(options.configuration?.limits ? { limits: options.configuration.limits } : {}),
    ...(checks.length > 0 ? { verification: { evidence: { read: () => Promise.resolve({ items: [], bytes: 0, truncated: false }), readArtifact: ref => artifactStore.readVerified(ref) }, runCommand: async (request, signal) => {
      const startedAt = Date.now();
      const outputTokenBudget = Math.max(64, Math.ceil((request.maxOutputBytes ?? 64_000) / 4));
      let result = await processManager.start({
        owner: request.owner,
        command: request.command,
        cwd: workspace.workspaceRoot,
        pty: false,
        timeoutMs: request.timeoutMs ?? 60_000,
        yieldMs: localToolConfiguration.process.maxYieldMs,
        outputTokenBudget,
        signal
      });
      let stdout = result.stdout.text;
      let stderr = result.stderr.text;
      let cursor = result.cursorEnd;
      while (result.status === 'running') {
        result = await processManager.poll(result.processId, outputTokenBudget, localToolConfiguration.process.maxYieldMs, cursor, request.owner);
        stdout += result.stdout.text;
        stderr += result.stderr.text;
        cursor = result.cursorEnd;
      }
      return { exitCode: result.status === 'exited' ? result.exitCode ?? null : null, stdout, stderr, durationMs: Date.now() - startedAt };
    } } } : {}),
    metadata: {
      workspaceRoot: workspace.workspaceRoot,
      workspaceName: workspace.workspaceName
    },
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
    onProgress: (event) => progress.handle(event)
  });
  return {
    agent,
    events,
    sessions: sessionBinding.repository,
    session: sessionBinding.session,
    progress,
    tuiDetails: {
      providerId: providerRuntime.providerId,
      modelId: providerRuntime.model,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.reasoning?.strategy === 'effort' ? { reasoningEffort: options.reasoning.effort } : {}),
      showReasoning: options.showReasoning,
      sessionLocation: sessionBinding.repository.location(sessionBinding.session.id),
      permissions: {
        workspaceWrites: options.apply ? 'allowed' : options.dryRun ? 'dry_run' : options.allowShell ? 'ambient_shell' : 'denied',
        shell: options.allowShell ? 'ambient' : 'denied'
      }
    }
  };
}

export function createCliLocalToolHost(workspace: WorkspaceLayout, artifactStore: LocalArtifactRepository, enabled?: readonly string[]) {
  const localToolConfiguration = DEFAULT_LOCAL_TOOL_CONFIGURATION;
  const processManager = new ProcessManager({ artifactRepository: artifactStore, ledgerDirectory: path.join(workspace.runtimeDir, 'processes'), ...localToolConfiguration.process });
  const workspaceFileSelector = new WorkspaceFileSelector(workspace.workspaceRoot, localToolConfiguration.fileSelection);
  const services = Object.freeze({
    workspaceRoot: workspace.workspaceRoot,
    artifactRepository: artifactStore,
    patchTransaction: true,
    patchTransactionDirectory: path.join(workspace.runtimeDir, 'transactions', 'patch'),
    localToolConfiguration,
    processManager,
    workspaceFileSelector
  });
  return Object.freeze({ localToolConfiguration, processManager, workspaceFileSelector, services, tools: Object.freeze(createCliDefaultTools(enabled, { ptySupported: processManager.supportsPty() })) });
}

export function createCliDefaultTools(enabled?: readonly string[], host: { readonly ptySupported?: boolean } = {}): ToolDefinition[] {
  const tools = [
    listDirectoryTool,
    findFilesTool,
    readFilesTool,
    searchTextTool,
    applyPatchTool,
    createExecCommandTool(host),
    writeStdinTool,
    stopProcessTool,
    viewImageTool,
    readArtifactTool
  ];
  if (!enabled) return tools;
  const known = new Set(tools.map((tool) => tool.name));
  const unknown = enabled.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown configured local tools: ${unknown.join(', ')}.`);
  return tools.filter(tool => enabled.includes(tool.name));
}

function applyConfiguration(options: CliOptions, configuration: AgentCoreConfiguration): CliOptions {
  return {
    ...options,
    provider: configuration.provider,
    model: configuration.model,
    ...(configuration.reasoning ? { reasoning: configuration.reasoning } : {}),
    resume: configuration.session.mode === 'latest',
    ...(configuration.session.id ? { session: configuration.session.id } : {}),
    configuration: configuration
  };
}

async function loadWorkspaceInstructions(rootDir: string, configuration: AgentCoreConfiguration | undefined): Promise<AgentInstruction[]> {
  if (!configuration) return [];
  const realRoot = await fs.realpath(rootDir);
  return Promise.all(configuration.instructions.map(async (instruction, index) => {
    const absolute = await fs.realpath(path.resolve(realRoot, instruction.path));
    if (absolute !== realRoot && !absolute.startsWith(`${realRoot}${path.sep}`)) throw new Error(`Project instruction escapes the workspace: ${instruction.path}`);
    return { id: `workspace-${String(index + 1)}-${instruction.path}`, content: await fs.readFile(absolute, 'utf8'), role: 'workspace', sourceUri: `file:${instruction.path}`, priority: 100 };
  }));
}

function configuredChecks(configuration: AgentCoreConfiguration | undefined): AgentCheckDefinition[] {
  if (!configuration) return [];
  return [
    ...configuration.verification.required.map(check => configuredCommandCheck(check, 'required')),
    ...configuration.verification.advisory.map(check => configuredCommandCheck(check, 'advisory'))
  ];
}

function configuredCommandCheck(check: AgentCoreCheckConfiguration, requirement: 'required' | 'advisory'): AgentCheckDefinition {
  return {
    id: check.id,
    requirement,
    description: `Project verification command: ${check.command}`,
    ...(check.timeoutMs ? { timeoutMs: check.timeoutMs } : {}),
    async run(context) {
      if (!context.execution.runCommand) return { verdict: 'unknown', summary: `Verification command execution is unavailable: ${check.command}`, diagnostic: { kind: 'unavailable', message: 'Project command executor is unavailable.' } };
      const result = await context.execution.runCommand({ command: check.command, owner: { runId: context.runId, turnId: context.turnId, toolBatchId: `verification:${check.id}`, callIndex: 0 }, ...(check.timeoutMs ? { timeoutMs: check.timeoutMs } : {}), ...(check.maxOutputBytes ? { maxOutputBytes: check.maxOutputBytes } : {}) }, context.signal);
      return { verdict: result.exitCode === 0 ? 'passed' : 'failed', summary: `${check.command} ${result.exitCode === 0 ? 'passed' : `failed with exit ${String(result.exitCode)}`}.`, output: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs } };
    }
  };
}

function parseOptions(args: string[]): { options: CliOptions; positionals: string[] } {
  const options: CliOptions = {
    root: process.cwd(),
    provider: parseProviderId(process.env.AGENT_CORE_PROVIDER ?? 'ollama'),
    ...(process.env.AGENT_CORE_MODEL ? { model: process.env.AGENT_CORE_MODEL } : {}),
    ...(process.env.AGENT_CORE_PROVIDER_ENDPOINT ? { providerEndpoint: process.env.AGENT_CORE_PROVIDER_ENDPOINT } : {}),
    ...(process.env.AGENT_CORE_REASONING_EFFORT ? { reasoning: reasoningFromEffort(parseReasoningEffort(process.env.AGENT_CORE_REASONING_EFFORT, 'AGENT_CORE_REASONING_EFFORT')) } : {}),
    apply: false,
    dryRun: false,
    allowShell: false,
    showReasoning: false,
    tui: false,
    plain: false,
    resume: false
  };
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [key = '', inlineValue] = arg.split('=', 2);
    const spec = cliOptionSpec(key);
    if (!spec) throw new Error(`Unknown option: ${key}`);
    const value = spec.takesValue ? requireValue(key, inlineValue ?? args[index + 1]) : undefined;
    spec.apply(options, value, key);
    if (spec.takesValue && inlineValue === undefined) index += 1;
  }
  return { options, positionals };
}

interface CliOptionSpec { readonly takesValue: boolean; apply(options: CliOptions, value: string | undefined, key: string): void }
const CLI_OPTION_SPECS = {
  '--root': valued((options, value) => { options.root = value; }),
  '--model': valued((options, value) => { options.model = value; }),
  '--provider': valued((options, value) => { options.provider = parseProviderId(value); }),
  '--provider-endpoint': valued((options, value) => { options.providerEndpoint = value; }),
  '--max-output-tokens': valued((options, value, key) => { options.maxOutputTokens = parsePositiveIntegerOption(key, value); }),
  '--temperature': valued((options, value) => { const temperature = Number(value); if (!Number.isFinite(temperature)) throw new Error('--temperature must be a finite number.'); options.temperature = temperature; }),
  '--reasoning-effort': valued((options, value, key) => { options.reasoning = reasoningFromEffort(parseReasoningEffort(value, key)); }),
  '--apply': flagged(options => { options.apply = true; }),
  '--dry-run': flagged(options => { options.dryRun = true; }),
  '--allow-shell': flagged(options => { options.allowShell = true; }),
  '--show-reasoning': flagged(options => { options.showReasoning = true; }),
  '--tui': flagged(options => { options.tui = true; }),
  '--plain': flagged(options => { options.plain = true; }),
  '--resume': flagged(options => { options.resume = true; }),
  '--session': valued((options, value) => { options.session = value; }),
  '--branch': valued((options, value) => { options.branch = value; }),
  '--config': valued((options, value) => { options.config = value; })
} satisfies Record<string, CliOptionSpec>;

function valued(apply: (options: CliOptions, value: string, key: string) => void): CliOptionSpec { return { takesValue: true, apply(options, value, key) { apply(options, value ?? '', key); } }; }
function flagged(apply: (options: CliOptions) => void): CliOptionSpec { return { takesValue: false, apply }; }
function cliOptionSpec(key: string): CliOptionSpec | undefined {
  return isCliOptionKey(key) ? CLI_OPTION_SPECS[key] : undefined;
}
function isCliOptionKey(key: string): key is keyof typeof CLI_OPTION_SPECS { return Object.hasOwn(CLI_OPTION_SPECS, key); }

function createProviderRuntime(options: CliOptions): CliProviderRuntime {
  const model = options.model ?? defaultModelForProvider(options.provider);
  switch (options.provider) {
    case 'ollama':
      return {
        providerId: 'ollama',
        model,
        provider: new OllamaProvider({
          model,
          ...(options.providerEndpoint ? { host: options.providerEndpoint } : {})
        })
      };
    case 'openrouter':
      return {
        providerId: 'openrouter',
        model,
        provider: new OpenRouterProvider({
          model,
          ...(options.providerEndpoint ? { baseUrl: options.providerEndpoint } : {})
        })
      };
    case 'openai':
      return {
        providerId: 'openai',
        model,
        provider: new OpenAIProvider({
          model,
          ...(options.providerEndpoint ? { baseUrl: options.providerEndpoint } : {})
        })
      };
    case 'openai-codex':
      return {
        providerId: 'openai-codex',
        model,
        provider: new OpenAICodexProvider({
          model,
          ...(options.providerEndpoint ? { baseUrl: options.providerEndpoint } : {})
        })
      };
  }
}

function defaultModelForProvider(provider: CliProviderId): string {
  switch (provider) {
    case 'ollama':
      return 'llama3.1';
    case 'openrouter':
      return 'openrouter/auto';
    case 'openai':
      return 'gpt-5.6-sol';
    case 'openai-codex':
      return 'gpt-5.6';
  }
}

function parseProviderId(value: string): CliProviderId {
  if (value === 'ollama' || value === 'openrouter' || value === 'openai' || value === 'openai-codex') {
    return value;
  }
  throw new Error(`Unsupported provider: ${value}. Supported providers: ollama, openrouter, openai, openai-codex.`);
}

async function runApprovalCommand(args: string[]): Promise<void> {
  const [decisionValue, runId, approvalId, fingerprint, ...optionArgs] = args;
  if ((decisionValue !== 'allow' && decisionValue !== 'deny') || !runId || !approvalId || !fingerprint) {
    throw new Error('Usage: agent-core approval <allow|deny> <run-id> <approval-id> <fingerprint> [options]');
  }
  const parsed = parseOptions(optionArgs);
  if (parsed.positionals.length > 0) throw new Error(`Unexpected approval arguments: ${parsed.positionals.join(' ')}`);
  const workspace = await loadWorkspace(path.resolve(parsed.options.root));
  let options = parsed.options.config
    ? applyConfiguration(parsed.options, await loadAgentCoreConfiguration(workspace.workspaceRoot, parsed.options.config))
    : parsed.options;
  const events = new JsonlEventRepository<AgentEvent>({ rootDir: workspace.runsDir, codec: agentEventCodec });
  const records: AgentEvent[] = [];
  for await (const envelope of events.read(runId)) records.push(envelope.event);
  const configured = records.find((event): event is Extract<AgentEvent, { type: 'run.configured' }> => event.type === 'run.configured');
  const startedTurn = records.find((event): event is Extract<AgentEvent, { type: 'turn.started' }> => event.type === 'turn.started');
  if (!configured || !startedTurn?.sessionId) throw new Error(`Run ${runId} does not contain enough persisted runtime/session identity to resolve an approval.`);
  options = { ...options, provider: parseProviderId(configured.configuration.provider.id), model: configured.configuration.model.id };
  const progress = new CliProgressRenderer({ showReasoning: options.showReasoning });
  const runtime = await createRuntime(options, workspace, progress, startedTurn.sessionId);
  const result = await runtime.agent.resolveApproval({ runId, approvalId, fingerprint, decision: decisionValue });
  printResult(result, progress);
  printPersistenceLocations(runtime, result);
  process.exitCode = resultExitCode(result);
}

async function runAuthCommand(args: string[]): Promise<void> {
  const [command, provider, ...extra] = args;
  if (!command || !provider || extra.length > 0) {
    throw new Error('Usage: agent-core auth <login|logout|status> <provider>');
  }
  const providerId = parseAuthProviderId(provider);
  switch (command) {
    case 'status':
      await printAuthStatus(providerId);
      return;
    case 'logout':
      await logoutAuth(providerId);
      return;
    case 'login':
      await loginAuth(providerId);
      return;
    default:
      throw new Error(`Unknown auth command: ${command}. Supported commands: login, logout, status.`);
  }
}

function parseAuthProviderId(value: string): CliAuthProviderId {
  if (value === 'openai' || value === 'openai-codex') {
    return value;
  }
  throw new Error(`Unsupported auth provider: ${value}. Supported auth providers: openai, openai-codex.`);
}

async function printAuthStatus(provider: CliAuthProviderId): Promise<void> {
  if (provider === 'openai') {
    const apiKeySet = Boolean(process.env.OPENAI_API_KEY?.trim());
    console.log('openai:');
    console.log(`  Provider: OpenAI Platform API`);
    console.log(`  API key: ${apiKeySet ? 'set in OPENAI_API_KEY' : 'not set'}`);
    console.log('  ChatGPT subscription auth: use auth login openai-codex.');
    return;
  }
  const store = new FileCredentialStore();
  const stored = await store.read(provider);
  console.log(`${provider}:`);
  console.log('  Provider: OpenAI Codex / ChatGPT subscription');
  console.log(`  Stored OAuth credentials: ${stored ? 'present' : 'not present'}`);
  if (stored?.expiresAt) {
    console.log(`  Access token expires: ${new Date(stored.expiresAt).toISOString()}`);
  }
}

async function logoutAuth(provider: CliAuthProviderId): Promise<void> {
  if (provider === 'openai') {
    process.exitCode = 1;
    console.error('openai uses OPENAI_API_KEY for API-key auth. Unset that environment variable to log out of the Platform provider.');
    return;
  }
  const store = new FileCredentialStore();
  await store.delete(provider);
  console.log(`Deleted stored credentials for ${provider}.`);
}

async function loginAuth(provider: CliAuthProviderId): Promise<void> {
  if (provider === 'openai') {
    process.exitCode = 1;
    console.error('openai is the OpenAI Platform API provider and uses OPENAI_API_KEY. Use auth login openai-codex for ChatGPT subscription auth.');
    return;
  }
  const store = new FileCredentialStore();
  await loginOpenAICodexDeviceCode({
    store,
    key: provider,
    onDeviceCode(info) {
      console.log('OpenAI Codex device login:');
      console.log(`  Open: ${info.verificationUri}`);
      console.log(`  Code: ${info.userCode}`);
      console.log(`  Expires in: ${String(Math.round(info.expiresInSeconds / 60))} minutes`);
    }
  });
  console.log(`Stored credentials for ${provider}.`);
}

export function createCliToolPolicy(options: CliToolPolicyOptions): ToolPolicy {
  const allowedRisks: ToolRisk[] = ['read'];
  if (options.apply) {
    allowedRisks.push('write', 'destructive');
  }
  if (options.allowShell) {
    allowedRisks.push('execute');
  }
  return {
    allowedRisks: [...new Set(allowedRisks)],
    ...(options.dryRun ? { dryRunWrites: true } : {})
  };
}

function toolPolicyFromOptions(options: CliOptions): ToolPolicy {
  if (options.configuration) return createConfiguredCliToolPolicy(options.configuration, options.dryRun);
  return createCliToolPolicy(options);
}

export function createConfiguredCliToolPolicy(configuration: AgentCoreConfiguration, dryRun = false): ToolPolicy {
  return Object.freeze({ allowedRisks: Object.freeze([...configuration.authorization.allowedRisks]), ...(dryRun ? { dryRunWrites: true } : {}) });
}

async function openSession(options: CliOptions, workspace: WorkspaceLayout, providerRuntime: CliProviderRuntime, persistedSessionId?: string): Promise<{ repository: JsonlSessionRepository; session: AgentSession }> {
  const repository = new JsonlSessionRepository({ rootDir: workspace.sessionsDir });
  let session: AgentSession | undefined;
  if (persistedSessionId !== undefined) {
    session = await repository.open(persistedSessionId);
  } else if (options.session) {
    try {
      session = await repository.open(options.session);
    } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      session = await repository.create({
        id: options.session,
        workspaceRoot: workspace.workspaceRoot,
        provider: providerRuntime.providerId,
        model: providerRuntime.model
      });
    }
  } else if (options.resume) {
    const latest = (await repository.list(workspace.workspaceRoot))[0];
    if (latest) session = await repository.open(latest.id);
  }

  session ??= await repository.create({
    workspaceRoot: workspace.workspaceRoot,
    provider: providerRuntime.providerId,
    model: providerRuntime.model
  });

  validateSessionWorkspace(session, workspace);
  if (options.branch) {
    await repository.branchFrom(session.id, options.branch, 'cli branch');
    session = await repository.open(session.id);
  }
  return { repository, session };
}

function validateSessionWorkspace(session: AgentSession, workspace: WorkspaceLayout): void {
  if (path.resolve(session.header.workspaceRoot) !== workspace.workspaceRoot) {
    throw new Error([
      `Session belongs to a different workspace root: ${session.header.workspaceRoot}`,
      `Current workspace root: ${workspace.workspaceRoot}`
    ].join('\n'));
  }
}

export async function runInteractive(
  agent: AgentRuntime,
  progress: CliProgressRenderer = new CliProgressRenderer(),
  streams: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout }
): Promise<void> {
  const input = createInterface({ input: streams.input, output: streams.output, prompt: 'agent-core> ' });
  let activeRun: Promise<void> | undefined;
  let pendingApproval: AgentApprovalSuspension | undefined;
  let closing = false;
  writeLine(streams.output, 'Agent Core interactive. Type exit or quit to leave.');
  input.prompt();
  for await (const line of input) {
    const task = normalizeTaskInput(line);
    let deferPromptUntilRunFinishes = false;
    if (task === 'exit' || task === 'quit') {
      closing = true;
      if (activeRun) {
        agent.abort('Interactive session closed.');
        await activeRun;
      }
      break;
    }
    if (task.length > 0) {
      try {
        if (pendingApproval !== undefined && (task === 'allow' || task === 'deny')) {
          const suspension = pendingApproval;
          const approval = suspension.pendingApprovals[0];
          if (approval === undefined) throw new Error('Approval suspension contains no pending approval.');
          pendingApproval = undefined;
          activeRun = agent.resolveApproval({
            runId: suspension.runId,
            approvalId: approval.approvalId,
            fingerprint: approval.fingerprint,
            decision: task
          }).then((result) => {
            printResult(result, progress, streams.output);
            if (result.state === 'suspended') {
              pendingApproval = result;
              printApprovalPrompt(result, streams.output);
            }
          }).catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
          }).finally(() => {
            activeRun = undefined;
            if (!closing) input.prompt();
          });
          deferPromptUntilRunFinishes = true;
        } else if (pendingApproval !== undefined) {
          writeLine(streams.output, 'Approval required. Enter allow or deny.');
        } else if (task.startsWith('/')) {
          writeLine(streams.output, executeInteractiveCommand(agent, task).message);
        } else if (activeRun) {
          writeLine(streams.output, 'A run is active. Use /follow to queue work or /abort to stop it.');
        } else {
          writeLine(streams.output, 'Run started. Slash commands remain available; use /abort to stop the active run.');
          activeRun = runTaskAndFollowUps(agent, task, progress, streams.output)
            .then((result) => {
              if (result.state === 'suspended') {
                pendingApproval = result;
                printApprovalPrompt(result, streams.output);
              }
            })
            .catch((error: unknown) => {
              console.error(error instanceof Error ? error.message : String(error));
              process.exitCode = 1;
            })
            .finally(() => {
              activeRun = undefined;
              if (!closing) {
                input.prompt();
              }
            });
          deferPromptUntilRunFinishes = true;
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    if (!deferPromptUntilRunFinishes) {
      input.prompt();
    }
  }
  input.close();
}

async function runTaskAndFollowUps(agent: AgentRuntime, task: string, progress: CliProgressRenderer, output: Writable = process.stdout): Promise<AgentRunResult> {
  let result = await agent.run({ task });
  printResult(result, progress, output);
  if (result.state === 'suspended') return result;
  for (const followUp of agent.takeFollowUps(runIdOf(result))) {
    result = await agent.run({
      task: followUp.task,
      ...(followUp.instructions ? { instructions: followUp.instructions } : {})
    });
    printResult(result, progress, output);
    if (result.state === 'suspended') break;
  }
  return result;
}

function printApprovalPrompt(result: AgentApprovalSuspension, output: Writable): void {
  const approval = result.pendingApprovals[0];
  if (approval === undefined) return;
  writeLine(output, `Approval required for ${approval.toolName}.`);
  writeLine(output, `Reason: ${approval.reason}`);
  writeLine(output, `Input: ${JSON.stringify(approval.input)}`);
  writeLine(output, `Effects: ${JSON.stringify(approval.effects)}`);
  writeLine(output, 'Enter allow or deny.');
}

function writeLine(output: Writable, text: string): void {
  output.write(`${text}\n`);
}

function printResult(result: AgentRunResult, progress?: CliProgressRenderer, output: Writable = process.stdout): void {
  if (result.state === 'suspended') {
    writeLine(output, 'Execution: Waiting for approval');
    writeLine(output, `Run: ${result.runId}`);
    for (const approval of result.pendingApprovals) {
      writeLine(output, `Approval: ${approval.approvalId} ${approval.toolName} (${approval.reason})`);
      writeLine(output, `Fingerprint: ${approval.fingerprint}`);
      writeLine(output, `Allow: agent-core approval allow ${result.runId} ${approval.approvalId} ${approval.fingerprint}`);
      writeLine(output, `Deny: agent-core approval deny ${result.runId} ${approval.approvalId} ${approval.fingerprint}`);
    }
    return;
  }
  const terminal = result.terminal;
  if (!progress?.consumeFinalAlreadyPrinted()) {
    const message = terminal.candidate.status === 'absent'
      ? ('errorMessage' in terminal ? terminal.errorMessage : 'Run ended without a candidate.')
      : terminal.candidate.message;
    writeLine(output, `\n${message}`);
  }
  writeLine(output, `Execution: ${title(terminal.executionStatus)}`);
  writeLine(output, `Candidate: ${title(terminal.candidate.status)}`);
  if (terminal.modelTerminationReason) writeLine(output, `Model termination: ${title(terminal.modelTerminationReason.replaceAll('_', ' '))}`);
  writeLine(output, `Verification: ${title(terminal.verificationStatus.replaceAll('_', ' '))}`);
  if ('errorMessage' in terminal) writeLine(output, `Reason: ${terminal.errorMessage}`);
  if (terminal.checkResults.length > 0) {
    writeLine(output, `Checks:\n${terminal.checkResults.map((check) => `- ${check.id}: ${check.requirement}/${check.verdict} - ${check.summary}`).join('\n')}`);
  }
  const advisoryFailures = terminal.checkResults.filter((check) => check.requirement === 'advisory' && check.verdict !== 'passed').length;
  if (advisoryFailures > 0) writeLine(output, `Advisory checks: ${String(advisoryFailures)} failed or unknown`);
  for (const diagnostic of result.deliveryDiagnostics) writeLine(output, `Delivery diagnostic (${diagnostic.eventType}): ${diagnostic.message}`);
}

export function resultExitCode(result: AgentRunResult): number {
  if (result.state === 'suspended') return 7;
  if (result.terminal.executionStatus === 'aborted') return 130;
  if (result.terminal.executionStatus === 'failed') return 1;
  if (result.terminal.candidate.status === 'partial' || result.terminal.candidate.status === 'indeterminate') return 2;
  if (result.terminal.verificationStatus === 'failed') return 3;
  if (result.terminal.verificationStatus === 'inconclusive') return 4;
  return 0;
}

function title(value: string): string { return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`; }

function printPersistenceLocations(runtime: CliRuntime, result: AgentRunResult): void {
  console.error(`\nLedger: ${runtime.events.location(runIdOf(result))}`);
  console.error(`Session: ${runtime.sessions.location(runtime.session.id)}`);
}

function runIdOf(result: AgentRunResult): string {
  return result.state === 'suspended' ? result.runId : result.terminal.runId;
}

export class CliProgressRenderer {
  private readonly stdout: Writable;
  private readonly stderr: Writable;
  private readonly showReasoning: boolean;
  private readonly hiddenReasoningHeartbeatChars: number;
  private readonly hiddenReasoningHeartbeatMs: number;
  private readonly streamedTurns = new Set<number>();
  private readonly reasoningTurns = new Set<number>();
  private readonly reasoningSummaryTurns = new Set<number>();
  private readonly reasoningUnavailableTurns = new Set<number>();
  private readonly streamedToolCallTurns = new Set<number>();
  private readonly streamedToolCallKeys = new Set<string>();
  private readonly statusKeys = new Set<string>();
  private readonly hiddenReasoningProgress = new Map<number, { chars: number; timestamp: number }>();
  private answerLineOpen = false;
  private reasoningLineOpen = false;
  private finalAlreadyPrinted = false;

  constructor(options: {
    stdout?: Writable;
    stderr?: Writable;
    showReasoning?: boolean;
    hiddenReasoningHeartbeatChars?: number;
    hiddenReasoningHeartbeatMs?: number;
  } = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.showReasoning = options.showReasoning ?? false;
    this.hiddenReasoningHeartbeatChars = Math.max(1, options.hiddenReasoningHeartbeatChars ?? 1_200);
    this.hiddenReasoningHeartbeatMs = Math.max(1, options.hiddenReasoningHeartbeatMs ?? 8_000);
  }

  handle(event: AgentProgressEvent): void {
    if (event.type === 'turn.started') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.streamedTurns.clear();
      this.reasoningTurns.clear();
      this.reasoningSummaryTurns.clear();
      this.reasoningUnavailableTurns.clear();
      this.streamedToolCallTurns.clear();
      this.streamedToolCallKeys.clear();
      this.statusKeys.clear();
      this.hiddenReasoningProgress.clear();
      this.stderr.write(`\n[turn] ${event.task}\n`);
    } else if (event.type === 'assistant.started') {
      this.finishReasoningLine();
      this.stderr.write(`[assistant ${String(event.turnIndex)}] started\n`);
    } else if (event.type === 'assistant.delta') {
      if (event.delta.length > 0) {
        this.finishReasoningLine();
        this.stdout.write(event.delta);
        this.answerLineOpen = true;
        this.streamedTurns.add(event.turnIndex);
      }
    } else if (event.type === 'assistant.reasoning') {
      this.finishAnswerLine();
      if (this.showReasoning && event.channel === 'summary') {
        if (!this.reasoningSummaryTurns.has(event.turnIndex)) {
          this.finishReasoningLine();
          this.stderr.write(`[assistant ${String(event.turnIndex)}] reasoning summary\n`);
          this.reasoningSummaryTurns.add(event.turnIndex);
        }
        this.stderr.write(event.delta);
        this.reasoningLineOpen = true;
      } else if (this.showReasoning && event.channel !== 'summary' && !this.reasoningTurns.has(event.turnIndex)) {
        this.reasoningTurns.add(event.turnIndex);
        this.hiddenReasoningProgress.set(event.turnIndex, { chars: event.accumulated.length, timestamp: Date.now() });
        this.maybeWriteHiddenReasoningHeartbeat(event);
      } else if (!this.reasoningTurns.has(event.turnIndex)) {
        this.stderr.write(`[assistant ${String(event.turnIndex)}] reasoning\n`);
        this.reasoningTurns.add(event.turnIndex);
        this.hiddenReasoningProgress.set(event.turnIndex, { chars: event.accumulated.length, timestamp: Date.now() });
      } else {
        this.maybeWriteHiddenReasoningHeartbeat(event);
      }
    } else if (event.type === 'assistant.status') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      const key = `${String(event.turnIndex)}:${event.message}`;
      if (!this.statusKeys.has(key)) {
        this.statusKeys.add(key);
        this.stderr.write(`[assistant ${String(event.turnIndex)}] ${event.message}\n`);
      }
    } else if (event.type === 'model.failed') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.stderr.write(`[assistant ${String(event.turnIndex)}] model failed: ${formatModelFailure(event.diagnostic)}\n`);
    } else if (event.type === 'tool.call.received') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.streamedToolCallTurns.add(event.turnIndex);
      const key = `${String(event.turnIndex)}:${JSON.stringify(event.toolCall)}`;
      if (!this.streamedToolCallKeys.has(key)) {
        this.streamedToolCallKeys.add(key);
        this.stderr.write(`[assistant ${String(event.turnIndex)}] tool call: ${formatToolCall(event.toolCall)}\n`);
      }
    } else if (event.type === 'assistant.ended') {
      const toolCalls = event.toolCalls ?? [];
      this.writeUnavailableReasoningSummaryIfNeeded(event.turnIndex);
      if (toolCalls.length > 0 && !this.streamedToolCallTurns.has(event.turnIndex)) {
        this.finishAnswerLine();
        this.finishReasoningLine();
        this.stderr.write(`[assistant ${String(event.turnIndex)}] tool calls:\n${toolCalls.map((call) => `  - ${formatToolCall(call)}`).join('\n')}\n`);
      } else if (event.content.trim().length > 0 && this.streamedTurns.has(event.turnIndex)) {
        this.finishReasoningLine();
        this.finishAnswerLine();
        this.finalAlreadyPrinted = true;
      }
    } else if (event.type === 'assistant.interrupted') {
      if (event.content.trim().length > 0 && this.streamedTurns.has(event.turnIndex)) {
        this.finishReasoningLine();
        this.finishAnswerLine();
      }
      if (event.reasoningSummary !== undefined && this.showReasoning) {
        this.reasoningSummaryTurns.add(event.turnIndex);
      }
      this.writeUnavailableReasoningSummaryIfNeeded(event.turnIndex);
      this.stderr.write(`[assistant ${String(event.turnIndex)}] interrupted before final response\n`);
    } else if (event.type === 'tool.started') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.stderr.write(`[tool ${String(event.turnIndex)}] running ${formatToolCall(event.input)}\n`);
    } else if (event.type === 'tool.updated') {
      const message = cliProgressMessage(event.progress);
      if (event.progress.type !== 'status' || event.progress.stage !== 'executing') {
        this.finishAnswerLine();
        this.finishReasoningLine();
        this.stderr.write(`[tool ${String(event.turnIndex)}] ${event.toolName}: ${message}\n`);
      }
    } else if (event.type === 'tool.ended') {
      this.finishAnswerLine();
      this.finishReasoningLine();
      this.stderr.write(formatToolResult(event.turnIndex, event.toolName, event.observation));
    } else {
      this.finishReasoningLine();
      this.finishAnswerLine();
    }
  }

  consumeFinalAlreadyPrinted(): boolean {
    const value = this.finalAlreadyPrinted;
    this.finalAlreadyPrinted = false;
    return value;
  }

  private finishAnswerLine(): void {
    if (!this.answerLineOpen) {
      return;
    }
    this.stdout.write('\n');
    this.answerLineOpen = false;
  }

  private finishReasoningLine(): void {
    if (!this.reasoningLineOpen) {
      return;
    }
    this.stderr.write('\n');
    this.reasoningLineOpen = false;
  }

  private maybeWriteHiddenReasoningHeartbeat(event: Extract<AgentProgressEvent, { type: 'assistant.reasoning' }>): void {
    const previous = this.hiddenReasoningProgress.get(event.turnIndex);
    const now = Date.now();
    const chars = event.accumulated.length;
    if (!previous || chars - previous.chars >= this.hiddenReasoningHeartbeatChars || now - previous.timestamp >= this.hiddenReasoningHeartbeatMs) {
      this.stderr.write(`[assistant ${String(event.turnIndex)}] reasoning still streaming (${String(chars)} chars hidden)\n`);
      this.hiddenReasoningProgress.set(event.turnIndex, { chars, timestamp: now });
    }
  }

  private writeUnavailableReasoningSummaryIfNeeded(turnIndex: number): void {
    if (!this.showReasoning || !this.reasoningTurns.has(turnIndex) || this.reasoningSummaryTurns.has(turnIndex) || this.reasoningUnavailableTurns.has(turnIndex)) {
      return;
    }
    this.finishAnswerLine();
    this.finishReasoningLine();
    this.stderr.write(`[assistant ${String(turnIndex)}] reasoning summary unavailable\n`);
    this.reasoningUnavailableTurns.add(turnIndex);
  }
}

function formatToolCall(toolCall: ToolCall): string {
  const input =
    toolCall.input.kind === 'json'
      ? compactForDisplay(redactLargeToolArguments(toolCall.input.value), 300)
      : compactForDisplay(redactLargeToolText(toolCall.input.value), 300);
  return input === '{}' || input.length === 0 ? toolCall.name : `${toolCall.name} ${input}`;
}

function formatToolResult(turnIndex: number, toolName: string, observation: ToolObservation): string {
  const status = observation.ok ? 'ok' : 'failed';
  const turnLabel = String(turnIndex);
  const artifactRefs = (observation.content ?? []).flatMap((item) => item.type === 'text' ? [] : [item.artifact]);
  const artifacts = artifactRefs.length > 0
    ? `\n[tool ${turnLabel}] artifacts: ${artifactRefs.map((artifact) => artifact.label ?? artifact.artifactId).join(', ')}`
    : '';
  return `[tool ${turnLabel}] ${status} ${toolName} - ${observation.summary}${artifacts}\n`;
}

function formatModelFailure(diagnostic: Extract<AgentProgressEvent, { type: 'model.failed' }>['diagnostic']): string {
  const parts = [
    `provider=${diagnostic.provider}`,
    `code=${diagnostic.code}`,
    `retryable=${String(diagnostic.retryable)}`,
    diagnostic.transport ? `transport=${diagnostic.transport}` : '',
    diagnostic.eventType ? `event=${diagnostic.eventType}` : ''
  ].filter((part) => part.length > 0);
  return parts.join(' ');
}

function redactLargeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, shouldSummarizeArgument(key, value) ? summarizeArgument(value) : value]));
}

function redactLargeToolText(input: string): string {
  return input.length > 180 ? summarizeArgument(input) : input;
}

function shouldSummarizeArgument(key: string, value: unknown): boolean {
  return typeof value === 'string' && (key === 'content' || key === 'oldText' || key === 'newText' || value.length > 180);
}

function summarizeArgument(value: unknown): string {
  if (typeof value !== 'string') {
    return compactForDisplay(value, 180);
  }
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > 80 ? `${singleLine.slice(0, 80)}... (${String(value.length)} chars)` : `${singleLine} (${String(value.length)} chars)`;
}

function compactForDisplay(value: unknown, maxLength: number): string {
  const text = JSON.stringify(value);
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 14)}... [truncated]` : text;
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function requireValue(key: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${key} requires a value.`);
  }
  return value;
}

function parsePositiveIntegerOption(key: string, value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return number;
}

function reasoningFromEffort(effort: ModelReasoningEffort): ModelReasoningRequest {
  return effort === 'none' ? { strategy: 'disabled' } : { strategy: 'effort', effort };
}

function cliProgressMessage(progress: ToolProgress): string {
  switch (progress.type) {
    case 'status': return progress.message ?? progress.stage;
    case 'output': return `${progress.stream}: ${progress.text}`;
    case 'patch': return `patch ${String(progress.changes.length)} change${progress.changes.length === 1 ? '' : 's'}`;
    case 'metric': return `${progress.name}: ${String(progress.value)}${progress.unit ? ` ${progress.unit}` : ''}`;
  }
}

function printHelp(): void {
  console.log(`Agent Core CLI

Usage:
  agent-core "summarize how tests are organized" [--provider ollama] [--model llama3.1] [--root .]
  agent-core "add tests for the parser" --apply --allow-shell [--provider ollama] [--model llama3.1]
  agent-core "summarize this workspace" --provider openrouter [--model openrouter/auto]
  agent-core "summarize this workspace" --provider openai [--model gpt-5.6-sol]
  agent-core "summarize this workspace" --provider openai-codex [--model gpt-5.6]
  agent-core auth status openai
  agent-core auth login openai-codex
  agent-core approval <allow|deny> <run-id> <approval-id> <fingerprint> [--root .] [--config agent-core.config.json]
  agent-core

Safety defaults:
  Structured patch mutation is disabled unless --apply or --dry-run is supplied.
  Ambient shell execution is disabled unless --allow-shell is supplied.
  Ambient shell authority runs with this Agent Core process's permissions and can indirectly read, write, or delete files, access the network, and start child processes.
  Persistent ambient processes block conflicting workspace tools until they exit or stop.

Common options:
  --root <dir>           Workspace root. Default: current directory.
  --config <path>        Load committed workspace instructions, provider/model, tools, approvals, checks, limits, and session policy.
  --provider <name>      Model provider. Supported: ollama, openrouter, openai, openai-codex. Default: AGENT_CORE_PROVIDER or ollama.
  --model <name>         Model name. Default: AGENT_CORE_MODEL or the provider default.
  --provider-endpoint <url>
                         Provider endpoint override. Ollama host or provider base URL.
  --max-output-tokens <n>
                         Optional per-request output token override.
  --temperature <n>      Provider temperature.
  --reasoning-effort <level>
                         Optional reasoning effort: none, minimal, low, medium, high, xhigh, max.
  --show-reasoning       Stream separate model reasoning or reasoning summaries to stderr.
  --tui                  Use the terminal-ui TUI surface for direct task output.
  --plain                Use readline fallback for interactive mode.
  --apply                Allow apply_patch add, update, move, and delete operations.
  --dry-run              Validate writes without changing files.
  --allow-shell          Allow ambient shell execution with process-level file, network, and child-process authority. Does not authorize apply_patch.
  --resume               Resume the latest session for this workspace.
  --session <path>       Open or create a specific session JSONL file.
  --branch <entry-id>    Branch the active session from a prior entry before running.

OpenRouter:
  Set OPENROUTER_API_KEY before using --provider openrouter.
  Optional attribution: OPENROUTER_APP_URL and OPENROUTER_APP_TITLE.

OpenAI:
  --provider openai uses the OpenAI Platform API and OPENAI_API_KEY.
  --provider openai-codex uses ChatGPT/Codex subscription auth stored outside the workspace.
  Run agent-core auth login openai-codex before using --provider openai-codex.
`);
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entrypoint) === realpathSync(modulePath);
  } catch {
    return path.resolve(entrypoint) === modulePath;
  }
}
