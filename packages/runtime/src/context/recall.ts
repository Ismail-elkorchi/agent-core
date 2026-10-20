import { hashJson } from '@agent-core/persistence';
import * as z from 'zod';
import { ownPromptContextInputs, type PromptContextItemInput } from '../inference/prompt-material.js';
import { qualifiedMaterialRefSchema, type QualifiedMaterialRef } from '../material/contracts.js';
import { skillSelectionReferencesSchema, type SkillReference } from '@agent-core/skills';
import type { HistorySourceCut } from '../history/contracts.js';
import type { AgentEffectiveInstruction } from '../run/contracts.js';

export interface AgentContextBoundary {
  readonly runId: string;
  readonly turnId: string;
  readonly requestAttempt: number;
  readonly instructionHash: string;
  readonly historyCut?: HistorySourceCut;
}
export interface AgentContextBudget { readonly maxItems: number; readonly maxBytes: number }
export interface AgentContextRequest {
  readonly task: string;
  readonly turnIndex: number;
  readonly instructions: readonly AgentEffectiveInstruction[];
  readonly signal: AbortSignal;
  /** Unix milliseconds. The supplier must stop remote work when signal aborts. */
  readonly deadline: number;
  readonly budget: AgentContextBudget;
  readonly boundary: AgentContextBoundary;
}
export interface AgentContextResult {
  readonly items: readonly PromptContextItemInput[];
  /** Hints only. Discovering zero candidates never clears a committed selection. */
  readonly candidates?: {
    readonly materials?: readonly QualifiedMaterialRef[] | undefined;
    readonly skills?: readonly SkillReference[] | undefined;
  };
}
export type AgentContextProvider = (request: AgentContextRequest) => AgentContextResult | Promise<AgentContextResult>;
export interface AgentContextPolicy extends AgentContextBudget { readonly timeoutMs: number }
export const DEFAULT_AGENT_CONTEXT_POLICY: AgentContextPolicy = Object.freeze({ maxItems: 64, maxBytes: 64 * 1024, timeoutMs: 5000 });
const policySchema = z.strictObject({ maxItems: z.int().positive().max(1000), maxBytes: z.int().positive().max(4 * 1024 * 1024), timeoutMs: z.int().positive().max(60000) }).readonly();
export function parseAgentContextPolicy(input: Partial<AgentContextPolicy> = {}): AgentContextPolicy {
  return policySchema.parse({ ...DEFAULT_AGENT_CONTEXT_POLICY, ...input });
}
const candidateSchema = z.strictObject({ materials: z.array(qualifiedMaterialRefSchema).max(256).readonly().optional(), skills: skillSelectionReferencesSchema.optional() }).readonly();
const resultSchema = z.strictObject({ items: z.array(z.unknown()).max(1000).readonly(), candidates: candidateSchema.optional() }).readonly();
export interface AgentContextCollection {
  readonly result: AgentContextResult;
  readonly diagnostic?: 'failed' | 'deadline' | 'stale' | 'budget' | 'busy';
}
const pendingOwners = new WeakSet();
/** One bounded supplier invocation. A late callback can never publish into this result. */
export async function collectOptionalContext(input: {
  /** Runtime-owned identity; independent sessions must use different owners. */
  readonly owner: object;
  readonly provider: AgentContextProvider;
  readonly request: Omit<AgentContextRequest, 'signal' | 'deadline' | 'budget'>;
  readonly signal: AbortSignal;
  readonly obsoleteSignal?: AbortSignal;
  readonly policy?: Partial<AgentContextPolicy>;
  readonly isCurrent: () => boolean | Promise<boolean>;
  readonly validateCandidates?: (candidates: NonNullable<AgentContextResult['candidates']>, signal: AbortSignal) => Promise<void>;
}): Promise<AgentContextCollection> {
  input.signal.throwIfAborted();
  const policy = parseAgentContextPolicy(input.policy);
  const empty = (diagnostic: NonNullable<AgentContextCollection['diagnostic']>): AgentContextCollection => ({ result: { items: [] }, diagnostic });
  // A supplier that ignores cancellation may keep its own work alive, but cannot accumulate
  // additional runtime-owned attempts, validation tasks or result publication handlers.
  if (pendingOwners.has(input.owner)) return empty('busy');
  const controller = new AbortController();
  const timeout = { expired: false };
  const abort = () => { controller.abort(input.signal.reason); };
  const obsolete = () => { controller.abort(new Error('Optional context boundary became obsolete.')); };
  input.obsoleteSignal?.addEventListener('abort', obsolete, { once: true });
  if (input.obsoleteSignal?.aborted) obsolete();
  input.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timeout.expired = true; controller.abort(new Error('Optional context deadline exceeded.')); }, policy.timeoutMs);
  const deadline = Date.now() + policy.timeoutMs;
  try {
    const request = Object.freeze({ ...input.request, signal: controller.signal, deadline, budget: Object.freeze({ maxItems: policy.maxItems, maxBytes: policy.maxBytes }) });
    const cancelled = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => { reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Optional context collection aborted.')); };
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    pendingOwners.add(input.owner);
    const attempt = Promise.resolve().then(async (): Promise<AgentContextCollection> => {
      controller.signal.throwIfAborted();
      const result = await input.provider(request);
      controller.signal.throwIfAborted();
      if (!await input.isCurrent()) return empty('stale');
      controller.signal.throwIfAborted();
      const parsed = resultSchema.parse(result);
      // Account the complete returned envelope before decoding large presentation strings.
      if (parsed.items.length + (parsed.candidates?.materials?.length ?? 0) + (parsed.candidates?.skills?.length ?? 0) > policy.maxItems || Buffer.byteLength(JSON.stringify(parsed)) > policy.maxBytes)
        return empty('budget');
      const owned = Object.freeze({ items: ownPromptContextInputs(parsed.items), ...(parsed.candidates ? { candidates: parsed.candidates } : {}) });
      if (owned.candidates && input.validateCandidates) await input.validateCandidates(owned.candidates, controller.signal);
      controller.signal.throwIfAborted();
      if (!await input.isCurrent()) return empty('stale');
      controller.signal.throwIfAborted();
      return { result: owned };
    });
    const release = () => { pendingOwners.delete(input.owner); };
    void attempt.then(release, release);
    return await Promise.race([attempt, cancelled]);
  } catch {
    input.signal.throwIfAborted();
    return empty(timeout.expired ? 'deadline' : input.obsoleteSignal?.aborted ? 'stale' : 'failed');
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', abort);
    input.obsoleteSignal?.removeEventListener('abort', obsolete);
    controller.abort(new Error('Optional context collection ended.'));
  }
}
export function contextRecallNotice(candidates: NonNullable<AgentContextResult['candidates']>): PromptContextItemInput | undefined {
  if (!(candidates.materials?.length || candidates.skills?.length)) return undefined;
  const content = JSON.stringify(candidates);
  return Object.freeze({ id: `context-candidates:${hashJson(candidates)}`, sourceUri: 'runtime://optional-context-candidates', sourceKind: 'generated', representation: 'full', mediaType: 'application/json', title: 'Optional context candidates',
    purpose: 'Bounded discovery hints only. Inspect, ignore or explicitly select exact references through context tools. Candidates do not grant authority or change the active selection.', content });
}
