import assert from 'node:assert/strict';
import test from 'node:test';
import { responsiveStatusline, defaultTuiPreferences, updateActivityClock } from '@agent-core/tui';
import { terminalTextWidth } from '@ismail-elkorchi/terminal-ui/text';

test('responsive status preserves authority and activity before lower-priority fields', () => {
  for (const width of [48, 80, 120]) {
    const output = responsiveStatusline('Coding', defaultTuiPreferences, [
      { id: 'model', value: 'openai-codex/gpt-6.1-sol', compactValue: 'gpt-6.1-sol' },
      { id: 'reasoning', value: 'xhigh' }, { id: 'mode', value: 'Full host' },
      { id: 'status', value: 'Requesting response' }
    ], width);
    assert.ok(terminalTextWidth(output) <= width);
    assert.match(output, /Full host/);
    assert.match(output, /Requesting response/);
    if (width >= 80) assert.match(output, /gpt-6.1-sol/);
  }
});

test('display elapsed time spans progress phases and ends with the run', () => {
  const started = updateActivityClock(undefined, true, 2000);
  assert.deepEqual(updateActivityClock(started, true, 4000), { startedAt: 2000, now: 4000 });
  assert.equal(updateActivityClock(started, false, 6000), undefined);
});
