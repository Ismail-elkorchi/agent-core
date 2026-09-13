import { spawn } from 'node:child_process';

/** Opens an explicitly chosen web link without interpreting it as shell code. */
export async function openBrowser(value: string, signal: AbortSignal): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Only HTTP and HTTPS sign-in links can be opened.');
  signal.throwIfAborted();
  const [command, ...args] =
    process.platform === 'win32'
      ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url.href]
      : process.platform === 'darwin'
        ? ['open', url.href]
        : ['xdg-open', url.href];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', signal });
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Browser launcher exited with ${exitSignal ?? String(code)}. Copy the sign-in link to open it elsewhere.`
          )
        );
    });
  });
}
