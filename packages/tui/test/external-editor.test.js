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

test(
  'cancellation owns a waiting wrapper and its uncooperative editor descendant',
  { timeout: 10000 },
  async (t) => {
    const marker = await editor(t, `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['--input-type=module', '-e', \`
        import { writeFileSync } from 'node:fs';
        process.on('SIGTERM', () => {});
        writeFileSync(\${JSON.stringify(MARKER)}, JSON.stringify({
          pid: process.pid, wrapper: process.ppid, file: process.argv[1]
        }));
        setInterval(() => {}, 100);
      \`, process.argv[2]], { stdio: 'inherit' });
      child.on('exit', (code) => { process.exitCode = code ?? 1; });
    `);
    const controller = new AbortController();
    let terminalRestored = false;
    const completion = editTextExternally('Keep until editor exit.', controller.signal)
      .finally(() => { terminalRestored = true; });
    const rejection = assert.rejects(completion, (error) => error.name === 'AbortError');
    const { pid, wrapper, file } = await readStarted(marker, t.signal);
    t.after(() => {
      for (const id of [pid, wrapper]) {
        try { process.kill(id, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    controller.abort();
    if (process.platform !== 'win32') {
      await delay(100);
      assert.equal(terminalRestored, false, 'terminal remains suspended while descendant survives SIGTERM');
      assert.equal(await readFile(file, 'utf8'), 'Keep until editor exit.');
      process.kill(pid, 0);
    }
    await rejection;
    assert.equal(terminalRestored, true);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    if (process.platform === 'win32') {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      return;
    }
    // An orphan zombie has no live terminal or draft handles; some test
    // containers do not reap those immediately.
    const { execFileSync } = await import('node:child_process');
    const processes = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'stat='], { encoding: 'utf8' });
    const row = processes.split('\n').find((line) => Number(line.trim().split(/\s+/)[0]) === pid);
    assert.ok(!row || /^\d+\s+Z/.test(row.trim()), 'descendant is no longer live');
  }
);

test(
  'external editor can read the real controlling terminal in its foreground group',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const { execFileSync, execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try { execFileSync('python3', ['-c', 'import pty']); }
    catch { t.skip('PTY fixture requires Python 3 with pty'); return; }
    const directory = await mkdtemp(path.join(tmpdir(), 'editor-pty-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const editorScript = path.join(directory, 'editor.py');
    const main = path.join(directory, 'main.mjs');
    await writeFile(editorScript, `
import os, sys
assert os.isatty(0)
assert os.tcgetpgrp(0) == os.getpgrp(), 'editor lost foreground process group'
with open('/dev/tty', 'r') as terminal:
    print('EDITOR_READY', flush=True)
    text = terminal.readline()
with open(sys.argv[1], 'w') as draft:
    draft.write(text)
`);
    await writeFile(main, `
      import assert from 'node:assert/strict';
      import { editTextExternally } from ${JSON.stringify(import.meta.resolve('@agent-core/tui/node'))};
      process.env.VISUAL = ${JSON.stringify(`python3 '${editorScript}'`)};
      const edited = await editTextExternally('original', new AbortController().signal);
      assert.equal(edited, 'typed into editor\\n');
      console.log('EDITOR_FINISHED');
    `);
    const driver = `
import os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2]])
output = b''
sent = False
try:
    deadline = time.monotonic() + 7
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
            if b'EDITOR_READY' in output and not sent:
                os.write(fd, b'typed into editor\\n')
                sent = True
        found, status = os.waitpid(pid, os.WNOHANG)
        if found:
            assert os.waitstatus_to_exitcode(status) == 0, output
            pid = None
            break
    assert b'EDITOR_FINISHED' in output, output
finally:
    os.close(fd)
    if pid:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
print(output.decode())
`;
    const { stdout } = await promisify(execFile)('python3', ['-c', driver, process.execPath, main]);
    assert.match(stdout, /EDITOR_FINISHED/);
  }
);

test(
  'failed tree discovery resumes the editor and retains ownership until its natural exit',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const { chmod } = await import('node:fs/promises');
    const { execFileSync } = await import('node:child_process');
    const actualPs = execFileSync('/bin/sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
    const directory = await mkdtemp(path.join(tmpdir(), 'editor-ps-failure-'));
    const failureMarker = path.join(directory, 'fail');
    const fakePs = path.join(directory, 'ps');
    const priorPath = process.env.PATH;
    await writeFile(fakePs, `#!/bin/sh\nif [ -f '${failureMarker}' ]; then exit 9; fi\nexec '${actualPs}' "$@"\n`);
    await chmod(fakePs, 0o700);
    process.env.PATH = `${directory}:${priorPath}`;
    t.after(async () => {
      process.env.PATH = priorPath;
      await rm(directory, { recursive: true, force: true });
    });
    const marker = await editor(t, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(MARKER, JSON.stringify({ file: process.argv[2] }));
      setTimeout(() => {}, 450);
    `);
    const controller = new AbortController();
    let settled = false;
    const completion = editTextExternally('Retain this draft.', controller.signal)
      .finally(() => { settled = true; });
    const rejected = assert.rejects(completion, /Command failed: ps/);
    const { file } = await readStarted(marker, t.signal);
    await writeFile(failureMarker, 'fail discovery');
    controller.abort();
    await delay(50);
    assert.equal(settled, false);
    assert.equal(await readFile(file, 'utf8'), 'Retain this draft.');
    await rejected;
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
);

for (const nested of [false, true]) {
  test(
    `cancellation owns cleanup children created during graceful shutdown${nested ? ' after their wrapper exits' : ''}`,
    { skip: process.platform === 'win32', timeout: 10000 },
    async (t) => {
      const source = `
        import { spawn } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        process.on('SIGTERM', () => {
          setTimeout(() => {
            const cleanup = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { stdio: 'inherit' });
            writeFileSync(MARKER + '.cleanup', JSON.stringify({ pid: cleanup.pid }));
            cleanup.on('exit', () => process.exit(0));
          }, ${nested ? 800 : 0});
        });
        writeFileSync(MARKER, JSON.stringify({ pid: process.pid, file: process.argv[1] }));
        setInterval(() => {}, 100);
      `;
      const marker = await editor(t, nested ? `
        import { spawn } from 'node:child_process';
        const child = spawn(process.execPath, ['--input-type=module', '-e', \`${source}\`, process.argv[2]], { stdio: 'inherit' });
        child.on('exit', (code) => { process.exitCode = code ?? 1; });
      ` : source.replace('process.argv[1]', 'process.argv[2]'));
      const controller = new AbortController();
      const completion = editTextExternally('Wait for cleanup.', controller.signal);
      const rejected = assert.rejects(completion, { name: 'AbortError' });
      const { pid, file } = await readStarted(marker, t.signal);
      let cleanupPid;
      t.after(() => {
        for (const id of [pid, cleanupPid]) {
          if (id === undefined) continue;
          try { process.kill(id, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      });
      controller.abort();
      cleanupPid = (await readStarted(marker + '.cleanup', t.signal)).pid;
      await rejected;
      const { execFileSync } = await import('node:child_process');
      const processes = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'stat='], { encoding: 'utf8' });
      for (const id of [pid, cleanupPid]) {
        const row = processes.split('\n').find((line) => Number(line.trim().split(/\s+/)[0]) === id);
        assert.ok(!row || /^\d+\s+Z/.test(row.trim()), 'shutdown-created descendant is no longer live');
      }
      await assert.rejects(readFile(file), { code: 'ENOENT' });
    }
  );
}
