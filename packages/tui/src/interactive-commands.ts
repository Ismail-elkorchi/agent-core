import type { AgentSession, AgentSessionState } from '@agent-core/runtime';
import { parseReasoningEffort } from './reasoning-effort.js';

export interface InteractiveCommandEntry {
  readonly name: InteractiveCommandName;
  readonly description: string;
  readonly requiresValue: boolean;
}

interface InteractiveCommandSpec extends InteractiveCommandEntry {
  execute(session: AgentSession, value: string): InteractiveCommandResult | Promise<InteractiveCommandResult>;
}

export type InteractiveCommandName =
  | '/exit'
  | '/quit'
  | '/model'
  | '/temperature'
  | '/reasoning-effort'
  | '/steer'
  | '/follow'
  | '/compact'
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
  '/model': command('/model', 'Set the model for new submissions.', true, async (session, value) => { const state = await session.configure({ model: value }); return { message: `Model: ${state.configuration.model}` }; }),
  '/temperature': command('/temperature', 'Set provider temperature for new submissions.', true, async (session, value) => { const temperature = Number(value); if (!Number.isFinite(temperature)) throw new Error('/temperature requires a number.'); await session.configure({ temperature }); return { message: `Temperature: ${String(temperature)}` }; }),
  '/reasoning-effort': command('/reasoning-effort', 'Set provider reasoning effort for new submissions.', true, async (session, value) => { const effort = parseReasoningEffort(value, '/reasoning-effort'); await session.configure({ reasoning: effort === 'none' ? { strategy: 'disabled' } : { strategy: 'effort', effort } }); return { message: `Reasoning effort: ${effort}` }; }),
  '/steer': command('/steer', 'Steer the active run.', true, async (session, value) => { const activeRunId = session.state().activeRunId; const result = await session.submit({ task: value }, { delivery: 'steer', ...(activeRunId === undefined ? {} : { expectedRunId: activeRunId }) }); if (result.kind === 'rejected') throw new Error('No matching active run can accept steering.'); return { message: 'Steering accepted.' }; }),
  '/follow': command('/follow', 'Queue a follow-up after current work.', true, async (session, value) => {
    const result = await session.submit({ task: value }, { delivery: 'follow_up' });
    return result.kind === 'queued'
      ? { message: 'Follow-up queued.', effect: { type: 'follow-up-queued', task: value } }
      : { message: 'Run started.' };
  }),
  '/compact': command('/compact', 'Summarize stable session history for future turns.', false, async (session) => {
    const compaction = await session.compact();
    return { message: `Session compacted with ${compaction.provider}/${compaction.model}.` };
  }),
  '/abort': command('/abort', 'Abort the active run.', false, (session, value) => { if (!session.abort(value || undefined, session.state().activeRunId)) throw new Error('No active run to abort.'); return { message: 'Abort requested.', effect: { type: 'abort-requested', reason: value || 'requested' } }; }),
  '/status': command('/status', 'Show the current session status.', false, session => ({ message: runtimeStatus(session.state()) })),
  '/debug': command('/debug', 'Inspect detailed session state.', false, session => ({ message: JSON.stringify(session.state(), null, 2), view: 'debug' }))
} satisfies Record<InteractiveCommandName, InteractiveCommandSpec>;

export const INTERACTIVE_COMMANDS: readonly InteractiveCommandEntry[] = Object.freeze(Object.values(INTERACTIVE_COMMAND_REGISTRY));

export function executeInteractiveCommand(session: AgentSession, commandLine: string): InteractiveCommandResult | Promise<InteractiveCommandResult> {
  const parsed = parseInteractiveCommandLine(commandLine);
  const spec = INTERACTIVE_COMMAND_REGISTRY[parsed.command];
  return spec.execute(session, spec.requiresValue ? requireCommandValue(parsed.command, parsed.value) : parsed.value);
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

function runtimeStatus(state: AgentSessionState): string {
  const status = state.phase === 'running' ? 'Running' : state.phase === 'waiting_for_approval' ? 'Waiting for approval' : state.phase === 'compacting' ? 'Compacting' : 'Idle';
  return `${status} · ${state.configuration.model}${state.queuedInputs === 0 ? '' : ` · ${String(state.queuedInputs)} queued`}`;
}
