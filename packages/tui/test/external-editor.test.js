import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { editTextExternally } from '@agent-core/tui/node';

async function editor(t, source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'external-editor-test-'));
  const script = path.join(directory, 'editor.mjs');
  const marker = path.join(directory, 'started.json');
  const prior = process.env.VISUAL;
  await writeFile(script, source.replaceAll('MARKER', JSON.stringify(marker)));
  const quote = (value) =>
    process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
  process.env.VISUAL = `${quote(process.execPath)} ${quote(script)}`;
  t.after(async () => {
    if (prior === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = prior;
    await rm(directory, { recursive: true, force: true });
  });
  return marker;
}

async function readStarted(marker, signal) {
  while (true) {
    try {
      return JSON.parse(await readFile(marker, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(5, undefined, { signal });
  }
}

test(
  'external editor preserves exact text and removes its temporary draft after exit',
  { timeout: 10000 },
  async (t) => {
    const marker = await editor(
      t,
      `
    import { readFileSync, writeFileSync } from 'node:fs';
    const file = process.argv[2];
    writeFileSync(MARKER, JSON.stringify({ file }));
    writeFileSync(file, readFileSync(file, 'utf8') + 'Edited café 世界\\r\\n');
  `
    );
    const result = await editTextExternally('Original\\literal\r\n', new AbortController().signal);
    assert.equal(result, 'Original\\literal\r\nEdited café 世界\r\n');
    const { file } = await readStarted(marker, t.signal);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
);

test(
  'cancelling an uncooperative editor waits for its actual exit before restoring terminal ownership',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const marker = await editor(
      t,
      `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    writeFileSync(MARKER, JSON.stringify({ pid: process.pid, file: process.argv[2] }));
    setInterval(() => {}, 100);
  `
    );
    const controller = new AbortController();
    const completion = editTextExternally('Unsent draft.', controller.signal);
    const rejection = assert.rejects(completion, (error) => error.name === 'AbortError');
    const { pid, file } = await readStarted(marker, t.signal);
    t.after(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });
    controller.abort();
    await rejection;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
);

test(
  'a failed editor exit removes temporary files without accepting changed text',
  { timeout: 10000 },
  async (t) => {
    const marker = await editor(
      t,
      `
    import { writeFileSync } from 'node:fs';
    writeFileSync(MARKER, JSON.stringify({ file: process.argv[2] }));
    writeFileSync(process.argv[2], 'Unaccepted changes');
    process.exitCode = 7;
  `
    );
    await assert.rejects(
      editTextExternally('Original draft.', new AbortController().signal),
      /Editor exited with 7/
    );
    const { file } = await readStarted(marker, t.signal);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
);

test(
  'an already cancelled edit never launches the configured editor',
  { timeout: 10000 },
  async (t) => {
    const marker = await editor(
      t,
      `import { writeFileSync } from 'node:fs'; writeFileSync(MARKER, '{}');`
    );
    const controller = new AbortController();
    const reason = new Error('Cancelled before terminal handoff.');
    controller.abort(reason);
    await assert.rejects(
      editTextExternally('Original draft.', controller.signal),
      (error) => error === reason
    );
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
);
