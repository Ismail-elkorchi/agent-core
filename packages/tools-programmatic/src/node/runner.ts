import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { canonicalJsonString, parseJsonObject, parseJsonValue, type JsonValue } from '@agent-core/json';
import type { ProgramRunnerInput, ProgramRunnerResult, RuntimeProgramRunner } from '@agent-core/runtime';
import { parseProgramLimits, type ProgramLimits } from '../limits.js';
import type { HostMessage, WorkerInput, WorkerMessage } from './protocol.js';

export interface QuickJSProgramRunnerOptions {
  readonly toolName?: string;
  readonly limits?: Partial<ProgramLimits>;
}

/** A fresh, bounded WASM interpreter and worker for every program. */
export function createQuickJSProgramRunner(options: QuickJSProgramRunnerOptions = {}): RuntimeProgramRunner {
  const limits = parseProgramLimits(options.limits ?? {});
  const toolName = options.toolName ?? 'run_program';
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(toolName))
    throw new TypeError('Program tool name must contain 1–128 letters, numbers, underscores, or hyphens.');
  const configurationRevision = createHash('sha256').update(canonicalJsonString({
    implementationId: 'agent-core.quickjs-program-runner.v1', toolName, limits: { ...limits }
  })).digest('hex');
  let activePrograms = 0;
  return Object.freeze({
    toolName,
    configurationRevision,
    maxConcurrentPrograms: limits.concurrentPrograms,
    run(input: ProgramRunnerInput): Promise<ProgramRunnerResult> {
      if (activePrograms >= limits.concurrentPrograms)
        return Promise.resolve({ status: 'failed', diagnostic: 'Program concurrency limit reached; no worker or child call started.' });
      activePrograms += 1;
      let released = false;
      const release = (): void => {
        if (!released) { released = true; activePrograms -= 1; }
      };
      return runProgram(input, limits, release);
    }
  });
}

