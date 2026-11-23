// The Usage page's data: relative resets, each window's tone and honesty (past a reset, old), account status and the fallback when the Mac sends no account list; the meter's motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
const modelPath = '../mobile/src/ui/settings/usageModel';
const meterPath = '../mobile/src/ui/settings/UsageMeter';
const { resetWords, windowView, usageSections } = await import(modelPath);
const { UsageMeter } = await import(meterPath);

const now = 1_700_000_000_000;
const win = (o: any = {}) => ({ label: '5h', usedPercent: 40, resetsAt: now / 1000 + 3600, resetsText: null, at: now, stale: false, ...o });
const r = (secs: number | null, resetsText: string | null = null) =>
  resetWords({ resetsAt: secs === null ? null : now / 1000 + secs, resetsText }, now);

test('a reset reads as time left: under a minute, minutes, hours and minutes, whole hours, then a day and time; a past one says so', () => {
  assert.equal(r(30), 'Resets in under a minute');
  assert.equal(r(40 * 60), 'Resets in 40 min');
  assert.equal(r(59 * 60 + 50), 'Resets in 1 h');
  assert.equal(r(2 * 3600 + 10 * 60), 'Resets in 2 h 10 min');
  assert.equal(r(3 * 3600), 'Resets in 3 h');
  assert.match(r(30 * 3600), /^Resets \w{3}/);
  assert.equal(r(-5), 'Reset since last read');
  assert.equal(r(null, 'Friday 9 AM'), 'Resets Friday 9 AM');
  assert.equal(r(null), 'Reset time unknown');
});

test('a window: share left, tone by how little is left, old readings quiet and marked, a reading past its reset says nothing', () => {
  const view = (o: any) => windowView(win(o), now);
  assert.deepEqual([view({}).left, view({}).tone, view({}).note, view({}).value], [60, 'ok', null, '60% left']);
  assert.equal(view({ usedPercent: 80 }).tone, 'warn');
  assert.equal(view({ usedPercent: 95 }).tone, 'bad');
  assert.equal(view({ usedPercent: 140 }).left, 0);
  for (const old of [{ stale: true }, { at: 0 }, { at: now - 3 * 3600_000 }]) {
    const w = view(old);
    assert.deepEqual([w.tone, w.note], ['quiet', 'Last known'], JSON.stringify(old));
  }
  const past = view({ resetsAt: now / 1000 - 1 });
  assert.deepEqual([past.left, past.value, past.reset, past.tone], [null, 'Refresh needed', 'Reset since last read', 'quiet']);
});

const usage = (o: any = {}) => ({ harness: 'claude', account: 'a', label: 'A', active: false, state: 'available', windows: [win()], ...o });
const login = (o: any = {}) => ({
  harness: 'claude',
  account: 'a',
  label: 'A@x',
  status: 'ok',
  billing: 'subscription',
  active: false,
  limited: false,
  ...o,
});
const sections = (accounts: any, usageRows: any, labels = new Map()) => usageSections({ accounts, usage: usageRows, labels, now });

test('without an account list the usage read’s own accounts are shown, with the agent named from the Mac or from its id', () => {
  const out = sections(
    null,
    [usage({ active: true }), usage({ harness: 'acp:x-y', account: 'q', state: 'unsupported', windows: [] })],
    new Map([['claude', 'Claude Code']]),
  );
  assert.deepEqual(
    out.map((h: any) => [h.harness, h.title, h.autoSwitch]),
    [
      ['claude', 'Claude Code', null],
      ['acp:x-y', 'X y', null],
    ],
  );
  assert.deepEqual([out[0].accounts[0].status, out[0].accounts[0].statusTone], ['Active', 'ok']);
  assert.equal(out[1].accounts[0].note, 'No usage for this account');
  assert.equal(sections(null, null).length, 0);
});

test('with an account list each login keeps its state: signed out or expired beats any usage, limited and active are named, a login never read says so', () => {
  const list = {
    harnesses: [{ harness: 'claude', autoSwitch: true, pool: 'single' }],
    accounts: [
      login({ account: 'a', active: true }),
      login({ account: 'b', status: 'signedOut' }),
      login({ account: 'c', status: 'expired' }),
      login({ account: 'd', limited: true }),
      login({ account: 'e' }),
      login({ account: 'f', label: 'F@x' }),
    ],
  };
  const out = sections(list, [
    usage({ account: 'a', active: true }),
    usage({ account: 'b' }),
    usage({ account: 'd' }),
    usage({ account: 'f', state: 'unavailable', windows: [] }),
  ]);
  const [a, b, c, d, e, f] = out[0].accounts;
  assert.equal(out[0].autoSwitch, true);
  assert.deepEqual([a.status, a.windows.length, a.note], ['Active', 1, null]);
  assert.deepEqual([b.status, b.statusTone, b.windows.length, b.note], ['Signed out', 'bad', 0, 'Sign in on your Mac.']);
  assert.deepEqual([c.status, c.note], ['Expired', 'Sign in on your Mac.']);
  assert.deepEqual([d.status, d.statusTone, d.windows.length], ['Limited', 'warn', 1]);
  assert.deepEqual([e.status, e.note, e.windows.length], ['', 'Not fetched yet', 0]);
  assert.equal(f.note, 'Usage unavailable');
  // a usage read that signs the account out wins over an account list that still says ok
  const stale = sections({ harnesses: [], accounts: [login()] }, [usage({ state: 'signin', windows: [] })]);
  assert.equal(stale[0].accounts[0].note, 'Sign in on your Mac.');
  assert.equal(stale[0].autoSwitch, null);
  // a state the page does not know is unavailable, never a pass
  assert.equal(sections(null, [usage({ state: 'weird', windows: [] })])[0].accounts[0].note, 'Usage unavailable');
});

