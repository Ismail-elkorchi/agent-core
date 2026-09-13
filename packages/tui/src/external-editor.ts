import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Call inside the terminal owner's suspension boundary. The editor command is user configuration. */
export async function editTextExternally(text: string, signal: AbortSignal): Promise<string> {
  const editorCommand = process.env.VISUAL ?? process.env.EDITOR;
  if (!editorCommand) throw new Error('Set VISUAL or EDITOR to use an external editor.');
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-draft-'));
  const file = path.join(directory, 'draft.txt');
  try {
    await writeFile(file, text, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child =
        process.platform === 'win32'
          ? spawn(`${editorCommand} "%AGENT_TUI_DRAFT%"`, [], {
              shell: true,
              stdio: 'inherit',
              signal,
              env: { ...process.env, AGENT_TUI_DRAFT: file }
            })
          : spawn('/bin/sh', ['-c', `exec ${editorCommand} "$1"`, 'editor', file], {
              stdio: 'inherit',
              signal
            });
      child.once('error', reject);
      child.once('exit', (code, exitSignal) => {
        if (code === 0) resolve();
        else reject(new Error(`Editor exited with ${exitSignal ?? String(code)}; the draft is unchanged.`));
      });
    });
    signal.throwIfAborted();
    return await readFile(file, 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
