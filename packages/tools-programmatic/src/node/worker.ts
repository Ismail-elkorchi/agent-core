import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { parse } from 'acorn';
import {
  newQuickJSWASMModule,
  newVariant,
  RELEASE_SYNC,
  type QuickJSDeferredPromise,
  type QuickJSHandle
} from 'quickjs-emscripten';
import { parseJsonValue } from '@agent-core/json';
import type { ProgramRunnerResult } from '@agent-core/runtime';
import type { HostMessage, WorkerInput, WorkerMessage } from './protocol.js';
import { GUEST_ADAPTER } from './guest.js';

const port = parentPort;
if (!port) throw new Error('Program worker requires a parent port.');
const input = workerData as WorkerInput;
let finished = false;
class ProgramExecutionLimitError extends Error {
  constructor() { super('Program execution-time limit exceeded.'); }
}
function send(message: WorkerMessage): void { port?.postMessage(message); }
function finish(result: ProgramRunnerResult): void {
  if (finished) return;
  finished = true;
  send({ type: 'result', result });
  // Parent termination releases the entire WASM arena, including unresolved promises.
  // Do not run QuickJS finalizers after an OOM or interruption (upstream issue #257).
}

try {
  await execute();
} catch (error) {
  finish({ status: 'failed', diagnostic: error instanceof ProgramExecutionLimitError
    ? error.message : 'Program interpreter initialization or execution failed.' });
}