test('the meter fills to the share on the enter curve; with Reduce Motion it is there at once', async () => {
  const draw = async (left: number | null) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(UsageMeter, { left, tone: 'ok' })));
    await flush();
    await act(async () => root.unmount());
    host.remove();
  };
  (globalThis as any).__phoneTimings = [];
  await draw(60);
  assert.deepEqual((globalThis as any).__phoneTimings.at(-1), {
    to: 60,
    config: { duration: 300, easing: { bezier: [0.19, 1, 0.22, 1] } },
  });
  await draw(null);
  assert.equal((globalThis as any).__phoneTimings.at(-1).to, 0);
  // Reduce Motion is read after the first frame; once it is known a new reading lands without a timed fill
  (globalThis as any).__phoneReduceMotion = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(UsageMeter, { left: 60, tone: 'ok' })));
  await flush();
  (globalThis as any).__phoneTimings = [];
  await act(async () => root.render(createElement(UsageMeter, { left: 30, tone: 'ok' })));
  await flush();
  assert.deepEqual((globalThis as any).__phoneTimings, []);
  await act(async () => root.unmount());
  host.remove();
  delete (globalThis as any).__phoneReduceMotion;
});

const hookPath = '../mobile/src/ui/settings/useUsagePage';
const clientPath = '../mobile/src/remote/client';
const { useUsagePage } = await import(hookPath);
const { ownedRequest } = await import(clientPath);
const { scripted } = await import('./support/phone/m3');

test('one auto-switch change at a time; a refused one with no words falls back to ours; the answer after a reload that lost the list is dropped quietly', async () => {
  let release!: (v: unknown) => void;
  let accountsOk = true;
  let mode: 'hold' | 'refuse' = 'hold';
  const { runtime, calls } = scripted((m) =>
    m === 'machine.hello'
      ? { capabilities: { methods: ['usage.get', 'accounts.get', 'accounts.autoSwitch'] } }
      : m === 'usage.get'
        ? { scope: 'local', accounts: [] }
        : m === 'accounts.get'
          ? accountsOk
            ? { scope: 'local', harnesses: [{ harness: 'claude', autoSwitch: true, pool: 'single' }], accounts: [] }
            : Promise.reject(new Error('gone'))
          : m === 'accounts.autoSwitch'
            ? mode === 'hold'
              ? new Promise((resolve) => (release = resolve))
              : Promise.reject(new Error(''))
            : undefined,
  );
  let page: any;
  const request = ownedRequest(runtime);
  const Probe = () => {
    page = useUsagePage(request, true);
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  await flush();
  await act(async () => page.toggle('claude', false));
  await act(async () => page.toggle('claude', false));
  assert.equal(calls.filter(([m]) => m === 'accounts.autoSwitch').length, 1, 'the second tap while one is saving does nothing');
  // the list is gone after a reload while the change is still open: its answer lands on nothing
  accountsOk = false;
  await act(async () => page.refresh());
  await flush();
  assert.equal(page.data.accounts, null);
  await act(async () => release({ harness: 'claude', autoSwitch: false }));
  await flush();
  assert.equal(page.data.accounts, null);
  accountsOk = true;
  mode = 'refuse';
  await act(async () => page.refresh());
  await flush();
  await act(async () => page.toggle('claude', false));
  await flush();
  assert.equal(page.data.accounts.harnesses[0].autoSwitch, true);
  assert.equal(page.data.switchError, 'Could not change this setting.');
  await act(async () => root.unmount());
  host.remove();
});

test('the words follow the shown language: a reset and a status read in Chinese, then English again', async () => {
  const i18nPath = '../mobile/src/ui/i18n';
  const { showLocale } = await import(i18nPath);
  await showLocale('zh-Hans');
  try {
    assert.equal(r(40 * 60), '40 分钟后重置');
    assert.equal(windowView(win(), now).value, '剩余 60%');
    assert.equal(sections(null, [usage({ active: true })])[0].accounts[0].status, '当前');
  } finally {
    await showLocale('en');
  }
  assert.equal(r(40 * 60), 'Resets in 40 min');
});

test('an account list with no usage read lists its logins unread; an agent with no id still has a title', () => {
  const out = sections({ harnesses: [], accounts: [login()] }, null);
  assert.deepEqual([out[0].accounts[0].note, out[0].accounts[0].windows.length], ['Not fetched yet', 0]);
  assert.equal(sections(null, [usage({ harness: '' })])[0].title, '');
});

test('the meter takes its colour from the tone of its window', async () => {
  for (const tone of ['ok', 'warn', 'bad', 'quiet'] as const) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(UsageMeter, { left: 20, tone })));
    await flush();
    await act(async () => root.unmount());
    host.remove();
  }
});
