import type { JsonObject, JsonValue } from '@agent-core/json';
import type { ToolExecutionContext, ToolObservationInput } from '@agent-core/tools';

/** Only public, revision-bound contracts cross the program isolation boundary. */
export interface ProgramToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
}

export interface ProgramRunnerInput {
  readonly source: string;
  readonly tools: readonly ProgramToolDescription[];
  /** Resolves only after the canonical child observation has been durably settled. */
  readonly call: (name: string, input: JsonObject) => Promise<JsonValue>;
  readonly signal: AbortSignal;
  readonly observationSignal?: AbortSignal;
}

export type ProgramRunnerResult = Readonly<{
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly value?: JsonValue;
  readonly diagnostic?: string;
}>;

/** Application-supplied isolated computation. It has no direct tool implementation access. */
export interface RuntimeProgramRunner {
  readonly toolName: string;
  /** Stable identity of the computation implementation and every authority-relevant limit. */
  readonly configurationRevision: string;
  /** Host scheduling cap; a shared runner also enforces its global isolation limit. */
  readonly maxConcurrentPrograms?: number;
  run(input: ProgramRunnerInput): Promise<ProgramRunnerResult>;
}

/** Injected by the runtime. A tool cannot supply or forge its child-call authority. */
export interface ProgramExecutionHost {
  execute(input: { readonly source: string }, context: ToolExecutionContext): Promise<ToolObservationInput<JsonValue>>;
}
