import { renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';

export async function waitFor(condition) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition.');
}

export function plainOutput(host) {
  return host.output().replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, '');
}

export function latestFramePlain(host) {
  const frame = host.frames().at(-1);
  if (frame === undefined) return '';
  return renderFramePlain(frame);
}

export function frameHistoryPlain(host) {
  return host.frames().map((frame) => renderFramePlain(frame)).join('\n');
}
