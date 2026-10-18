import assert from 'node:assert/strict';
import test from 'node:test';
import { createProgrammaticTool, DEFAULT_PROGRAM_LIMITS, parseProgramLimits } from '@agent-core/tools-programmatic';
import { createQuickJSProgramRunner } from '@agent-core/tools-programmatic/node';

const tools = [{
  name: 'echo', description: 'Echo a value',
  inputSchema: { type: 'object', properties: { value: {} } },
  outputSchema: { type: 'object' }
}];
function run(source, { limits, call = async (_name, input) => ({ receipt: 'durable', input }), signal, observationSignal, manifest = tools } = {}) {
  const runner = createQuickJSProgramRunner({ ...(limits ? { limits } : {}) });
  return runner.run({ source, tools: manifest, call,
    signal: signal ?? new AbortController().signal,
    ...(observationSignal ? { observationSignal } : {}) });
}

test('programmatic definition is explicit direct-only orchestration with no inherited effect locks', () => {
  const tool = createProgrammaticTool();
  assert.equal(tool.name, 'run_program');
  assert.deepEqual(tool.invocationModes, ['direct']);
  assert.deepEqual(tool.effectEnvelope, { accesses: [], lockScopes: [] });
  assert.deepEqual(tool.deriveEffects(), { accesses: [], lockScopes: [], recovery: { kind: 'unknown' } });
  assert.deepEqual(tool.textInput.decode('return 1;'), { source: 'return 1;' });
  assert.equal(createQuickJSProgramRunner().toolName, tool.name);
});

test('isolated async body sees a frozen portable manifest and exact host receipt', async () => {
  const calls = [];
  const result = await run('const receipt = await call(tools[0].name, {value: 7}); return {receipt, frozen: Object.isFrozen(tools[0].inputSchema)};', {
    call: async (name, input) => { calls.push({ name, input }); return { observationId: 'saved-1', value: input.value }; }
  });
  assert.deepEqual(result, { status: 'completed', value: { frozen: true, receipt: { observationId: 'saved-1', value: 7 } } });
  assert.deepEqual(calls, [{ name: 'echo', input: { value: 7 } }]);
});

test('parallel calls settle asynchronously without blocking the host event loop', async () => {
  const result = await run('return await Promise.all([call("echo",{value:1}),call("echo",{value:2})]);', {
    call: (_name, input) => new Promise((resolve) => setTimeout(() => resolve({ receipt: input.value }), 20))
  });
  assert.deepEqual(result, { status: 'completed', value: [{ receipt: 1 }, { receipt: 2 }] });
});

test('unawaited calls cross the host admission boundary before the program result', async () => {
  const started = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const result = await run('call("echo",{value:1}); Promise.resolve().then(() => call("echo",{value:2})); return "returned";', {
    call: (_name, input) => { started.push(input.value); return pending; }
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(started, [1, 2]);
  release({ receipt: 'settled-later' });
});

test('guest has no filesystem, network, module, environment, or host constructor escape', async () => {
  process.env.AGENT_CORE_PROGRAM_SECRET = 'must-not-enter-guest';
  try {
    const result = await run(`
      const absent = ['process','require','module','fetch','XMLHttpRequest','WebSocket','Buffer','setTimeout','setInterval','Worker','WebAssembly','hostCall'];
      const types = absent.map(name => typeof globalThis[name]);
      let moduleDenied = false;
      try { await import('node:fs'); } catch { moduleDenied = true; }
      const constructorScope = await call.constructor('return typeof process')();
      return {types,moduleDenied,constructorScope};
    `);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.value.types, Array(12).fill('undefined'));
    assert.equal(result.value.moduleDenied, true);
    assert.equal(result.value.constructorScope, 'undefined');
  } finally { delete process.env.AGENT_CORE_PROGRAM_SECRET; }
});

test('source cannot escape its async function body into host initialization', async () => {
  const result = await run('}); globalThis.pwned = true; (async function(){ return 1;');
  assert.equal(result.status, 'failed');
  const next = await run('return typeof pwned;');
  assert.deepEqual(next, { status: 'completed', value: 'undefined' });
});

test('infinite computation reaches an execution limit', async () => {
  const result = await run('while (true) {}', { limits: { executionTimeMs: 30 } });
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostic, /execution-time limit/u);
});

