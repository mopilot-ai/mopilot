// Computer History's memories, races and sidebar row (#1363, src/components/pages/settings/ComputerHistoryDays.tsx, src/components/sidebar/SidebarHistory.tsx, src/store/computerHistory.ts): retention, Show, Delete and Delete all, failed reads with Retry, newer state winning over late reads, and the sidebar's status row. The components are real; main is a fixture (tests/support/computer-history-ui.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import {
  f,
  act,
  base,
  on,
  reset,
  mount,
  flush,
  lastOf,
  SidebarHistory,
  dayLabel,
  refusalOf,
  statusDetail,
} from './support/computer-history-ui.ts';

test('memories: retention, Show reads a day, Delete and Delete all ask first and say what stays in chats', async () => {
  reset(on());
  const asked: string[] = [];
  let yes = false;
  (window as any).confirm = (m: string) => (asked.push(m), yes);
  const v = await mount();
  assert.ok(v.rows().includes('Keep memories for'));
  await v.pick(v.q('select.retention'), '7');
  assert.deepEqual(lastOf(), ['setRetention', 7]);
  const day = v.row('2026-10-17') ?? v.host.querySelector('.row[data-desc="2026-10-17"]');
  assert.ok(day);
  await v.click(v.button('Show', day));
  assert.match(v.q('.ch-day-text').textContent, /Notes · "Plan"/);
  assert.deepEqual(
    f.calls.find(([c]: string[]) => c === 'memories'),
    ['memories', { days: ['2026-10-17'] }],
  );
  await v.click(v.button('Hide', day));
  assert.equal(v.q('.ch-day-text'), null);
  await v.click(v.button('Show', day));
  await v.click(day.querySelector('button[aria-label^="Delete"]'));
  assert.match(String(asked.at(-1)), /stay in that chat's history/);
  assert.ok(!f.calls.some(([c]: string[]) => c === 'deleteDay'), 'declined: nothing deleted');
  yes = true;
  await v.click(day.querySelector('button[aria-label^="Delete"]'));
  assert.deepEqual(
    f.calls.filter(([c]: string[]) => c === 'deleteDay'),
    [['deleteDay', '2026-10-17']],
  );
  assert.equal(v.q('.ch-day-text'), null, 'the open day closes with it');
  assert.equal(v.host.querySelector('.row[data-desc="2026-10-17"]'), null);
  yes = false;
  await v.click(v.button('Delete all'));
  assert.match(String(asked.at(-1)), /Delete all Computer History memories on this Mac/);
  assert.ok(!f.calls.some(([c]: string[]) => c === 'deleteAll'));
  yes = true;
  await v.click(v.button('Delete all'));
  assert.deepEqual(lastOf(), ['deleteAll']);
  assert.ok(v.rows().includes('No memories yet'));
  assert.equal(v.button('Delete all'), undefined);
  await v.close();
});

test("memories: a day that can't be read or listed says so, with Retry", async () => {
  reset(on());
  f.memoriesAnswer = async () => ({ ok: false, error: 'locked keychain' });
  let fail = true;
  f.daysAnswer = async () => (fail ? { ok: false, error: 'EACCES' } : { ok: true, state: f.state, days: f.days });
  const v = await mount();
  assert.match(v.q('.config-warning').textContent, /Couldn't list the days: EACCES/);
  fail = false;
  await v.click(v.button('Retry'));
  assert.equal(v.q('.config-warning'), null);
  await v.click(v.button('Show', v.host.querySelector('.row[data-desc="2026-10-18"]')));
  assert.match(v.q('.config-warning').textContent, /locked keychain/);
  f.memoriesAnswer = async () => {
    throw new Error('gone');
  };
  await v.click(v.button('Hide'));
  await v.click(v.button('Show', v.host.querySelector('.row[data-desc="2026-10-18"]')));
  assert.match(v.q('.config-warning').textContent, /gone/);
  f.memoriesAnswer = async (q: any) => ({ ok: true, state: f.state, text: '', memories: [], block: null, unreadable: 0, q });
  await v.click(v.button('Hide'));
  await v.click(v.button('Show', v.host.querySelector('.row[data-desc="2026-10-18"]')));
  assert.equal(v.q('.ch-day-text').textContent, 'Nothing recorded this day.');
  f.daysAnswer = async () => {
    throw new Error('IPC down');
  };
  await act(async () => f.broadcast({ ...f.state }));
  await flush();
  assert.match(v.q('.config-warning[role="alert"]').textContent, /IPC down/);
  await v.close();
});

test("a state that can't be read says so with Retry; unreadable saved settings say Computer History is off", async () => {
  reset();
  let mode = 'refuse';
  f.stateAnswer = async () => {
    if (mode === 'refuse') return { ok: false, error: 'Computer History has not started yet' };
    if (mode === 'throw') throw new Error('no bridge');
    return {
      ok: true,
      state: { ...base(), settingsError: 'The saved Computer History settings could not be read, so it is off.' },
      exclusions: null,
    };
  };
  const v = await mount();
  assert.match(v.q('.config-warning').textContent, /has not started yet/);
  mode = 'throw';
  await v.click(v.button('Retry'));
  assert.match(v.q('.config-warning').textContent, /no bridge/);
  mode = 'ok';
  await v.click(v.button('Retry'));
  assert.match(v.q('.config-warning').textContent, /could not be read, so it is off/);
  assert.equal(v.row('Apps').getAttribute('data-desc'), '', 'no exclusions read: an empty list, not a crash');
  await v.close();
});

test('a broadcast is newer than a read still on its way: the read that lands later is ignored', async () => {
  reset(on());
  let release: (v: unknown) => void = () => undefined;
  f.stateAnswer = () => new Promise((r) => (release = r));
  const v = await mount();
  await act(async () => f.broadcast(on({ status: 'paused' })));
  await flush();
  await act(async () => release({ ok: true, state: on({ status: 'recording' }), exclusions: { apps: [], healthSites: [] } }));
  await flush();
  assert.equal(v.q('.status-pill[data-status]').textContent, 'Paused');
  await v.close();
});

test('the sidebar row: nothing while off, the status while on, and it opens Computer History', async () => {
  reset();
  const off = await mount(SidebarHistory);
  assert.equal(off.q('.sidebar-history'), null);
  await act(async () => f.broadcast(on({ status: 'paused' })));
  await flush();
  assert.equal(off.q('.sidebar-history').getAttribute('aria-label'), 'Computer History · Paused');
  await off.click(off.q('.sidebar-history'));
  assert.deepEqual(f.nav.at(-1), { name: 'settings', section: 'computer-history' });
  await off.close();
  reset(on());
  const v = await mount(SidebarHistory);
  assert.equal(v.q('.sidebar-history').dataset.status, 'recording');
  await act(async () => f.broadcast(on({ status: 'unavailable' })));
  await flush();
  assert.equal(v.q('.sidebar-history').getAttribute('aria-label'), 'Computer History · Waiting', 'short enough for the sidebar');
  await v.close();
  reset(on());
  let release: (v: unknown) => void = () => undefined;
  f.stateAnswer = () => new Promise((r) => (release = r));
  const late = await mount(SidebarHistory);
  await act(async () => f.broadcast(on({ status: 'needs-permission' })));
  await act(async () => release({ ok: true, state: on({ status: 'recording' }) }));
  await flush();
  assert.equal(late.q('.sidebar-history').dataset.status, 'needs-permission', 'a late read never undoes a broadcast');
  await late.close();
  release({ ok: true, state: on() });
  f.stateAnswer = async () => {
    throw new Error('no bridge');
  };
  const broken = await mount(SidebarHistory);
  assert.equal(broken.q('.sidebar-history'), null);
  await broken.close();
});

test('the words: day labels and refusals', () => {
  const now = new Date(2026, 9, 18, 12);
  assert.equal(dayLabel('2026-10-18', now), 'Today');
  assert.equal(dayLabel('2026-10-17', now), 'Yesterday');
  assert.match(dayLabel('2026-10-10', now), /Oct/);
  assert.match(dayLabel('2025-10-10', now), /2025/);
  assert.equal(refusalOf({ ok: true, state: base() as any }), null);
  assert.equal(refusalOf({ ok: false, reason: 'No' }), 'No');
  assert.equal(refusalOf({ ok: false, error: 'Broke' }), 'Broke');
  assert.equal(refusalOf({ ok: false }), 'It did not go through');
});

test('races: a site typed while the last one is added stays; a late days read loses; a day closed before it is read stays closed', async () => {
  reset(on({ settings: { ...on().settings, apps: [{ bundleId: 'mopilot:built-in-browser', name: 'Built-in browser' }] } }));
  const v = await mount();
  assert.equal(v.row('Built-in browser').getAttribute('data-desc'), 'MoPilot');
  const input = v.q('input[aria-label="Site to add"]');
  const type = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await flush();
  };
  let release: () => void = () => undefined;
  const allow = f.native.computerHistory.allowSite;
  f.native.computerHistory.allowSite = (site: string) => new Promise((r) => (release = () => r(allow(site))));
  await type('a.example');
  await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await type('b.example');
  await act(async () => release());
  await flush();
  assert.equal(input.value, 'b.example', 'what was typed meanwhile is kept');
  f.native.computerHistory.allowSite = allow;
  // two days reads in flight: the older one landing last is ignored
  const answers: ((v: unknown) => void)[] = [];
  f.daysAnswer = () => new Promise((r) => answers.push(r));
  await act(async () => f.broadcast({ ...f.state }));
  await act(async () => f.broadcast({ ...f.state }));
  await act(async () => answers[1]({ ok: true, state: f.state, days: ['2026-10-18'] }));
  await act(async () => answers[0]({ ok: true, state: f.state, days: ['2026-10-01', '2026-10-18'] }));
  await flush();
  assert.equal(v.host.querySelector('.row[data-desc="2026-10-01"]'), null);
  assert.ok(v.host.querySelector('.row[data-desc="2026-10-18"]'));
  // a day opened and closed before its memories came back stays closed
  let memories: (v: unknown) => void = () => undefined;
  f.memoriesAnswer = () => new Promise((r) => (memories = r));
  await v.click(v.button('Show', v.host.querySelector('.row[data-desc="2026-10-18"]')));
  await v.click(v.button('Hide'));
  await act(async () => memories({ ok: true, state: f.state, text: 'late', memories: [], block: null, unreadable: 0 }));
  await flush();
  assert.equal(v.q('.ch-day-text'), null);
  await v.close();
});

test('the status row says the failure only while it is the status: a paused or stopped recorder never shows an old error', () => {
  const st = (status: string) => ({ ...base(), status, error: "Computer History can't reach MoPilot Computer Use right now." }) as any;
  assert.equal(statusDetail(st('recording')), 'Recording the apps and sites below.');
  assert.equal(statusDetail(st('paused')), 'Nothing is recorded until you resume.');
  assert.match(String(statusDetail(st('suspended'))), /unlocked or awake/);
  assert.equal(statusDetail({ ...st('suspended'), suspended: ['quit'] }), 'Stopped while MoPilot quits.');
  for (const s of ['needs-permission', 'unavailable', 'store-unavailable']) assert.match(String(statusDetail(st(s))), /can't reach/);
  assert.equal(statusDetail({ ...st('unavailable'), error: null }), undefined);
  assert.equal(statusDetail(st('off')), undefined);
});
