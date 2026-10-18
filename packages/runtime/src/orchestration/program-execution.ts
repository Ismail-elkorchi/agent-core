import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import { hashJson } from '@agent-core/persistence';
import { createToolCall, type ToolExecutionContext, type ToolObservationInput } from '@agent-core/tools';
import { createProgramResult, programResultSchema } from './program-result.js';
import { captureToolCatalog } from '../run/tool-catalog.js';
import type { AgentProgramSource, AgentToolPhase } from '../run/control/tool-state.js';
import type { ProgramExecutionHost, ProgramRunnerResult } from './program-contracts.js';
import type { ToolCallStepResult, ToolExecutionInput } from './tool-execution.js';

/** Program computation never owns leaf effects. Every child uses the existing durable driver. */
export class ProgramExecutionCoordinator {
  private readonly started = new Set<string>();
  private readonly activeQuiescence = new Set<AbortController>();

  quiesce(reason: string): void {
    for (const controller of this.activeQuiescence) controller.abort(reason);
  }
  constructor(
    private readonly input: ToolExecutionInput,
    private readonly step: (target: { toolBatchId: string; callIndex: number }) => Promise<ToolCallStepResult>
  ) {}

  host(phase: AgentToolPhase, callIndex: number, toolAttempt: number): ProgramExecutionHost {
    return Object.freeze({ execute: (request: { readonly source: string }, context: ToolExecutionContext) => this.execute(phase, callIndex, toolAttempt, request, context) });
  }

