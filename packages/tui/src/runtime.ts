import type { AgentRuntime, AgentEndedRunResult, AgentProgressEvent, AgentRunInput, AgentRunResult } from '@agent-core/runtime';
import { createTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import type { TerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import type { TuiExit } from '@ismail-elkorchi/terminal-ui/tui';
import { executeInteractiveCommand } from './interactive-commands.js';
import { normalizeTaskInput } from './task-input.js';
import { createAgentTuiApp } from './app.js';
import { AgentTuiEventSource } from './event-source.js';
import type { AgentTuiMessage } from './messages.js';
import type { AgentTuiState } from './state.js';
import type { AgentTuiRuntimeDetails } from './state.js';

export class AgentTuiProgressRenderer {
  private dispatch: ((message: AgentTuiMessage) => void | Promise<void>) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly pendingStreamEvents: AgentTuiStreamProgressEvent[] = [];
  private streamFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private static readonly MAX_PENDING_STREAM_EVENTS = 1024;

  attachDispatch(dispatch: (message: AgentTuiMessage) => void | Promise<void>): void {
    this.dispatch = dispatch;
  }

  handle(event: AgentProgressEvent): void {
    if (isCoalescibleStreamEvent(event)) {
      this.queueStreamEvent(event);
      return;
    }
    this.flushPendingStreamEvents();
    this.enqueue({ type: 'progress', event });
  }

  flush(): Promise<void> {
    this.flushPendingStreamEvents();
    return this.queue;
  }

  async showResult(result: AgentEndedRunResult): Promise<void> {
    this.flushPendingStreamEvents();
    this.enqueue({ type: 'result', result });
    await this.flush();
  }

  async showSuspension(suspension: Extract<AgentRunResult, { state: 'suspended' }>): Promise<void> {
    this.flushPendingStreamEvents();
    this.enqueue({ type: 'approval.required', suspension });
    await this.flush();
  }

  async showFailure(message: string): Promise<void> {
    this.flushPendingStreamEvents();
    this.enqueue({ type: 'failure', message });
    await this.flush();
  }

  private enqueue(message: AgentTuiMessage): void {
    const dispatch = this.dispatch;
    if (dispatch === undefined) return;
    this.queue = this.queue
      .then(async () => { await dispatch(message); })
      .catch(() => undefined);
  }

  private queueStreamEvent(event: Extract<AgentProgressEvent, { type: 'assistant.delta' | 'assistant.reasoning' }>): void {
    const last = this.pendingStreamEvents.at(-1);
    if (last !== undefined && canMergeStreamEvents(last, event)) {
      this.pendingStreamEvents[this.pendingStreamEvents.length - 1] = mergeStreamEvents(last, event);
    } else {
      if (this.pendingStreamEvents.length >= AgentTuiProgressRenderer.MAX_PENDING_STREAM_EVENTS) this.pendingStreamEvents.shift();
      this.pendingStreamEvents.push(event);
    }
    this.scheduleStreamFlush();
  }

  private scheduleStreamFlush(): void {
    if (this.streamFlushTimer !== undefined) return;
    this.streamFlushTimer = setTimeout(() => {
      this.streamFlushTimer = undefined;
      this.flushPendingStreamEvents();
    }, 80);
  }

  private flushPendingStreamEvents(): void {
    if (this.streamFlushTimer !== undefined) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = undefined;
    }
    const events = this.pendingStreamEvents.splice(0);
    for (const event of events) {
      this.enqueue({ type: 'progress', event });
    }
  }
}

type AgentTuiStreamProgressEvent = Extract<AgentProgressEvent, { type: 'assistant.delta' | 'assistant.reasoning' }>;

function isCoalescibleStreamEvent(event: AgentProgressEvent): event is AgentTuiStreamProgressEvent {
  return event.type === 'assistant.delta' || event.type === 'assistant.reasoning';
}

function canMergeStreamEvents(left: AgentTuiStreamProgressEvent, right: AgentTuiStreamProgressEvent): boolean {
  if (left.type !== right.type || left.turnIndex !== right.turnIndex) return false;
  if (left.type === 'assistant.reasoning' && right.type === 'assistant.reasoning') {
    return left.channel === right.channel;
  }
  return left.type === 'assistant.delta' && right.type === 'assistant.delta';
}

function mergeStreamEvents(left: AgentTuiStreamProgressEvent, right: AgentTuiStreamProgressEvent): AgentTuiStreamProgressEvent {
  if (left.type === 'assistant.delta' && right.type === 'assistant.delta') {
    return {
      type: 'assistant.delta',
      turnIndex: right.turnIndex,
      turnId: right.turnId,
      requestAttempt: right.requestAttempt,
      delta: `${left.delta}${right.delta}`,
      accumulated: right.accumulated
    };
  }
  if (left.type === 'assistant.reasoning' && right.type === 'assistant.reasoning') {
    return {
      type: 'assistant.reasoning',
      turnIndex: right.turnIndex,
      turnId: right.turnId,
      requestAttempt: right.requestAttempt,
      delta: `${left.delta}${right.delta}`,
      accumulated: right.accumulated,
      ...(right.channel === undefined ? {} : { channel: right.channel })
    };
  }
  return right;
}

export interface AgentTuiAppRunOptions {
  readonly host?: TerminalHost;
  readonly initialTask?: string;
  readonly progress?: AgentTuiProgressRenderer;
  readonly exitOnCompletion?: boolean;
  readonly runtimeDetails?: AgentTuiRuntimeDetails;
}

export interface AgentTuiAppRunResult {
  readonly exit: TuiExit<AgentTuiState>;
  readonly result?: AgentRunResult;
}

export async function runAgentTuiApp(
  agent: AgentRuntime,
  options: AgentTuiAppRunOptions = {}
): Promise<AgentTuiAppRunResult> {
  const host = options.host ?? createTerminalHost({ runtime: 'node' });
  const ownsHost = options.host === undefined;
  const progress = options.progress ?? new AgentTuiProgressRenderer();
  const events = new AgentTuiEventSource();
  const taskQueue: AgentRunInput[] = [];
  const maxQueuedTasks = 1024;
  let activeRun: Promise<void> | undefined;
  let result: AgentRunResult | undefined;
  let failure: unknown;
  const exitOnCompletion = options.exitOnCompletion === true;
  const launchTaskQueue = (input: AgentRunInput): void => {
    activeRun = runTaskQueue(input)
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        activeRun = undefined;
      });
  };
  const startTask = (input: AgentRunInput): string => {
    const normalizedTask = normalizeTaskInput(input.task);
    if (normalizedTask.length === 0) {
      return 'Task is empty.';
    }
    const normalizedInput = { ...input, task: normalizedTask };
    if (activeRun !== undefined) {
      agent.enqueueFollowUp(normalizedTask, normalizedInput.instructions);
      return 'Follow-up queued.';
    }
    launchTaskQueue(normalizedInput);
    return 'Run started.';
  };
  const app = createAgentTuiApp(normalizeTaskInput(options.initialTask ?? ''), {
    eventSource: events,
    ...(options.runtimeDetails === undefined ? {} : { runtimeDetails: options.runtimeDetails }),
    exitWhenApprovalEnds: exitOnCompletion,
    approvalHandler: async (suspension, decision) => {
      const approval = suspension.pendingApprovals[0];
      if (approval === undefined) throw new Error('Approval suspension contains no pending request.');
      result = await agent.resolveApproval({ runId: suspension.runId, approvalId: approval.approvalId, fingerprint: approval.fingerprint, decision });
      if (result.state === 'ended') {
        if (exitOnCompletion) {
          result = await runFollowUps(result);
        } else {
          const followUps = takeFollowUpInputs(result.terminal.runId);
          const previousRun = activeRun;
          if (previousRun !== undefined) await previousRun;
          const first = followUps.shift();
          appendQueuedTasks(followUps);
          if (first !== undefined) launchTaskQueue(first);
        }
      }
      return result;
    },
    commandHandler: {
      execute(line) {
        if (line === '/exit' || line === '/quit') {
          return { message: 'Exiting.', exit: true };
        }
        if (!line.startsWith('/')) {
          return { message: startTask({ task: line }) };
        }
        return executeInteractiveCommand(agent, line);
      }
    }
  });
  const exit = runTui(app, host, {
    initialFocus: { kind: 'element', elementId: 'composer' }
  });
  progress.attachDispatch((message) => {
    events.enqueue(message);
  });
  const initialTask = options.initialTask;
  try {
    if (initialTask !== undefined) startTask({ task: initialTask });
    if (activeRun !== undefined && exitOnCompletion) await activeRun;
    const exitResult = await exit;
    if (activeRun !== undefined && !exitOnCompletion) await activeRun;
    if (failure !== undefined) throw errorFromUnknown(failure);
    return result === undefined ? { exit: exitResult } : { exit: exitResult, result };
  } finally {
    await progress.flush();
    events.close();
    if (ownsHost) await host.dispose();
  }

  async function runTaskQueue(firstInput: AgentRunInput): Promise<void> {
    let nextInput: AgentRunInput | undefined = firstInput;
    while (nextInput !== undefined) {
      try {
        result = await runTask(agent, nextInput, progress);
        if (result.state === 'suspended') return;
        appendQueuedTasks(takeFollowUpInputs(result.terminal.runId));
        if (exitOnCompletion && taskQueue.length === 0) {
          events.enqueue({
            type: 'app.exit',
            reason: `${result.terminal.executionStatus}:${result.terminal.verificationStatus}:${result.terminal.terminationReason}`
          });
        }
      } catch (error) {
        if (exitOnCompletion) events.enqueue({ type: 'app.exit', reason: 'failed' });
        throw error;
      }
      nextInput = taskQueue.shift();
    }
  }

  async function runFollowUps(initialResult: AgentRunResult): Promise<AgentRunResult> {
    let latest = initialResult;
    while (latest.state === 'ended') {
      const followUps = takeFollowUpInputs(latest.terminal.runId);
      if (followUps.length === 0) return latest;
      for (const followUp of followUps) {
        latest = await runTask(agent, followUp, progress);
        if (latest.state === 'suspended') return latest;
      }
    }
    return latest;
  }

  function takeFollowUpInputs(runId: string): AgentRunInput[] {
    return agent.takeFollowUps(runId).map((followUp) => ({
      task: followUp.task,
      ...(followUp.instructions ? { instructions: followUp.instructions } : {})
    }));
  }

  function appendQueuedTasks(inputs: readonly AgentRunInput[]): void {
    if (taskQueue.length + inputs.length > maxQueuedTasks) throw new Error(`Follow-up queue limit of ${String(maxQueuedTasks)} was exceeded.`);
    taskQueue.push(...inputs);
  }
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function runAgentTuiTask(
  agent: AgentRuntime,
  task: string,
  progress: AgentTuiProgressRenderer,
  options: {
    readonly host?: TerminalHost;
    readonly runtimeDetails?: AgentTuiRuntimeDetails;
  } = {}
): Promise<AgentRunResult> {
  const appResult = await runAgentTuiApp(agent, {
    initialTask: task,
    progress,
    exitOnCompletion: true,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.runtimeDetails === undefined ? {} : { runtimeDetails: options.runtimeDetails })
  });
  if (appResult.result === undefined) {
    throw new Error('Agent TUI task ended without a run result.');
  }
  return appResult.result;
}

async function runTask(
  agent: AgentRuntime,
  input: AgentRunInput,
  progress: AgentTuiProgressRenderer
): Promise<AgentRunResult> {
  try {
    const result = await agent.run(input);
    if (result.state === 'suspended') await progress.showSuspension(result);
    else await progress.showResult(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await progress.showFailure(message);
    throw error;
  }
}
