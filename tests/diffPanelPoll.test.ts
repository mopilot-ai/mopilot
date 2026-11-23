// The Changes pane reads git every 5 s while its chat runs a turn and every 30 s while it runs none (src/lib/gitPoll.ts),
// as the summary does: idle, only an edit made outside the app changes what it shows, and each read spawns git.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { store, calls, act, settle, mount } from './support/diff-panel-ui/fixture.ts';
import { GIT_POLL_MS, GIT_IDLE_POLL_MS } from '../src/lib/gitPoll.ts';

const reads = () => calls.filter((c) => c[0] === 'diff' || (c[0] === 'git' && c[1] === 'diff')).length;
const tick = async (ms: number) => {
  await act(async () => mock.timers.tick(ms));
  await settle(act);
};

test('the Changes pane reads git every 30 s while no turn runs and every 5 s while one does', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const r = await mount({ open: true }, 't1', { t1: { turns: [] } });
  try {
    // idle: nothing at the turn's interval, one read at the slower one
    let before = reads();
    await tick(GIT_POLL_MS);
    assert.equal(reads(), before);
    await tick(GIT_IDLE_POLL_MS - GIT_POLL_MS);
    assert.ok(reads() > before, 'read at the idle interval');
    // a turn starts: a read at once, then one every 5 s
    await act(async () => store.set({ runtime: { t1: { turns: [], activeTurnId: 'T1' } } }));
    await settle(act);
    before = reads();
    await tick(GIT_POLL_MS);
    assert.ok(reads() > before, 'read at the running interval');
  } finally {
    await r.unmount();
    mock.timers.reset();
  }
});
