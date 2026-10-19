import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactIntegrityError } from '@agent-core/persistence';
import { LocalArtifactRepository } from '@agent-core/persistence/node';

const content = Buffer.from('immutable artifact evidence');
const input = { label: 'original', mediaType: 'text/plain', content };
const store = (repository, visibility, value = input) => visibility === 'protected'
  ? repository.storeProtected(value) : repository.store(value);
const bodyPath = (directory, ref) => path.join(directory, ...(ref.visibility === 'protected' ? ['protected'] : []), ref.artifactId);
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode];

for (const visibility of ['public', 'protected']) {
  test(`${visibility}: long-root publication and reopened verification preserve immutable storage`, async t => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'artifact-long-root-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, ...Array.from({ length: 3 }, (_, index) => `${index}-${'nested'.repeat(12)}`));
    const original = await store(new LocalArtifactRepository(root), visibility);
    const target = bodyPath(root, original);
    assert.ok(target.length > 300);
    const before = identity(await fs.stat(target, { bigint: true }));
    const reopened = new LocalArtifactRepository(root);
    const repeated = await store(reopened, visibility, { ...input, label: 'reopened' });
    assert.equal(repeated.artifactId, original.artifactId);
    assert.deepEqual(identity(await fs.stat(target, { bigint: true })), before);
    assert.deepEqual(Buffer.from(await reopened.readVerified(original)), content);
    assert.deepEqual(Buffer.from((await reopened.readVerifiedRange(original, { offset: 0, length: 9 })).bytes), content.subarray(0, 9));
    assert.deepEqual(await reopened.resolve(original.artifactId), visibility === 'public' ? original : undefined);
    assert.deepEqual(await fs.readdir(path.join(root, '.locks')), []);
  });

  for (const readKind of ['full', 'range', 'cached range']) {
    test(`${visibility}: identical concurrent stores preserve an in-flight ${readKind} verification`, async t => {
      const directory = await fs.mkdtemp(path.join(tmpdir(), 'artifact-concurrent-read-'));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const original = await store(new LocalArtifactRepository(directory), visibility);
      const reader = new LocalArtifactRepository(directory);
      const target = bodyPath(directory, original);
      const before = identity(await fs.stat(target, { bigint: true }));
      if (readKind === 'cached range') await reader.readVerifiedRange(original, { offset: 0, length: 9 });
      const opened = Promise.withResolvers();
      const resume = Promise.withResolvers();
      let paused = false;
      const open = fs.open.bind(fs);
      t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await open(file, ...args);
        if (file === target && args[0] === 'r' && !paused) {
          paused = true;
          const stat = handle.stat.bind(handle);
          let first = true;
          handle.stat = async (...options) => {
            const result = await stat(...options);
            if (first) {
              first = false;
              opened.resolve();
              await resume.promise;
            }
            return result;
          };
        }
        return handle;
      });
      const reading = readKind === 'full' ? reader.readVerified(original)
        : reader.readVerifiedRange(original, { offset: 0, length: 9 }).then(range => range.bytes);
      // Attach rejection handling before letting the deliberately paused read continue.
      const completedRead = Promise.allSettled([reading]);
      await opened.promise;
      try {
        const writers = Array.from({ length: 6 }, (_, index) => store(new LocalArtifactRepository(directory), visibility,
          { ...input, label: `writer-${index}`, description: 'New annotations do not mutate the body' }));
        const refs = await Promise.all(writers);
        assert.ok(refs.every(ref => ref.artifactId === original.artifactId));
        assert.deepEqual(identity(await fs.stat(target, { bigint: true })), before);
      } finally {
        resume.resolve();
      }
      const [result] = await completedRead;
      assert.equal(result.status, 'fulfilled', result.reason?.message);
      assert.deepEqual(Buffer.from(result.value), readKind === 'full' ? content : content.subarray(0, 9));
      const reopened = new LocalArtifactRepository(directory);
      assert.deepEqual(Buffer.from(await reopened.readVerified(original)), content);
      assert.deepEqual(await reopened.resolve(original.artifactId), visibility === 'public' ? original : undefined);
    });
  }

  test(`${visibility}: committed corruption is rejected without replacement by another store`, async t => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'artifact-concurrent-corruption-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const original = await store(new LocalArtifactRepository(directory), visibility);
    const target = bodyPath(directory, original);
    const corrupt = Buffer.alloc(content.length, 0x78);
    await fs.writeFile(target, corrupt);
    const before = identity(await fs.stat(target, { bigint: true }));
    await assert.rejects(store(new LocalArtifactRepository(directory), visibility), ArtifactIntegrityError);
    assert.deepEqual(await fs.readFile(target), corrupt);
    assert.deepEqual(identity(await fs.stat(target, { bigint: true })), before);
    await assert.rejects(new LocalArtifactRepository(directory).readVerified(original), ArtifactIntegrityError);
  });

  test(`${visibility}: interrupted descriptor publication retains and verifies the original body`, async t => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'artifact-publication-retry-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const link = fs.link.bind(fs);
    let target;
    const failure = new Error('Interrupted before descriptor publication');
    const fault = t.mock.method(fs, 'link', async (source, destination) => {
      if (destination.endsWith('.ref.json')) throw failure;
      if (path.basename(source).startsWith('tmp-')) target = destination;
      return link(source, destination);
    });
    await assert.rejects(store(new LocalArtifactRepository(directory), visibility), error => error === failure);
    fault.mock.restore();
    assert.ok(target);
    const before = identity(await fs.stat(target, { bigint: true }));
    const reopened = new LocalArtifactRepository(directory);
    const ref = await store(reopened, visibility);
    assert.deepEqual(identity(await fs.stat(target, { bigint: true })), before);
    assert.deepEqual(Buffer.from(await reopened.readVerified(ref)), content);
  });

  test(`${visibility}: process restart recovers publication before temporary alias removal`, async t => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'artifact-publication-crash-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const child = fork(new URL('./fixtures/artifact-publication-crash.mjs', import.meta.url), [directory, visibility],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr += data; });
    const [message] = await Promise.race([
      once(child, 'message'),
      exited.then(([code, signal]) => { throw new Error(`Artifact publisher exited before the crash point (${code ?? signal}): ${stderr}`); })
    ]);
    assert.equal(message.type, 'body-linked');
    const target = message.target;
    await assert.rejects(fs.readFile(`${target}.ref.json`), { code: 'ENOENT' });
    child.kill('SIGKILL');
    await exited;
    const before = identity(await fs.stat(target, { bigint: true }));
    const reopened = new LocalArtifactRepository(directory);
    const ref = await store(reopened, visibility);
    assert.deepEqual(identity(await fs.stat(target, { bigint: true })), before);
    assert.deepEqual(Buffer.from(await reopened.readVerified(ref)), content);
    assert.deepEqual(Buffer.from((await reopened.readVerifiedRange(ref, { offset: 0, length: 9 })).bytes), content.subarray(0, 9));
    assert.deepEqual(await reopened.resolve(ref.artifactId), visibility === 'public' ? ref : undefined);
    if (process.platform !== 'win32' && visibility === 'protected') {
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    }
  });
}
