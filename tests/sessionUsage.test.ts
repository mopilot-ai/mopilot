// src/components/thread/SessionUsage.tsx: a live session card's working time (main's, ticking while a turn runs) and
// tokens (only when this window has the session's own usage), and the files it edited outside its declared paths.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const store = fakeStore<any>({ runtime: {}, segments: {} });
stubStore({ useStore: store.useStore });
const { SessionUsage, workedMs, usageLine, outsideLine } = await import('../src/components/thread/SessionUsage.tsx');
const { contextUsageKey } = await import('../src/store/contextUsage.ts');

const child = (over: any = {}) => ({
  parentId: 'top',
  name: 'kid',
  title: 'Kid',
  harness: 'codex',
  useWorktree: false,
  createdAt: 1,
  lastReport: null,
  ...over,
});

test('working time is the ended turns’ and the running one’s so far; none before a first turn', () => {
  assert.equal(workedMs(null, 10), null);
  assert.equal(workedMs(undefined, 10), null);
  assert.equal(workedMs({ ms: 5000, turns: 1, since: null }, 99_999), 5000);
  assert.equal(workedMs({ ms: 5000, turns: 1, since: 10_000 }, 12_500), 7500);
  // a clock behind main's adds nothing
  assert.equal(workedMs({ ms: 5000, turns: 1, since: 10_000 }, 9000), 5000);
});

test('the line says what is known: time from a second, tokens when counted', () => {
  assert.equal(usageLine(null, null), '');
  assert.equal(usageLine(400, 0), '');
  assert.equal(usageLine(252_000, 12_400), '4m 12s · 12k tokens');
  assert.equal(usageLine(252_000, null), '4m 12s');
  assert.equal(usageLine(null, 840), '840 tokens');
  assert.equal(usageLine(3_000, 1_250), '3s · 1.3k tokens');
});

test('the warning names the first files outside its paths and counts the rest', () => {
  assert.equal(outsideLine(null), null);
  assert.equal(outsideLine([]), null);
  assert.equal(outsideLine(['a.ts', 'b.ts']), 'Edited outside its paths: a.ts, b.ts');
  assert.equal(outsideLine(['a', 'b', 'c', 'd', 'e']), 'Edited outside its paths: a, b, c and 2 more');
});

test('the card shows time and the chat’s own tokens when known, nothing when it knows neither, and the warning', async () => {
  const empty = await render(h(SessionUsage, { chatId: 'kid', linked: undefined }));
  assert.equal(empty.host.textContent, '');
  await empty.unmount();
  // tokens reported for the chat's current session
  store.setState({
    runtime: { kid: { tokenUsage: { total: { totalTokens: 12_400 } }, tokenUsageOwner: contextUsageKey(undefined, 'kid') } },
  });
  const known = await render(h(SessionUsage, { chatId: 'kid', linked: child({ worked: { ms: 250_000, turns: 2, since: null } }) }));
  assert.equal(known.host.querySelector('.session-card-usage')?.textContent, '4m 10s · 12k tokens');
  assert.equal(known.host.querySelector('.session-card-outside'), null);
  await known.unmount();
  // a count from a session the chat has replaced since is not its own
  store.setState({ runtime: { kid: { tokenUsage: { total: { totalTokens: 12_400 } }, tokenUsageOwner: 'an older session' } } });
  const stale = await render(
    h(SessionUsage, {
      chatId: 'kid',
      linked: child({ worked: { ms: 61_000, turns: 1, since: null }, paths: ['src/api/**'], outside: ['src/web/x.ts'] }),
    }),
  );
  assert.equal(stale.host.querySelector('.session-card-usage')?.textContent, '1m 1s');
  const warn = stale.host.querySelector('.session-card-outside') as HTMLElement;
  assert.equal(warn.textContent, 'Edited outside its paths: src/web/x.ts');
  assert.equal(warn.title, 'Declared paths: src/api/**');
  await stale.unmount();
  // a warning with no paths on record still says so
  const bare = await render(h(SessionUsage, { chatId: 'none', linked: child({ outside: ['x'] }) }));
  assert.equal((bare.host.querySelector('.session-card-outside') as HTMLElement).title, 'Declared paths: ');
  await bare.unmount();
});

test('while a turn runs its time ticks', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100_000 });
  try {
    store.setState({ runtime: {} });
    const v = await render(h(SessionUsage, { chatId: 'kid', linked: child({ worked: { ms: 0, turns: 0, since: 90_000 } }) }));
    assert.equal(v.host.textContent, '10s');
    await act(async () => mock.timers.tick(5000));
    assert.equal(v.host.textContent, '15s');
    await v.unmount();
  } finally {
    mock.timers.reset();
  }
});