test('native regular-expression computation cannot prevent cancellation', async () => {
  const controller = new AbortController();
  let timer;
  let started;
  const result = await run('await call("echo",{}); return /^(a+)+$/.test("a".repeat(100000)+"!");', {
    signal: controller.signal,
    call: async () => { started = performance.now(); timer = setTimeout(() => controller.abort(), 150); return {}; }
  });
  clearTimeout(timer);
  assert.equal(result.status, 'interrupted');
  assert.ok(started !== undefined && performance.now() - started < 2000, 'parent remained responsive while worker computed');
});

test('cancellation leaves already-started host calls owned by their host', async () => {
  const controller = new AbortController();
  let started = 0;
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const result = await run('return await call("echo",{});', {
    signal: controller.signal,
    call: () => { started++; setImmediate(() => controller.abort()); return pending; }
  });
  assert.equal(started, 1);
  assert.equal(result.status, 'interrupted');
  assert.match(result.diagnostic, /interrupted/u);
  settle({ receipt: 'settled-after-interruption' });
});

test('observation steering interrupts guest computation and prevents later host calls', async () => {
  const controller = new AbortController();
  let calls = 0;
  let timer;
  const result = await run('await call("echo",{}); while(true){} await call("echo",{});', {
    observationSignal: controller.signal,
    call: async () => { calls++; timer = setTimeout(() => controller.abort(), 150); return {}; }
  });
  clearTimeout(timer);
  assert.equal(result.status, 'interrupted');
  assert.equal(calls, 1);
});

