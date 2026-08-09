import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';

test('the TUI is a standalone package below the CLI composition boundary', async () => {
  const cli = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));
  const tui = JSON.parse(await readFile(new URL('../packages/tui/package.json', import.meta.url), 'utf8'));

  assert.equal(cli.dependencies['@agent-core/tui'], '0.2.0');
  assert.equal(cli.dependencies['@ismail-elkorchi/terminal-ui'], undefined);
  assert.equal(cli.exports['./tui'], undefined);
  assert.equal(tui.dependencies['@agent-core/cli'], undefined);
  assert.equal(tui.dependencies['@ismail-elkorchi/terminal-ui'].startsWith('github:'), true);
  await assert.rejects(access(new URL('../packages/cli/src/tui/index.ts', import.meta.url)));

  const sourceDirectory = new URL('../packages/tui/src/', import.meta.url);
  for (const entry of await readdir(sourceDirectory)) {
    if (!entry.endsWith('.ts')) continue;
    const source = await readFile(new URL(entry, sourceDirectory), 'utf8');
    assert.doesNotMatch(source, /@agent-core\/cli|packages\/cli/u, entry);
  }
});
