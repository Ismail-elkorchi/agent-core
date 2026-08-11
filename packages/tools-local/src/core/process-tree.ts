import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export type OwnedChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface OwnedProcessTree {
  readonly child: OwnedChildProcess;
  readonly started: Promise<void>;
  stop(signal?: 'SIGTERM' | 'SIGKILL'): void;
  settle(): Promise<void>;
}
