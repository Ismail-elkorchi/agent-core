import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RootedFileSelector, DEFAULT_LOCAL_TOOL_CONFIGURATION, findFilesTool } from '@agent-core/tools-local';
import { workspaceTools } from '../workspace-tools-helper.js';
import { testRootedFileAuthority } from '../rooted-file-authority-helper.js';

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'ancestor-ignore-'));
  const rootPath = path.join(parent, 'root');
  await mkdir(path.join(rootPath, 'packages', 'src'), { recursive: true });
  await mkdir(path.join(rootPath, 'packages', 'dist'));
  await writeFile(path.join(parent, '.gitignore'), '*.ts\n');
  await writeFile(path.join(rootPath, '.gitignore'), '**/dist/\n*.log\n');
  await writeFile(path.join(rootPath, 'packages', '.gitignore'), '!keep.log\n');
  for (const file of ['src/main.ts', 'dist/generated.ts', 'keep.log', 'drop.log'])
    await writeFile(path.join(rootPath, 'packages', file), 'needle\n');
  const root = testRootedFileAuthority(rootPath);
  t.after(async () => { root.close(); await rm(parent, { recursive: true, force: true }); });
  return { root, rootPath };
}
const request = (startPath, extra = {}) => ({
  startPath, patterns: ['**/*'], type: 'file', respectGitIgnore: true,
  includeHidden: false, exclude: [], ...extra
});

test('subtree, ignored-directory and exact-file selection inherit only authorized ancestor rules', { skip: process.platform !== 'linux' }, async (t) => {
  const { root } = await fixture(t);
  const selector = new RootedFileSelector(root, DEFAULT_LOCAL_TOOL_CONFIGURATION.fileSelection);
  const result = await selector.select(request('packages'));
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(result.entries.map(e => e.path), ['packages/keep.log', 'packages/src/main.ts']);
  for (const start of ['packages/dist', 'packages/dist/generated.ts', 'packages/drop.log'])
    assert.deepEqual((await selector.select(request(start))).entries, []);
  assert.equal((await selector.select(request('packages/keep.log'))).entries.length, 1);
  assert.equal((await selector.select(request('packages/dist', { respectGitIgnore: false }))).entries.length, 1);
  const accesses = findFilesTool.deriveEffects({ path: 'packages/src', respectGitIgnore: true }).accesses;
  assert.deepEqual(accesses.map(a => a.scope), ['files/packages/src', 'files/packages/.gitignore', 'files/.gitignore']);
});

test('ancestor reads share ignore and traversal bounds, report unsafe rules, and observe cancellation', { skip: process.platform !== 'linux' }, async (t) => {
  const { root, rootPath } = await fixture(t);
  const limits = DEFAULT_LOCAL_TOOL_CONFIGURATION.fileSelection;
  const limited = await new RootedFileSelector(root, { ...limits, maxIgnoreFiles: 1 }).select(request('packages/src'));
  assert.equal(limited.coverage, 'partial');
  assert.ok(limited.causes.includes('ignore_file_limit'));
  const visitLimited = await new RootedFileSelector(root, { ...limits, maxVisitedEntries: 1 }).select(request('packages/src'));
  assert.equal(visitLimited.coverage, 'partial');
  assert.ok(visitLimited.causes.includes('visit_limit'));
  await rm(path.join(rootPath, 'packages', '.gitignore'));
  await symlink('../.gitignore', path.join(rootPath, 'packages', '.gitignore'));
  const selector = new RootedFileSelector(root, limits);
  const unsafe = await selector.select(request('packages/src'));
  assert.equal(unsafe.coverage, 'partial');
  assert.ok(unsafe.causes.includes('unreadable_ignore_file'));
  await assert.rejects(selector.select(request('packages/src', { signal: AbortSignal.abort(new Error('cancelled')) })), /cancelled/);
});

test('workspace file capabilities inherit ignore rules without host filesystem access', async () => {
  const f = workspaceTools({ '.gitignore': 'ignored.txt\n', 'ignored.txt': 'needle', 'keep.txt': 'needle' });
  const result = await f.invoke('find_files', { path: 'ignored.txt', patterns: ['*'] });
  assert.equal(result.kind, 'result', result.summary);
  assert.deepEqual(result.output.entries, []);
});