async function runProgram(input: ProgramRunnerInput, limits: ProgramLimits, release: () => void): Promise<ProgramRunnerResult> {
  if (input.signal.aborted || input.observationSignal?.aborted) {
    release();
    return { status: 'interrupted', diagnostic: 'Program interrupted before execution.' };
  }
  let source: string;
  let manifest: string;
  const allowed = new Set<string>();
  try {
    source = input.source;
    checkBytes(source, limits.sourceBytes, 'Program source');
    const captured = parseJsonValue(input.tools, jsonLimits(limits.manifestBytes));
    if (!isJsonArray(captured)) throw new TypeError('Program manifest must be an array.');
    for (const description of captured) {
      if (description === null || typeof description !== 'object' || isJsonArray(description) ||
        !('name' in description) || typeof description.name !== 'string' ||
        description.name.length > 128 || allowed.has(description.name))
        throw new TypeError('Program manifest requires unique bounded tool names.');
      allowed.add(description.name);
    }
    manifest = JSON.stringify(captured);
    checkBytes(manifest, limits.manifestBytes, 'Program manifest');
  } catch (error) {
    release();
    return { status: 'failed', diagnostic: boundedDiagnostic(error) };
  }
  return new Promise((resolve) => {
    let settled = false;
    let callCount = 0;
    let callResultBytes = 0;
    let diagnosticBytes = 0;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupt = (): void => { finish({ status: 'interrupted', diagnostic: 'Program interrupted; started host calls remain runtime-owned.' }); };
    function finish(result: ProgramRunnerResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', interrupt);
      input.observationSignal?.removeEventListener('abort', interrupt);
      // Never cancel or replay input.call. Its host records and reconciles child effects.
      if (worker) {
        // Do not release this runner's memory slot until the worker actually exits.
        const stoppingWorker = worker;
        worker = undefined;
        void stoppingWorker.terminate().then(() => { release(); resolve(Object.freeze(result)); }, () => {
          // Fail closed: unknown worker teardown retains its slot instead of overcommitting.
          resolve({ status: 'failed', diagnostic: 'Program worker termination could not be confirmed.' });
        });
      } else { release(); resolve(Object.freeze(result)); }
    }
    function post(message: HostMessage): void {
      if (!settled) worker?.postMessage(message);
    }
    function receive(message: WorkerMessage): void {
      if (settled) return;
      if (message.type === 'result') {
        try {
          const result = message.result;
          const value = result.value === undefined ? undefined : parseJsonValue(result.value, jsonLimits(limits.outputBytes));
          if (value !== undefined) checkBytes(JSON.stringify(value), limits.outputBytes, 'Program output');
          finish({ status: result.status, ...(value === undefined ? {} : { value }),
            ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic.slice(0, 1024) }) });
        } catch {
          finish({ status: 'failed', diagnostic: 'Program output exceeds its JSON limits.' });
        }
        return;
      }
      callCount += 1;
      if (callCount > limits.calls) {
        finish({ status: 'failed', diagnostic: 'Program call limit exceeded.' });
        return;
      }
      let capturedInput;
      try {
        if (!allowed.has(message.name)) throw new TypeError('Tool is not in the program manifest.');
        checkBytes(message.input, limits.callInputBytes, 'Program call input');
        capturedInput = parseJsonObject(JSON.parse(message.input), jsonLimits(limits.callInputBytes));
      } catch {
        post({ type: 'call_error', id: message.id, diagnostic: 'Program call requires an allowed tool and a bounded JSON object.' });
        return;
      }
      // Enter the runtime synchronously for every message, including unawaited calls.
      // A result message cannot pass this boundary before earlier call messages do.
      let operation;
      try {
        operation = input.call(message.name, capturedInput);
      } catch {
        post({ type: 'call_error', id: message.id, diagnostic: 'Host call did not return a receipt.' });
        return;
      }
      void operation.then((receipt) => {
        if (settled) return;
        try {
          const captured = parseJsonValue(receipt, jsonLimits(limits.callResultBytes));
          const json = JSON.stringify(captured);
          checkBytes(json, limits.callResultBytes, 'Program call result');
          callResultBytes += Buffer.byteLength(json, 'utf8');
          if (callResultBytes > limits.totalCallResultBytes)
            throw new TypeError('Program aggregate call-result limit exceeded.');
          post({ type: 'call_result', id: message.id, json });
        } catch {
          finish({ status: 'failed', diagnostic: 'Host receipt exceeds program result limits; the runtime retains the child observation.' });
        }
      }, () => {
        post({ type: 'call_error', id: message.id, diagnostic: 'Host call did not return a receipt.' });
      });
    }
    try {
      const workerData: WorkerInput = { source, manifest, limits };
      worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData,
        env: {},
        argv: [],
        execArgv: [],
        stdin: false,
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
      });
      // Engine diagnostics are bounded and never forwarded. No guest logger is exposed.
      const discardDiagnostic = (chunk: Buffer): void => {
        diagnosticBytes += chunk.byteLength;
        if (diagnosticBytes > limits.outputBytes)
          finish({ status: 'failed', diagnostic: 'Program interpreter diagnostic-output limit exceeded.' });
      };
      worker.stdout.on('data', discardDiagnostic);
      worker.stderr.on('data', discardDiagnostic);
      worker.on('message', receive);
      worker.once('error', () => { finish({ status: 'failed', diagnostic: 'Isolated program worker failed.' }); });
      worker.once('exit', () => { finish({ status: 'failed', diagnostic: 'Isolated program worker ended without a result.' }); });
      timer = setTimeout(() => { finish({ status: 'interrupted', diagnostic: 'Program wall-time limit exceeded.' }); }, limits.wallTimeMs);
      input.signal.addEventListener('abort', interrupt, { once: true });
      input.observationSignal?.addEventListener('abort', interrupt, { once: true });
      if (input.signal.aborted || input.observationSignal?.aborted) interrupt();
    } catch (error) {
      finish({ status: 'failed', diagnostic: boundedDiagnostic(error) });
    }
  });
}

function jsonLimits(bytes: number) {
  return { maxDepth: 64, maxCollectionEntries: 50_000, maxStringBytes: bytes, maxTotalBytes: bytes };
}

function checkBytes(value: string, maximum: number, name: string): void {
  if (typeof value !== 'string' || value.length > maximum || Buffer.byteLength(value, 'utf8') > maximum)
    throw new TypeError(`${name} exceeds its byte limit.`);
}

function boundedDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1024) : 'Program input is invalid.';
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] { return Array.isArray(value); }