async function execute(): Promise<void> {
  const { limits } = input;
  if (!isAsyncFunctionBody(input.source)) {
    finish({ status: 'failed', diagnostic: 'Program source must be a valid async JavaScript function body.' });
    return;
  }
  const pages = limits.wasmMemoryBytes / 65_536;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  const module = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
  if (module.getWasmMemory() !== memory)
    throw new Error('QuickJS did not use the bounded WebAssembly memory.');
  // Verify the actual engine-owned memory cannot grow before executing any guest code.
  let rejectedGrowth = false;
  try { memory.grow(1); } catch { rejectedGrowth = true; }
  if (!rejectedGrowth) throw new Error('QuickJS WebAssembly memory maximum is not enforced.');
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.heapBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  let executionMs = 0;
  let sliceStart = performance.now();
  let active = false;
  let fatalDiagnostic: string | undefined;
  runtime.setInterruptHandler(() => {
    if (fatalDiagnostic) return true;
    if (active && executionMs + performance.now() - sliceStart >= limits.executionTimeMs) {
      fatalDiagnostic = 'Program execution-time limit exceeded.';
      return true;
    }
    return false;
  });
  function compute<T>(operation: () => T): T {
    if (executionMs >= limits.executionTimeMs) {
      fatalDiagnostic = 'Program execution-time limit exceeded.';
      throw new ProgramExecutionLimitError();
    }
    sliceStart = performance.now();
    active = true;
    try { return operation(); } finally {
      executionMs += performance.now() - sliceStart;
      active = false;
    }
  }
  const context = runtime.newContext();
  const pending = new Map<number, QuickJSDeferredPromise>();
  let nextId = 0;
  const hostCall = context.newFunction('hostCall', (nameHandle, inputHandle) => {
    if (context.typeof(nameHandle) !== 'string' || context.typeof(inputHandle) !== 'string')
      return { error: context.newError('Program bridge requires strings.') };
    nextId += 1;
    if (nextId > limits.calls) {
      fatalDiagnostic = 'Program call limit exceeded.';
      return { error: context.newError(fatalDiagnostic) };
    }
    const name = context.getString(nameHandle);
    const json = context.getString(inputHandle);
    if (name.length > 128 || json.length > limits.callInputBytes || Buffer.byteLength(json, 'utf8') > limits.callInputBytes)
      return { error: context.newError('Program call input exceeds its byte limit.') };
    const promise = context.newPromise();
    pending.set(nextId, promise);
    send({ type: 'call', id: nextId, name, input: json });
    return promise.handle;
  });
  // This only creates the trusted adapter. Loading the interpreter and adapter is
  // covered by the parent wall timer, rather than consuming the guest's compute budget.
  const adapterResult = context.evalCode(GUEST_ADAPTER, 'program-adapter.js');
  if (adapterResult.error) {
    finish({ status: 'failed', diagnostic: fatalDiagnostic ?? 'Program interpreter initialization failed.' });
    return;
  }
  const adapter = adapterResult.value;
  const arguments_ = [
    hostCall,
    context.newString(input.manifest),
    context.newString(input.source),
    context.newNumber(limits.callInputBytes),
    context.newNumber(limits.outputBytes)
  ];
  const invoked = compute(() => context.callFunction(adapter, context.undefined, ...arguments_));
  adapter.dispose();
  for (const handle of arguments_) handle.dispose();
  if (invoked.error) {
    finish({ status: 'failed', diagnostic: fatalDiagnostic ?? 'Program could not start.' });
    return;
  }
  const result = invoked.value;
  let queued = false;
  function schedule(): void {
    if (finished || queued) return;
    queued = true;
    setImmediate(tick);
  }
  function tick(): void {
    queued = false;
    if (finished) return;
    try {
      const jobs = compute(() => runtime.executePendingJobs(64));
      if (jobs.error || fatalDiagnostic) {
        finish({ status: 'failed', diagnostic: fatalDiagnostic ?? 'Program promise processing failed.' });
        return;
      }
      if (runtime.hasPendingJob()) { schedule(); return; }
      const state = compute(() => context.getPromiseState(result));
      if (state.type === 'rejected') {
        finish({ status: 'failed', diagnostic: fatalDiagnostic ?? guestDiagnostic(state.error) });
      } else if (state.type === 'fulfilled') {
        const json = context.getString(state.value);
        if (Buffer.byteLength(json, 'utf8') > limits.outputBytes)
          finish({ status: 'failed', diagnostic: 'Program output exceeds its byte limit.' });
        else finish({ status: 'completed', value: parseJsonValue(JSON.parse(json), { maxTotalBytes: limits.outputBytes, maxStringBytes: limits.outputBytes }) });
      } else if (pending.size === 0) {
        finish({ status: 'failed', diagnostic: 'Program cannot settle: it has no pending host calls or promise jobs.' });
      }
    } catch {
      finish({ status: 'failed', diagnostic: fatalDiagnostic ?? 'Program exceeded an interpreter limit or returned invalid JSON.' });
    }
  }
  function guestDiagnostic(error: QuickJSHandle): string {
    // Inspect only a bounded string message. Arbitrary objects or stacks never reach the host.
    try {
      const message = compute(() => context.getProp(error, 'message'));
      const diagnostic = context.typeof(message) === 'string' ? context.getString(message).slice(0, 1024) : 'Program execution failed.';
      message.dispose();
      return diagnostic;
    } catch { return fatalDiagnostic ?? 'Program execution failed.'; }
  }
  port?.on('message', (message: HostMessage) => {
    if (finished) return;
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    try {
      const handle = message.type === 'call_result' ? context.newString(message.json) : context.newError(message.diagnostic);
      compute(() => {
        if (message.type === 'call_result') promise.resolve(handle);
        else promise.reject(handle);
      });
      handle.dispose();
      promise.dispose();
      schedule();
    } catch {
      finish({ status: 'failed', diagnostic: fatalDiagnostic ?? 'Program could not receive its host receipt.' });
    }
  });
  schedule();
}

/** QuickJS's Function constructor alone accepts delimiter injection; validate the exact body first. */
function isAsyncFunctionBody(source: string): boolean {
  const prefix = 'async function __program__(call, tools) {\n"use strict";\n';
  const wrapped = prefix + source + '\n}';
  try {
    const program = parse(wrapped, { ecmaVersion: 'latest', sourceType: 'script' });
    const declaration = program.body[0];
    return program.body.length === 1 && declaration?.type === 'FunctionDeclaration' &&
      declaration.async && !declaration.generator && declaration.start === 0 &&
      declaration.end === wrapped.length && declaration.body.start === prefix.indexOf('{') &&
      declaration.body.end === wrapped.length;
  } catch { return false; }
}
