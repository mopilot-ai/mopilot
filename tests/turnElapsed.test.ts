// A turn header's duration (src/lib/turnElapsed.ts, #4926): a turn stopped with nothing measuring its end read "Stopped after 18h 33m", now minus its start, and kept growing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnElapsed } from '../src/lib/turnElapsed.ts';
import { formatDuration } from '../src/lib/format.ts';

const START = 1_700_000_000;
const NOW = (START + 18 * 3600 + 33 * 60) * 1000;

test('a stopped turn with no end measured has no duration, not the time since it began', () => {
  const stopped = { startedAt: START, status: 'interrupted' as const };
  assert.equal(turnElapsed(stopped, false, NOW, 0), null);
  // the old reading, for the record: what the owner saw
  assert.equal(formatDuration(NOW - START * 1000), '18h 33m');
});

test('a measured turn keeps its duration; a running one counts; an unmeasured finished one reads now', () => {
  assert.equal(turnElapsed({ startedAt: START, durationMs: 4000, status: 'interrupted' }, false, NOW, 0), 4000);
  assert.equal(turnElapsed({ startedAt: START, completedAt: START + 4, status: 'interrupted' }, false, NOW, 0), 4000);
  assert.equal(turnElapsed({ startedAt: START, status: 'inProgress' }, true, START * 1000 + 3000, 0), 3000);
  assert.equal(turnElapsed({ status: 'inProgress' }, true, 5000, 2000), 3000);
  assert.equal(turnElapsed({ status: 'inProgress' }, true, 1000, 2000), 0);
  assert.equal(turnElapsed({ startedAt: START, status: 'completed' }, false, (START + 9) * 1000, 0), 9000);
  assert.equal(turnElapsed({ status: 'completed' }, false, NOW, 0), null);
});
