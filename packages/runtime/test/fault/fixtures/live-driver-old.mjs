import { createLiveDriverRuntime } from './live-driver-support.mjs';

const [root, mode] = process.argv.slice(2);
if (root === undefined || !['before_start', 'inside_effect', 'after_completion'].includes(mode)) {
  throw new Error('A fixture root and valid live-driver mode are required.');
}

const runtime = createLiveDriverRuntime({
  root,
  mode,
  role: 'old',
  onCheckpoint(checkpoint) {
    process.stdout.write(`${JSON.stringify({ type: 'checkpoint', checkpoint })}\n`);
  }
});
const control = runtime.run({ task: `exercise ${mode} stale-owner recovery` });
process.stdout.write(`${JSON.stringify({ type: 'run', runId: control.runId })}\n`);
try {
  const result = await control.result;
  process.stdout.write(`${JSON.stringify({ type: 'result', state: result.state })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })}\n`);
}
