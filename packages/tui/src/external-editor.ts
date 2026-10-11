import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Call inside the terminal owner's suspension boundary. The editor command is user configuration. */
export async function editTextExternally(text: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const editorCommand = process.env.VISUAL ?? process.env.EDITOR;
  if (!editorCommand) throw new Error('Set VISUAL or EDITOR to use an external editor.');
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-draft-'));
  const file = path.join(directory, 'draft.txt');
  try {
    await writeFile(file, text, { mode: 0o600 });
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child =
        process.platform === 'win32'
          ? spawn(`${editorCommand} "%AGENT_TUI_DRAFT%"`, [], {
              shell: true,
              stdio: 'inherit',
              env: { ...process.env, AGENT_TUI_DRAFT: file }
            })
          : spawn('/bin/sh', ['-c', `exec ${editorCommand} "$1"`, 'editor', file], {
              stdio: 'inherit'
            });
      let failure: Error | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
        escalation.unref();
      };
      const failed = (error: Error) => {
        failure ??= error;
      };
      child.on('error', failed);
      // An abort/error event is not proof of exit. Keep terminal ownership and
      // the temporary draft until the child has actually closed.
      child.once('close', (code, exitSignal) => {
        signal.removeEventListener('abort', abort);
        child.off('error', failed);
        if (escalation !== undefined) clearTimeout(escalation);
        const reason: unknown = signal.reason;
        if (signal.aborted)
          reject(
            reason instanceof Error
              ? reason
              : new Error('External editing was cancelled.', { cause: reason })
          );
        else if (failure !== undefined) reject(failure);
        else if (code === 0) resolve();
        else
          reject(
            new Error(`Editor exited with ${exitSignal ?? String(code)}; the draft is unchanged.`)
          );
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    return await readFile(file, 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
