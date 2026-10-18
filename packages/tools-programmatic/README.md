# @agent-core/tools-programmatic

Optional, provider-neutral programmatic tool orchestration. The package root
exports the tool definition, limits, and runner contracts without initializing a
worker or QuickJS. The explicit `/node` export supplies the QuickJS/WASM worker implementation.

```ts
import { createProgrammaticTool } from '@agent-core/tools-programmatic';
import { createQuickJSProgramRunner } from '@agent-core/tools-programmatic/node';

const limits = { sourceBytes: 128 * 1024 };
const programTool = createProgrammaticTool({ limits });
const programRunner = createQuickJSProgramRunner({ limits });
// Add programTool to the application's ToolRegistry and supply programRunner
// through the runtime configuration. Their toolName/name must match.
```

A program is an async JavaScript **function body**, supplied as `{ source }` or as
freeform text when the model provider supports the text tool format:

```js
const receipt = await call('lookup_record', { recordId: 'example' });
return { receipt };
```

Programs receive only `call(name, input)` and `tools`, a recursively frozen manifest
of public names, descriptions, input schemas, and output schemas. Tool names must
appear in this manifest. `call` accepts a bounded JSON object and resolves to the
runtime's durable child receipt. Inputs and results must be finite JSON data;
accessors, class instances, sparse arrays, cycles, functions, and bigints are
rejected. An absent return value is represented by JSON null.

## Authority and recovery

The program tool is direct-only. Leaf tools must explicitly allow programmatic
invocation. The runtime supplies `programExecution`, admits every child through
its ordinary schema, policy, authorization, effect, budget, and observation paths,
and records each child independently. The package never imports or invokes leaf
implementations. The orchestration definition acquires no leaf-effect locks.

The runtime owns the final observation and complete receipts, including calls the
program did not await. Earlier call messages enter the runtime before a final
program-result message can be accepted. A program result is computation output,
not an acknowledgement of durability or proof that every child effect succeeded.

Stopping the worker does not cancel, undo, forget, or retry started host calls.
Their runtime host retains recovery responsibility. Interrupted programs are not
replayed, and the definition's recovery policy is `unknown`. Runtime restrictions
also forbid recursive program execution and context activation through children.
A completed program's later, unawaited promise continuations are not resumed.

## Isolation and bounds

Each invocation receives a fresh QuickJS interpreter in its own WebAssembly module
and Node worker. Acorn validates the exact async-function body before guest code can run. Guest code is never evaluated by Node's `eval`, `Function`, or
`vm`. Guest `Function` and `eval` remain inside QuickJS. There is no guest Node,
filesystem, network, environment, credential, module loader, timer, or worker
capability. The host bridge exposes only bounded JSON strings. Its Node worker
starts with an empty environment and no inherited command-line flags.

Default bounds:

- 1 concurrent worker across all runs sharing the runner instance
- 30 seconds total worker wall time, including startup and host-call waits
- 1 second accumulated guest execution time, excluding host-call waits
- 8 MiB requested QuickJS allocator limit
- 32 MiB hard WebAssembly linear-memory maximum
- 256 KiB QuickJS stack limit
- 128 KiB source; 1 MiB manifest
- 64 calls; 64 KiB per call input
- 1 MiB per received receipt, 8 MiB total received receipt bytes
- 128 KiB final program output

Parse untrusted configuration with `parseProgramLimits(value)` from the package
root; it rejects unknown keys and returns the complete validated limits.

Pass the same limits to `createProgrammaticTool({ limits })` and
`createQuickJSProgramRunner({ limits })`. The definition advertises a finite source
length and rejects excess UTF-8 bytes before effect planning; the isolated runner
checks again at its boundary. This does not truncate the original model transcript.
The immutable `configurationRevision` binds the runner implementation, tool name,
and every parsed limit to runtime admission and restart compatibility checks.
The runner exposes `maxConcurrentPrograms` for runtime scheduling. If independent
runs overload a shared runner, admission fails immediately without a worker or
waiter queue. Slots release only after worker termination is confirmed. Configure
`concurrentPrograms` from 1 to 64 according to host capacity; this is not a process
RSS quota or a hard real-time scheduling guarantee.

Positive safe integers are required; the WASM maximum is at least 16 MiB and a
multiple of 64 KiB. VM interruption bounds interpreter loops and promise jobs.
The parent independently terminates the worker at its wall deadline or on either
cancellation/observation signal, so native VM work cannot block host steering.
Execution time measures time in guest execution slices; it is not an operating
system CPU-usage counter. Native VM calls may run until the hard wall deadline.

The hard memory boundary is an explicitly supplied `WebAssembly.Memory` with
identical initial and maximum pages. Before running guest code the worker verifies
that QuickJS uses this exact object and that growing it fails. This avoids relying
on the allocator limit alone: upstream [issue #255](https://github.com/justjake/quickjs-emscripten/issues/255)
reports allocator-limit bypass with prebuilt variants. Fixed linear memory also
avoids growth-related buffer invalidation. Worker V8 heap limits provide additional
host-side containment; these and the WASM limit are **not a total process RSS
quota**. Bounded source, manifest, bridge strings, calls, and results constrain
extra host allocations. Applications requiring an OS-enforced RSS or tenant
security boundary should additionally isolate the entire host process.

QuickJS is pinned to 0.32.0. The supplied-memory API and memory identity check fail
closed if dependency behavior changes. Every worker is terminated after its one
result; teardown does not run guest finalizers after OOM/interruption (see upstream
[issue #257](https://github.com/justjake/quickjs-emscripten/issues/257)). No sandbox is
a substitute for keeping the interpreter and host runtime security-patched.
