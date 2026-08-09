import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type ModelReasoningRequest, parseModelReasoningRequest } from '@agent-core/model';
import { parseJsonObject } from '@agent-core/json';

export interface AgentCoreInstructionConfiguration { readonly path: string }
export interface AgentCoreCheckConfiguration { readonly id: string; readonly command: string; readonly timeoutMs?: number; readonly maxOutputBytes?: number }
export interface AgentCoreLimitConfiguration {
  readonly maxConcurrentToolCalls?: number;
  readonly modelTurns?: number;
  readonly totalToolCalls?: number;
  readonly repeatedIdenticalToolCalls?: number;
  readonly elapsedMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly activeImageCount?: number;
  readonly activeImageBytes?: number;
  readonly activeImageTokens?: number;
  readonly knownCost?: { readonly amount: number; readonly currency: string };
  readonly consecutiveProviderFailures?: number;
  readonly consecutiveToolFailures?: number;
  readonly providerRetries?: number;
}
export interface AgentCoreConfiguration {
  readonly version: 1;
  readonly provider: 'ollama' | 'openrouter' | 'openai' | 'openai-codex';
  readonly model: string;
  readonly reasoning?: ModelReasoningRequest;
  readonly instructions: readonly AgentCoreInstructionConfiguration[];
  readonly tools: { readonly enabled: readonly string[] };
  readonly authorization: { readonly allowedRisks: readonly ('read' | 'write' | 'execute' | 'network' | 'destructive')[]; readonly requireApprovalFor: readonly ('read' | 'write' | 'execute' | 'network' | 'destructive')[] };
  readonly verification: { readonly required: readonly AgentCoreCheckConfiguration[]; readonly advisory: readonly AgentCoreCheckConfiguration[] };
  readonly limits?: AgentCoreLimitConfiguration;
  readonly session: { readonly mode: 'new' | 'latest'; readonly id?: string };
}

