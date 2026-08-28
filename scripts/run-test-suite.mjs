import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linuxRootCapabilityTests = new Set([
  'tests/self-hosting-smoke.test.js',
  'tests/tools/apply-patch.test.js',
  'tests/tools/artifacts-images.test.js',
  'tests/tools/authorization-invariants.test.js',
  'tests/tools/durable-redaction.test.js',
  'tests/tools/file-tools.test.js',
  'tests/tools/process-lifecycle-fault-matrix.test.js',
  'tests/tools/process-tools.test.js',
  'tests/tools/read-evidence.test.js',
  'tests/tools/runtime-process-cleanup.test.js'
].map((value) => path.join(root, value)));

export async function ordinaryTestFiles() {
  const packageTests = await filesUnder(path.join(root, 'packages'));
  return [
    ...await filesUnder(path.join(root, 'tests')),
    ...packageTests.filter((file) => file.split(path.sep).includes('test'))
  ]
    .filter((file) => file.endsWith('.test.js'))
    .sort();
}

async function run() {
  const discovered = await ordinaryTestFiles();
  const files = process.platform === 'linux' ? discovered : discovered.filter((file) => !linuxRootCapabilityTests.has(file));
  if (files.length === 0) throw new Error('No ordinary test files were discovered under tests/.');
  const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (value, signal) => signal ? reject(new Error(`Ordinary test process ended with ${signal}.`)) : resolve(value ?? 1));
  });
  if (code !== 0) process.exitCode = code;
}

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(absolute));
    else output.push(absolute);
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
