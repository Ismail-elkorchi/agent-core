import { parseJsonObject } from '@agent-core/json';

/** Bounds on one isolated computation, independent of runtime-owned tool budgets. */
export interface ProgramLimits {
  /** Concurrent worker programs across every run sharing this runner instance. */
  readonly concurrentPrograms: number;
  /** Entire worker lifetime, including module startup and tool waits. */
  readonly wallTimeMs: number;
  /** Accumulated time executing guest computation; excludes waits for host calls. */
  readonly executionTimeMs: number;
  /** Requested QuickJS allocator ceiling; wasmMemoryBytes is the hard memory boundary. */
  readonly heapBytes: number;
  /** Hard WebAssembly linear-memory maximum, in 64-KiB pages. Not a process RSS limit. */
  readonly wasmMemoryBytes: number;
  readonly stackBytes: number;
  readonly sourceBytes: number;
  readonly manifestBytes: number;
  readonly callInputBytes: number;
  readonly callResultBytes: number;
  readonly totalCallResultBytes: number;
  readonly outputBytes: number;
  readonly calls: number;
}

export const DEFAULT_PROGRAM_LIMITS: ProgramLimits = Object.freeze({
  concurrentPrograms: 1,
  wallTimeMs: 30_000,
  executionTimeMs: 1_000,
  heapBytes: 8 * 1024 * 1024,
  wasmMemoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  sourceBytes: 128 * 1024,
  manifestBytes: 1024 * 1024,
  callInputBytes: 64 * 1024,
  callResultBytes: 1024 * 1024,
  totalCallResultBytes: 8 * 1024 * 1024,
  outputBytes: 128 * 1024,
  calls: 64
});

/** Strict configuration boundary: rejects unknown keys, accessors, and non-integer values. */
export function parseProgramLimits(value: unknown): ProgramLimits {
  const input = parseJsonObject(value);
  for (const [name, limit] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_PROGRAM_LIMITS, name))
      throw new TypeError(`Unknown program limit: ${name}.`);
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
      throw new TypeError(`Program limit ${name} must be a positive safe integer.`);
  }
  const limits = { ...DEFAULT_PROGRAM_LIMITS, ...input };
  if (limits.concurrentPrograms > 64)
    throw new TypeError('Program concurrency must not exceed 64.');
  if (limits.wallTimeMs > 2_147_483_647)
    throw new TypeError('Program wall time exceeds the supported timer range.');
  if (limits.wasmMemoryBytes > 2_147_483_648)
    throw new TypeError('Program WASM memory must not exceed 2 GiB.');
  if (limits.wasmMemoryBytes % 65_536 !== 0 || limits.wasmMemoryBytes < 16 * 1024 * 1024)
    throw new TypeError('Program WASM memory must be at least 16 MiB and a multiple of 64 KiB.');
  if (limits.heapBytes >= limits.wasmMemoryBytes)
    throw new TypeError('Program heap limit must be smaller than its WASM memory limit.');
  if (limits.stackBytes > limits.heapBytes)
    throw new TypeError('Program stack limit must not exceed its heap limit.');
  if (limits.executionTimeMs > limits.wallTimeMs)
    throw new TypeError('Program execution time must not exceed its wall time.');
  return Object.freeze(limits);
}