test('hard WASM memory boundary contains the upstream repeat-string allocator attack', async () => {
  const result = await run('const chunks=[]; while(true) chunks.push("x".repeat(1024*1024));', {
    limits: { heapBytes: 24 * 1024 * 1024, wasmMemoryBytes: 32 * 1024 * 1024, executionTimeMs: 2000 }
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(await run('return 42;'), { status: 'completed', value: 42 });
});

test('source and manifest are bounded before starting the worker', async () => {
  const tooLong = await run('return "lots of source";', { limits: { sourceBytes: 8 } });
  assert.match(tooLong.diagnostic, /source.*byte limit/u);
  const manifest = await run('return 1;', { limits: { manifestBytes: 8 } });
  assert.equal(manifest.status, 'failed');
});

test('call input, output, and aggregate receipt bytes are bounded', async () => {
  let calls = 0;
  const tooLargeInput = await run('return await call("echo",{value:"x".repeat(100)});', {
    limits: { callInputBytes: 16 }, call: async () => { calls++; return {}; }
  });
  assert.equal(tooLargeInput.status, 'failed');
  assert.equal(calls, 0);
  const tooLargeOutput = await run('return "é".repeat(40);', { limits: { outputBytes: 64 } });
  assert.equal(tooLargeOutput.status, 'failed');
  const tooLargeReceipt = await run('return await call("echo",{});', {
    limits: { callResultBytes: 16 }, call: async () => ({ value: 'x'.repeat(100) })
  });
  assert.equal(tooLargeReceipt.status, 'failed');
  const aggregate = await run('await call("echo",{}); return await call("echo",{});', {
    limits: { totalCallResultBytes: 16 }, call: async () => ({ value: 1234 })
  });
  assert.equal(aggregate.status, 'failed');
});

test('only manifest tools may cross the bridge and call count is bounded', async () => {
  let calls = 0;
  const unknown = await run('return await call("not_allowed",{});', { call: async () => { calls++; return {}; } });
  assert.equal(unknown.status, 'failed');
  assert.equal(calls, 0);
  const limit = await run('for(let i=0;i<5;i++) await call("echo",{}); return true;', {
    limits: { calls: 2 }, call: async () => { calls++; return {}; }
  });
  assert.equal(limit.status, 'failed');
  assert.equal(calls, 2);
});

test('non-JSON, accessors, sparse arrays, cycles and inherited toJSON are rejected', async () => {
  for (const expression of ['1n', '{value:undefined}', '{get value(){return 1}}', '[,1]', '(()=>{const a={};a.a=a;return a})()', 'new Date()']) {
    const result = await run(`return (${expression});`);
    assert.equal(result.status, 'failed', expression);
  }
  const result = await run('Object.prototype.toJSON=()=>"altered"; Array.prototype.toJSON=()=>"altered"; return {value:[1,2]};');
  assert.deepEqual(result, { status: 'completed', value: { value: [1, 2] } });
});

test('an unsettled guest-only promise fails without waiting for wall time', async () => {
  const result = await run('await new Promise(()=>{});');
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostic, /cannot settle/u);
});

test('invalid resource limits fail at runner creation', () => {
  assert.throws(() => createQuickJSProgramRunner({ limits: { calls: 0 } }), /positive/u);
  assert.throws(() => createQuickJSProgramRunner({ limits: { wasmMemoryBytes: 1 } }), /16 MiB/u);
  assert.throws(() => createQuickJSProgramRunner({ limits: { executionTimeMs: DEFAULT_PROGRAM_LIMITS.wallTimeMs + 1 } }), /wall time/u);
});


test('wall-time limit applies to pending host waits', async () => {
  const result = await run('return await call("echo",{});', {
    limits: { wallTimeMs: 1000, executionTimeMs: 100 },
    call: () => new Promise(() => {})
  });
  assert.equal(result.status, 'interrupted');
  assert.match(result.diagnostic, /wall-time/u);
});

test('public limit parser rejects unknown keys and retains validated defaults', () => {
  assert.deepEqual(parseProgramLimits({ calls: 3 }), { ...DEFAULT_PROGRAM_LIMITS, calls: 3 });
  assert.throws(() => parseProgramLimits({ unexpected: 1 }), /Unknown program limit/u);
  assert.throws(() => parseProgramLimits({ constructor: 1 }), /Unknown program limit/u);
  assert.throws(() => parseProgramLimits({ calls: "3" }), /positive safe integer/u);
  assert.throws(() => parseProgramLimits({ wallTimeMs: 2 ** 32 }), /timer range/u);
  assert.throws(() => parseProgramLimits([]), /object/u);
});


test('large ArrayBuffers and recursive stacks remain inside the interpreter limits', async () => {
  assert.equal((await run('return new ArrayBuffer(2 ** 30);')).status, 'failed');
  assert.equal((await run('function recurse(){ return recurse(); } return recurse();')).status, 'failed');
});


test('factory bounds source before effect planning, including exact UTF-8 bytes', () => {
  const tool = createProgrammaticTool({ limits: { sourceBytes: 11 } });
  assert.equal(tool.jsonSchema.properties.source.maxLength, 11);
  assert.equal(tool.decodeInput({ kind: 'json', value: { source: 'return "long";' } }).ok, false);
  const decoded = tool.decodeInput({ kind: 'json', value: { source: 'return "é";' } });
  assert.equal(decoded.ok, true);
  assert.throws(() => tool.canonicalizeInput(decoded.input), /UTF-8 byte limit/u);
});


test('shared runner fails overload before spawning and releases its slot after termination', async () => {
  const runner = createQuickJSProgramRunner();
  assert.equal(runner.maxConcurrentPrograms, 1);
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const first = runner.run({ source: 'await call("echo",{});', tools, signal: controller.signal,
    call: () => { calls++; entered(); return new Promise(() => {}); } });
  await started;
  const overloaded = await runner.run({ source: 'await call("echo",{});', tools,
    signal: new AbortController().signal, call: async () => { calls++; return {}; } });
  assert.equal(overloaded.status, 'failed');
  assert.match(overloaded.diagnostic, /concurrency limit/u);
  assert.equal(calls, 1);
  controller.abort();
  assert.equal((await first).status, 'interrupted');
  const next = await runner.run({ source: 'return 3;', tools, signal: new AbortController().signal, call: async () => ({}) });
  assert.deepEqual(next, { status: 'completed', value: 3 });
  assert.throws(() => parseProgramLimits({ concurrentPrograms: 65 }), /concurrency/u);
});

test('runner executes the captured source and releases validation-failure admission', async () => {
  const runner = createQuickJSProgramRunner({ limits: { sourceBytes: 64 } });
  const input = { tools, signal: new AbortController().signal, call: async () => ({}) };
  assert.equal((await runner.run({ ...input, source: 'x'.repeat(65) })).status, 'failed');
  let reads = 0;
  const result = await runner.run({ ...input,
    get source() { reads++; return reads === 1 ? 'return 1;' : 'while (true) {}'; }
  });
  assert.deepEqual(result, { status: 'completed', value: 1 });
  assert.equal(reads, 1);
});

test('runner admission identity binds every captured limit and implementation configuration', () => {
  const runner = createQuickJSProgramRunner();
  assert.match(runner.configurationRevision, /^[a-f0-9]{64}$/u);
  assert.equal(createQuickJSProgramRunner({ limits: { ...DEFAULT_PROGRAM_LIMITS } }).configurationRevision, runner.configurationRevision);
  assert.equal(createQuickJSProgramRunner({ limits: { calls: DEFAULT_PROGRAM_LIMITS.calls } }).configurationRevision, runner.configurationRevision);
  for (const name of Object.keys(DEFAULT_PROGRAM_LIMITS)) {
    const increment = name === 'wasmMemoryBytes' ? 65536 : 1;
    assert.notEqual(createQuickJSProgramRunner({ limits: { [name]: DEFAULT_PROGRAM_LIMITS[name] + increment } }).configurationRevision,
      runner.configurationRevision, name + ' changes accepted program configuration');
  }
  assert.notEqual(createQuickJSProgramRunner({ toolName: 'custom_program' }).configurationRevision, runner.configurationRevision);
  const callerLimits = { calls: 3 };
  const captured = createQuickJSProgramRunner({ limits: callerLimits });
  callerLimits.calls = 4;
  assert.equal(captured.configurationRevision, createQuickJSProgramRunner({ limits: { calls: 3 } }).configurationRevision);
  assert.equal(Object.isFrozen(captured), true);
});

test('serialized manifest establishes fresh immutable ownership inside the guest realm', async () => {
  const manifest = [{ name: 'echo', description: 'Echo',
    inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } },
    outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' } } } }];
  const pending = run(`
    const targets = [tools, tools[0], tools[0].inputSchema, tools[0].inputSchema.required,
      tools[0].inputSchema.properties, tools[0].inputSchema.properties.value,
      tools[0].outputSchema.properties.accepted];
    let blocked = 0;
    for (const mutate of [
      () => { tools[0].name = 'forged'; },
      () => { tools.push({name:'forged'}); },
      () => { tools[0].inputSchema.required.push('forged'); },
      () => { tools[0].inputSchema.properties.value.type = 'string'; },
      () => { delete tools[0].outputSchema.properties.accepted.type; },
      () => { Object.setPrototypeOf(tools[0].inputSchema, null); }
    ]) { try { mutate(); } catch (error) { if (error instanceof TypeError) blocked++; else throw error; } }
    return { frozen: targets.every(Object.isFrozen), blocked, required: tools[0].inputSchema.required,
      type: tools[0].inputSchema.properties.value.type, receipt: await call(tools[0].name, {value:7}) };
  `, { manifest, call: async (name, input) => { assert.equal(name, 'echo'); assert.deepEqual(input, { value: 7 }); return { accepted: true }; } });
  manifest[0].name = 'changed-after-admission';
  manifest[0].inputSchema.properties.value.type = 'string';
  assert.deepEqual(await pending, { status: 'completed', value: {
    frozen: true, blocked: 6, required: ['value'], type: 'number', receipt: { accepted: true }
  } });
});
