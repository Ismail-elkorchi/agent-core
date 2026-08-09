import type { AgentRuntime, AgentRuntimeState } from '@agent-core/runtime';
import { parseReasoningEffort } from './reasoning-effort.js';

export interface InteractiveCommandEntry {
  readonly name: InteractiveCommandName;
  readonly description: string;
  readonly requiresValue: boolean;
}

interface InteractiveCommandSpec extends InteractiveCommandEntry {
  execute(agent: AgentRuntime, value: string): InteractiveCommandResult;
}

export type InteractiveCommandName =
  | '/exit'
  | '/quit'
  | '/model'
  | '/temperature'
  | '/reasoning-effort'
  | '/steer'
  | '/follow'
  | '/retry'
  | '/abort'
  | '/status'
  | '/debug';

export interface InteractiveCommandResult {
  readonly message: string;
  readonly effect?: InteractiveCommandEffect;
  readonly view?: 'debug';
}

export type InteractiveCommandEffect =
  | { readonly type: 'follow-up-queued'; readonly task: string }
  | { readonly type: 'abort-requested'; readonly reason: string };

export const INTERACTIVE_COMMAND_REGISTRY = {
  '/exit': command('/exit', 'Exit the interactive surface.', false, () => ({ message: 'Exit requested.' })),
  '/quit': command('/quit', 'Exit the interactive surface.', false, () => ({ message: 'Exit requested.' })),
  '/model': command('/model', 'Set the model for the next request.', true, (agent, value) => { agent.configureModel({ model: value }); return { message: `Model: ${agent.runtimeState().model}` }; }),
  '/temperature': command('/temperature', 'Set provider temperature for the next request.', true, (agent, value) => { const temperature = Number(value); if (!Number.isFinite(temperature)) throw new Error('/temperature requires a number.'); agent.configureModel({ temperature }); return { message: `Temperature: ${String(temperature)}` }; }),
  '/reasoning-effort': command('/reasoning-effort', 'Set provider reasoning effort for the next request.', true, (agent, value) => { const effort = parseReasoningEffort(value, '/reasoning-effort'); agent.configureModel({ reasoning: effort === 'none' ? { strategy: 'disabled' } : { strategy: 'effort', effort } }); return { message: `Reasoning effort: ${effort}` }; }),
  '/steer': command('/steer', 'Queue a steering instruction for the next request.', true, (agent, value) => { agent.steer(value); return { message: 'Steering queued.' }; }),
  '/follow': command('/follow', 'Queue a follow-up task after the active run.', true, (agent, value) => { agent.enqueueFollowUp(value); return { message: 'Follow-up queued.', effect: { type: 'follow-up-queued', task: value } }; }),
  '/retry': command('/retry', 'Ask the loop to retry the failed tool call.', false, (agent, value) => { agent.requestRetry(value || undefined); return { message: 'Retry requested.' }; }),
  '/abort': command('/abort', 'Abort the active run.', false, (agent, value) => { agent.abort(value || undefined); return { message: 'Abort requested.', effect: { type: 'abort-requested', reason: value || 'requested' } }; }),
  '/status': command('/status', 'Show the current run status.', false, agent => ({ message: runtimeStatus(agent.runtimeState()) })),
  '/debug': command('/debug', 'Inspect detailed runtime state.', false, agent => ({ message: JSON.stringify(agent.runtimeState(), null, 2), view: 'debug' }))
} satisfies Record<InteractiveCommandName, InteractiveCommandSpec>;

export const INTERACTIVE_COMMANDS: readonly InteractiveCommandEntry[] = Object.freeze(Object.values(INTERACTIVE_COMMAND_REGISTRY));

export function executeInteractiveCommand(agent: AgentRuntime, commandLine: string): InteractiveCommandResult {
  const parsed = parseInteractiveCommandLine(commandLine);
  const spec = INTERACTIVE_COMMAND_REGISTRY[parsed.command];
  return spec.execute(agent, spec.requiresValue ? requireCommandValue(parsed.command, parsed.value) : parsed.value);
}

function command(name: InteractiveCommandName, description: string, requiresValue: boolean, execute: InteractiveCommandSpec['execute']): InteractiveCommandSpec {
  return Object.freeze({ name, description, requiresValue, execute });
}

export function parseInteractiveCommandLine(commandLine: string): { readonly command: InteractiveCommandName; readonly value: string } {
  const [command, ...rest] = commandLine.trim().split(/\s+/);
  const value = rest.join(' ').trim();
  if (!isInteractiveCommandName(command)) {
    throw new Error(`Unknown interactive command: ${command ?? ''}`);
  }
  return { command, value };
}

function isInteractiveCommandName(value: string | undefined): value is InteractiveCommandName {
  return INTERACTIVE_COMMANDS.some((command) => command.name === value);
}

function requireCommandValue(command: string, value: string): string {
  if (value.length === 0) {
    throw new Error(`${command} requires a value.`);
  }
  return value;
}

function runtimeStatus(state: AgentRuntimeState): string {
  const queues = state.queuedSteers + state.queuedFollowUps + state.queuedRetries;
  return `${state.active ? 'Running' : 'Idle'} · ${state.model}${queues === 0 ? '' : ` · ${String(queues)} queued`}`;
}
