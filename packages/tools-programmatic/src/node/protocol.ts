import type { ProgramRunnerResult } from '@agent-core/runtime';
import type { ProgramLimits } from '../limits.js';

export interface WorkerInput {
  readonly source: string;
  readonly manifest: string;
  readonly limits: ProgramLimits;
}

export type WorkerMessage =
  | { readonly type: 'call'; readonly id: number; readonly name: string; readonly input: string }
  | { readonly type: 'result'; readonly result: ProgramRunnerResult };

export type HostMessage =
  | { readonly type: 'call_result'; readonly id: number; readonly json: string }
  | { readonly type: 'call_error'; readonly id: number; readonly diagnostic: string };