  private async execute(phase: AgentToolPhase, callIndex: number, toolAttempt: number,
    request: { readonly source: string }, context: ToolExecutionContext): Promise<ToolObservationInput<JsonValue>> {
    const source = parseJsonObject(request).source;
    const runner = this.input.programRunner;
    const artifacts = this.input.artifactRepository;
    const parentCall = phase.calls[callIndex];
    if (!runner || !this.input.admitProgramCall || !artifacts ||
        phase.source.program || toolAttempt !== 1 || parentCall?.name !== runner.toolName || typeof source !== 'string')
      throw new Error('Program execution requires its registered direct tool invocation and durable artifacts.');
    if (context.invocation?.runId !== this.input.runId || context.invocation.toolBatchId !== phase.toolBatchId ||
        context.invocation.callIndex !== callIndex || context.invocation.toolAttempt !== toolAttempt ||
        context.invocation.turnId !== phase.identity.turnId || context.invocation.requestAttempt !== phase.identity.requestAttempt ||
        context.invocation.callId !== parentCall.id || context.invocation.caller)
      throw new Error('Program host invocation does not match its bound parent.');
    const parent = Object.freeze({ runId: this.input.runId, ...phase.identity,
      toolBatchId: phase.toolBatchId, callIndex, toolAttempt, ...(parentCall.id ? { callId: parentCall.id } : {}) });
    const programId = `${this.input.runId}:${phase.toolBatchId}:${String(callIndex)}:${String(toolAttempt)}`;
    if (this.started.has(programId)) throw new Error('A program invocation is single-use and cannot be replayed.');
    const state = this.input.state().toolBatches.find(batch => batch.toolBatchId === phase.toolBatchId)?.callStates[callIndex];
    if (state?.stage !== 'effect_pending' || state.toolAttempt !== toolAttempt ||
        state.plan.effects.accesses.length || state.plan.effects.lockScopes.length || state.plan.effects.recovery.kind !== 'unknown' ||
        parseJsonObject(state.plan.canonicalInput).source !== source)
      throw new Error('Program orchestration requires an active invocation without leaf resource locks or effects.');
    this.started.add(programId);
    const tools = this.input.resolveTools(phase.source.catalog).filter(tool =>
      tool.name !== runner.toolName && tool.invocationModes.includes('programmatic'));
    const catalog = captureToolCatalog(tools);
    const program: AgentProgramSource = Object.freeze({ id: programId, sourceDigest: hashJson(source), parent });
    const receipts: JsonObject[] = [];
    const pending = new Set<Promise<JsonValue>>();
    const quiescence = new AbortController();
    this.activeQuiescence.add(quiescence);
    const observationSignal = AbortSignal.any([this.input.toolContext.signal, quiescence.signal,
      ...(this.input.toolContext.observationSignal ? [this.input.toolContext.observationSignal] : [])]);
    let accepting = true;
    let interrupted: string | undefined;
    const signal = this.input.toolContext.signal;
    const assertAdmission = () => {
      signal.throwIfAborted();
      if (!accepting || interrupted || observationSignal.aborted)
        throw new Error(interrupted ?? 'Program admission stopped for completion or steering.');
    };
    const call = (name: string, rawInput: JsonObject): Promise<JsonValue> => {
      const completion = (async () => {
        assertAdmission();
        if (!tools.some(tool => tool.name === name)) throw new Error(`Tool is not in this program's admitted manifest: ${name}.`);
        const toolCall = createToolCall({ id: randomUUID(), name, input: { kind: 'json', value: parseJsonObject(rawInput) } });
        const toolBatchId = randomUUID();
        const child: AgentToolPhase = Object.freeze({ kind: 'tools', identity: phase.identity, toolBatchId,
          calls: Object.freeze([toolCall]), modelCalls: Object.freeze([]),
          callStates: Object.freeze([{ stage: 'ready' as const }]), maxConcurrency: phase.maxConcurrency,
          source: Object.freeze({ catalog, program }), instructions: phase.instructions,
          modelInputModalities: phase.modelInputModalities });
        await this.input.admitProgramCall?.(child, tools);
        const target = { toolBatchId, callIndex: 0 };
        for (;;) {
          const current = this.input.state().toolBatches.find(batch => batch.toolBatchId === toolBatchId)?.callStates[0];
          if (!current) throw new Error('Program child lost its durable state.');
          const quiesced = observationSignal.aborted ||
            this.input.state().toolBatches.some(batch => batch.callStates.some(item => item.stage === 'approval'));
          if (quiesced && (current.stage === 'ready' || current.stage === 'effect_ready')) {
            await this.input.interruptProgramCall?.(target);
            interrupted = observationSignal.aborted ? String(observationSignal.reason ?? 'program_interrupted') : 'approval_required';
            receipts.push(parseJsonObject({ toolBatchId, callId: toolCall.id, toolName: name, status: 'cancelled_before_start' }));
            throw new Error(interrupted);
          }
          if (current.stage === 'approval' || current.stage === 'outcome_unknown') {
            interrupted = current.stage === 'approval' ? 'approval_required' : 'tool_outcome_unknown';
            quiescence.abort(interrupted);
            receipts.push(parseJsonObject({ toolBatchId, callId: toolCall.id, toolName: name, status: interrupted,
              ...(current.stage === 'approval' ? { approvalId: current.approval.approvalId } : { effectId: current.effect.intent.effectId }) }));
            throw new Error(interrupted);
          }
          if (current.stage === 'recorded') {
            const result = await createProgramResult({ runId: this.input.runId, toolBatchId,
              ...(toolCall.id ? { callId: toolCall.id } : {}), toolName: name, settlement: current.settlement,
              artifacts });
            receipts.push(parseJsonObject(result.receipt));
            return result;
          }
          if (current.stage === 'cancelled' || current.stage === 'resolved') {
            interrupted = 'child_no_longer_deliverable';
            throw new Error(interrupted);
          }
          signal.throwIfAborted();
          const step = await this.step(target);
          if (step.kind === 'started') {
            const outcome = await observeChild(step.completion, observationSignal);
            if (outcome === 'yield') {
              // This is observation uncertainty, not cancellation or permission to replay.
              // The existing effect keeps its settlement permit and may report later.
              await this.input.yieldProgramCall?.(target);
              interrupted = 'steering';
            } else if (outcome.outcome === 'ownership_lost') {
              interrupted = 'ownership_lost';
              throw new Error(interrupted);
            }
          } else if (step.kind === 'blocked') await delay(2, undefined, { signal });
        }
      })();
      pending.add(completion);
      void completion.finally(() => pending.delete(completion)).catch(() => undefined);
      return completion;
    };
    let result: ProgramRunnerResult = { status: 'failed', diagnostic: 'Program did not settle.' };
    try {
      result = await runner.run({ source,
        tools: Object.freeze(tools.map(tool => Object.freeze({ name: tool.name, description: tool.description,
          inputSchema: tool.jsonSchema, outputSchema: programResultSchema(tool.outputJsonSchema) }))), call,
        signal, observationSignal });
    } catch (error) {
      result = { status: 'failed', diagnostic: error instanceof Error ? error.message : String(error) };
    } finally {
      accepting = false;
      if (result.status !== 'completed') quiescence.abort(result.diagnostic ?? result.status);
      // Issued effects retain their own receipts even when code returns without awaiting them.
      await Promise.allSettled([...pending]);
      this.activeQuiescence.delete(quiescence);
    }
    const status = interrupted || signal.aborted || this.input.toolContext.observationSignal?.aborted ? 'interrupted' : result.status;
    const output = parseJsonValue({ programId, sourceDigest: program.sourceDigest, status,
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(interrupted || result.diagnostic ? { diagnostic: interrupted ?? result.diagnostic } : {}), receipts });
    return { kind: 'result', execution: { state: 'settled' }, summary: `Program ${status}; ${String(receipts.length)} child receipts.`,
      scope: { resources: [], coverage: status === 'completed' && receipts.every(receipt => receipt.status === 'recorded' && receipt.coverage === 'complete') ? 'complete' : 'partial' }, output };
  }
}

async function observeChild<T>(completion: Promise<T>, observationSignal?: AbortSignal): Promise<T | 'yield'> {
  if (!observationSignal) return completion;
  if (observationSignal.aborted) return 'yield';
  let listener: () => void = () => undefined;
  const yielded = new Promise<'yield'>(resolve => { listener = () => { resolve('yield'); };
    observationSignal.addEventListener('abort', listener, { once: true }); });
  try { return await Promise.race([completion, yielded]); }
  finally { observationSignal.removeEventListener('abort', listener); }
}
