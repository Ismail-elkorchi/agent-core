import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

interface EditorProcess { pid: number; parent: number; state: string; started: string }

// Keep the editor in our foreground process group: detached children cannot
// reliably read the controlling terminal. Unlike background tool execution,
// cancellation therefore owns a waiting process tree, not a process group.
function editorProcesses(): EditorProcess[] {
  return execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'lstart='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim().split('\n').filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    const [, pid, parent, state, started] = match ?? [];
    if (!pid || !parent || !state || !started) throw new Error('Could not inspect the external editor process tree.');
    return { pid: Number(pid), parent: Number(parent), state, started };
  });
}

function signalEditor(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

// Reconcile identities before following parent links: a recycled PID is not
// authority over the replacement process or any of its children.
function refreshEditorTree(owned: Map<number, EditorProcess>, snapshot: EditorProcess[]): void {
  for (const [pid, previous] of owned) {
    const current = snapshot.find((entry) => entry.pid === pid && entry.started === previous.started);
    if (!current || current.state.startsWith('Z')) owned.delete(pid);
    else owned.set(pid, current);
  }
  for (;;) {
    const children = snapshot.filter(({ pid, parent, state }) =>
      owned.has(parent) && !owned.has(pid) && !state.startsWith('Z'));
    if (children.length === 0) return;
    for (const entry of children) owned.set(entry.pid, entry);
  }
}

async function freezeEditorTree(owned: Map<number, EditorProcess>): Promise<void> {
  for (;;) {
    refreshEditorTree(owned, editorProcesses());
    const running = [...owned.values()].filter(({ state }) => !/^[Tt]/.test(state));
    if (running.length === 0) return;
    for (const { pid } of running) signalEditor(pid, 'SIGSTOP');
    // Sending SIGSTOP is not proof that it has taken effect. Inspect again
    // after all parents stop, including children created before they stopped.
    await delay(20);
  }
}

async function stopEditor(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Await the tree operation as well as the child close event. Killing only
    // cmd.exe can leave the actual editor holding inherited console handles.
    await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }

  const owned = new Map<number, EditorProcess>();
  // Freeze parents before discovering their children. Supported wrappers wait
  // for their children, so they cannot disappear and orphan undiscovered work.
  signalEditor(child.pid, 'SIGSTOP');
  let snapshot: EditorProcess[];
  try {
    snapshot = editorProcesses();
    const root = snapshot.find(({ pid }) => pid === child.pid);
    if (root) owned.set(root.pid, root);
    await freezeEditorTree(owned);
  } catch (error) {
    // No termination has happened yet. Restore a runnable waiting tree if
    // discovery fails; the caller retains ownership until its natural close.
    for (const { pid } of owned.values()) signalEditor(pid, 'SIGCONT');
    signalEditor(child.pid, 'SIGCONT');
    throw error;
  }
  for (const { pid } of owned.values()) signalEditor(pid, 'SIGTERM');
  for (const { pid } of owned.values()) signalEditor(pid, 'SIGCONT');
  const killAt = Date.now() + 1000;
  while (owned.size > 0) {
    try {
      snapshot = editorProcesses();
    } catch {
      // After terminating a wrapper, a failed inspection is not exit proof.
      // Retain terminal ownership and the draft until inspection recovers.
      await delay(20);
      continue;
    }
    refreshEditorTree(owned, snapshot);
    if (Date.now() >= killAt) {
      try {
        // Graceful shutdown may itself create waiting cleanup children. Freeze
        // and rediscover the complete surviving tree before killing parents.
        await freezeEditorTree(owned);
      } catch {
        // No new exit proof: retain ownership and retry discovery, even when
        // some of the tree is already stopped.
        await delay(20);
        continue;
      }
      for (const { pid } of owned.values()) signalEditor(pid, 'SIGKILL');
    }
    if (owned.size > 0) await delay(20);
  }
}

/**
 * Call inside the terminal owner's suspension boundary. VISUAL/EDITOR is user
 * configuration and must wait for all editor descendants (use GUI --wait flags).
 * Daemonizing/disowning commands are unsupported. POSIX requires standard ps;
 * Windows requires taskkill. Terminal ownership lasts through tree settlement.
 */
export async function editTextExternally(text: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const editorCommand = process.env.VISUAL ?? process.env.EDITOR;
  if (!editorCommand) throw new Error('Set VISUAL or EDITOR to use an external editor.');
  if (process.platform !== 'win32') editorProcesses();
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-draft-'));
  const file = path.join(directory, 'draft.txt');
  try {
    await writeFile(file, text, { mode: 0o600 });
    signal.throwIfAborted();
    const child = process.platform === 'win32'
      ? spawn(`${editorCommand} "%AGENT_TUI_DRAFT%"`, [], {
          shell: true, stdio: 'inherit', env: { ...process.env, AGENT_TUI_DRAFT: file }
        })
      : spawn('/bin/sh', ['-c', `exec ${editorCommand} "$1"`, 'editor', file], { stdio: 'inherit' });
    let failure: Error | undefined;
    let stopping: Promise<void> | undefined;
    const closed = new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
      child.on('error', (error) => { failure ??= error; });
      child.once('close', (code, exitSignal) => { resolve({ code, exitSignal }); });
    });
    const abort = () => {
      stopping ??= stopEditor(child);
      // Attach a rejection handler immediately; settlement below owns failure.
      void stopping.catch(() => { /* Awaited below after the editor closes. */ });
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const { code, exitSignal } = await closed;
      await stopping;
      signal.throwIfAborted();
      if (failure) throw failure;
      if (code !== 0) throw new Error(`Editor exited with ${exitSignal ?? String(code)}; the draft is unchanged.`);
      const edited = await readFile(file, 'utf8');
      signal.throwIfAborted();
      return edited;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