export async function loadAgentCoreConfiguration(rootDir: string, configPath = 'agent-core.config.json'): Promise<AgentCoreConfiguration> {
  const root = await fs.realpath(path.resolve(rootDir));
  const absolute = path.resolve(root, configPath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Configuration escapes the workspace root: ${configPath}`);
  const realConfiguration = await fs.realpath(absolute);
  if (realConfiguration !== root && !realConfiguration.startsWith(`${root}${path.sep}`)) throw new Error(`Configuration symlink escapes the workspace root: ${configPath}`);
  const value: unknown = JSON.parse(await fs.readFile(realConfiguration, 'utf8'));
  return parseAgentCoreConfiguration(value);
}

export function parseAgentCoreConfiguration(input: unknown): AgentCoreConfiguration {
  const value = parseJsonObject(input, { maxDepth: 16, maxCollectionEntries: 10_000, maxStringBytes: 1_000_000, maxTotalBytes: 4_000_000 });
  if (value.version !== 1) throw new Error('Agent Core configuration must be a version 1 object.');
  if (Object.keys(value).some((key) => !['version', 'provider', 'model', 'reasoning', 'instructions', 'tools', 'authorization', 'verification', 'limits', 'session'].includes(key))) throw new Error('Agent Core configuration contains unknown fields.');
  if (!isProvider(value.provider) || typeof value.model !== 'string' || value.model.length === 0) throw new Error('Configuration provider/model is invalid.');
  if (!instructionArray(value.instructions)) throw new Error('Workspace instructions must contain confined relative paths.');
  if (!isRecord(value.tools) || Object.keys(value.tools).some((key) => key !== 'enabled') || !stringArray(value.tools.enabled)) throw new Error('Project tool configuration is invalid.');
  const authorization = value.authorization;
  if (!isRecord(authorization) || Object.keys(authorization).some((key) => key !== 'allowedRisks' && key !== 'requireApprovalFor') || !riskArray(authorization.allowedRisks) || !riskArray(authorization.requireApprovalFor)) throw new Error('Project authorization configuration is invalid.');
  const allowedRisks = authorization.allowedRisks;
  const approvalRisks = authorization.requireApprovalFor;
  if (!approvalRisks.every((risk) => allowedRisks.includes(risk))) throw new Error('Approval risks must also be present in authorization.allowedRisks.');
  const verification = value.verification;
  if (!isRecord(verification) || Object.keys(verification).some((key) => key !== 'required' && key !== 'advisory') || !checkArray(verification.required) || !checkArray(verification.advisory)) throw new Error('Verification configuration is invalid.');
  const session = value.session;
  if (!sessionConfiguration(session)) throw new Error('Session configuration is invalid.');
  const reasoning = value.reasoning === undefined ? undefined : parseModelReasoningRequest(value.reasoning);
  const limits = value.limits;
  let ownedLimits: AgentCoreLimitConfiguration | undefined;
  if (limits !== undefined) {
    if (!validLimits(limits)) throw new Error('Run limits are invalid.');
    ownedLimits = limits;
  }
  const checkIds = verification.required.map((item) => item.id).concat(verification.advisory.map((item) => item.id));
  if (new Set(checkIds).size !== checkIds.length) throw new Error('Verification check IDs must be unique.');
  return Object.freeze({
    version: 1,
    provider: value.provider,
    model: value.model,
    ...(reasoning === undefined ? {} : { reasoning }),
    instructions: Object.freeze(value.instructions.map((item) => Object.freeze({ path: item.path }))),
    tools: Object.freeze({ enabled: Object.freeze(value.tools.enabled.map((tool) => tool)) }),
    authorization: Object.freeze({ allowedRisks: Object.freeze(allowedRisks.map((risk) => risk)), requireApprovalFor: Object.freeze(approvalRisks.map((risk) => risk)) }),
    verification: Object.freeze({ required: Object.freeze(verification.required.map(snapshotCheck)), advisory: Object.freeze(verification.advisory.map(snapshotCheck)) }),
    ...(ownedLimits === undefined ? {} : { limits: Object.freeze({ ...ownedLimits }) }),
    session: Object.freeze({ ...session })
  });
}

function snapshotCheck(check: AgentCoreCheckConfiguration): AgentCoreCheckConfiguration {
  return Object.freeze({ id: check.id, command: check.command, ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }), ...(check.maxOutputBytes === undefined ? {} : { maxOutputBytes: check.maxOutputBytes }) });
}

function isProvider(value: unknown): value is AgentCoreConfiguration['provider'] { return value === 'ollama' || value === 'openrouter' || value === 'openai' || value === 'openai-codex'; }
function instructionArray(value: unknown): value is readonly AgentCoreInstructionConfiguration[] { return Array.isArray(value) && value.every(item => isRecord(item) && Object.keys(item).every((key) => key === 'path') && relativePath(item.path)); }
function checkArray(value: unknown): value is readonly AgentCoreCheckConfiguration[] { return Array.isArray(value) && value.every(item => isRecord(item) && Object.keys(item).every((key) => ['id', 'command', 'timeoutMs', 'maxOutputBytes'].includes(key)) && typeof item.id === 'string' && item.id.length > 0 && typeof item.command === 'string' && item.command.length > 0 && optionalPositive(item.timeoutMs) && optionalPositive(item.maxOutputBytes)); }
function sessionConfiguration(value: unknown): value is AgentCoreConfiguration['session'] { return isRecord(value) && Object.keys(value).every((key) => key === 'mode' || key === 'id') && (value.mode === 'new' || value.mode === 'latest') && (value.id === undefined || (typeof value.id === 'string' && value.id.trim().length > 0)); }
function optionalPositive(value: unknown): boolean { return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0); }
function validLimits(value: unknown): value is AgentCoreLimitConfiguration {
  if (!isRecord(value)) return false;
  const numeric = ['maxConcurrentToolCalls', 'modelTurns', 'totalToolCalls', 'repeatedIdenticalToolCalls', 'elapsedMs', 'promptTokens', 'completionTokens', 'activeImageCount', 'activeImageBytes', 'activeImageTokens', 'consecutiveProviderFailures', 'consecutiveToolFailures', 'providerRetries'];
  if (Object.keys(value).some((key) => ![...numeric, 'knownCost'].includes(key))) return false;
  if (numeric.some((key) => value[key] !== undefined && !optionalPositive(value[key]))) return false;
  return value.knownCost === undefined || (isRecord(value.knownCost) && typeof value.knownCost.amount === 'number' && Number.isFinite(value.knownCost.amount) && value.knownCost.amount > 0 && typeof value.knownCost.currency === 'string' && value.knownCost.currency.trim().length > 0);
}
function riskArray(value: unknown): value is AgentCoreConfiguration['authorization']['allowedRisks'] { return Array.isArray(value) && value.every(item => item === 'read' || item === 'write' || item === 'execute' || item === 'network' || item === 'destructive'); }
function stringArray(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0); }
function relativePath(value: unknown): boolean { return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split(/[\\/]/u).includes('..'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
