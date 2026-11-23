// Settings → About → Diagnostics → Request log (src/components/pages/settings/RequestLog.tsx), its wording
// (src/lib/requestLog.ts) and the failed-turn banner's link to it (src/components/thread/view/RequestLogLink.tsx). The
// Privacy switch that turns the ledger off is tested with the rest of Privacy (tests/page-settings-accounts.test.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  responses,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  flush,
  act,
  setValue,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');
const { RequestLog } = await import('../src/components/pages/settings/RequestLog.tsx');
const { RequestLogLink } = await import('../src/components/thread/view/RequestLogLink.tsx');
const rl = await import('../src/lib/requestLog.ts');

const T = '2026-10-17T10:00:05.000Z';
const lines = [
  {
    v: 1,
    t: T,
    chat: 'c1',
    harness: 'claude',
    account: { id: 'default', email: 'me@example.com', verified: false },
    req: 'claude-sonnet-5-5',
    served: 'claude-sonnet-5-5',
    outcome: 'error',
    code: 'rate_limit',
    error: "You've hit your weekly limit",
  },
  {
    v: 1,
    t: '2026-10-17T09:00:00.000Z',
    chat: 'c2',
    harness: 'codex',
    account: { id: 'k' },
    req: 'gpt-5',
    in: 1200,
    out: 30,
    cacheRead: 5000,
    outcome: 'ok',
  },
  {
    v: 1,
    t: '2026-10-17T09:00:00.000Z',
    chat: 'c2',
    harness: 'codex',
    account: { id: 'k' },
    req: 'gpt-5',
    in: 1200,
    out: 30,
    cacheRead: 5000,
    outcome: 'ok',
  },
];
const reads = () => calls.filter((c) => c[0] === 'ledger.recent').map((c) => c[1]);
const settings = (route: any) => {
  useStore.setState({ route });
  return render(h(Settings, { section: 'about' }));
};

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  responses['ledger.recent'] = lines;
});

test('About keeps the request log folded until opened, and opens it when a link names it', async () => {
  const folded = await settings({ name: 'settings', section: 'about' });
  const host = folded.host;
  assert.equal(host.querySelector('[data-testid=request-log]'), null);
  await click(host.querySelector('[data-testid=request-log-toggle]')!);
  await flush();
  assert.ok(host.querySelector('[data-testid=request-log]'));
  await click(host.querySelector('[data-testid=request-log-toggle]')!);
  assert.equal(host.querySelector('[data-testid=request-log]'), null);
  await folded.unmount();
  const opened = await settings({ name: 'settings', section: 'about', tab: 'request-log' });
  await flush();
  assert.ok(opened.host.querySelector('[data-testid=request-log]'));
  assert.match(text(button(opened.host, 'Copy diagnostics').closest('.settings-row') ?? opened.host), /request log/);
  await opened.unmount();
});

test('the folded log follows the route: none outside Settings, a link with a turn opens it marked', async () => {
  const { RequestLogAdvanced } = await import('../src/components/pages/settings/RequestLog.tsx');
  useStore.setState({ route: { name: 'thread', id: 'c1' } });
  const away = await render(h(RequestLogAdvanced));
  assert.equal(away.host.querySelector('[data-testid=request-log]'), null);
  await away.unmount();
  useStore.setState({
    route: { name: 'settings', section: 'about', tab: 'request-log', ledger: { chat: 'c1', from: Date.parse(T), to: null } },
  });
  const linked = await render(h(RequestLogAdvanced));
  await flush();
  assert.deepEqual(reads().at(-1), { limit: 200, chat: 'c1' });
  assert.ok(linked.host.querySelector('[data-testid=request-log-line].marked'));
  await linked.unmount();
});

test('the log lists each line with its account, model, tokens, outcome and error; a line copies as JSON', async () => {
  const { host } = await render(h(RequestLog, { focus: null }));
  await flush();
  assert.deepEqual(reads(), [{ limit: 200 }]);
  const rows = [...host.querySelectorAll('[data-testid=request-log-line]')].map((r) =>
    [...r.querySelectorAll('td')].slice(1, 6).map((td) => text(td)),
  );
  assert.deepEqual(rows, [
    ['Error · rate_limit', 'claude', 'me@example.com (unconfirmed)', 'claude-sonnet-5-5', '—'],
    ['OK', 'codex', 'k', 'gpt-5', 'in 1.2k · cache 5.0k/0 · out 30'],
    ['OK', 'codex', 'k', 'gpt-5', 'in 1.2k · cache 5.0k/0 · out 30'],
  ]);
  assert.equal(text(host.querySelector('.request-log-error')), "You've hit your weekly limit");
  await click(host.querySelectorAll('[data-testid=request-log-line] button')[0]);
  await flush();
  assert.deepEqual(
    calls.find((c) => c[0] === 'clipboard.write'),
    ['clipboard.write', JSON.stringify(lines[0])],
  );
});

test('filters ask main again with only the fields picked; Refresh reads again; an empty answer says so', async () => {
  const { host } = await render(h(RequestLog, { focus: null }));
  await flush();
  const pick = async (label: string, value: string) => {
    const sel = host.querySelector(`select[aria-label=${label}]`) as HTMLSelectElement;
    assert.ok(
      [...sel.options].some((o) => o.value === value),
      `${label} offers ${value}`,
    );
    await act(() => setValue(sel, value, 'change'));
    await flush();
  };
  responses['ledger.recent'] = [];
  await pick('Harness', 'codex');
  await pick('Account', 'me@example.com');
  await pick('Outcome', 'error');
  assert.deepEqual(reads().at(-1), { limit: 200, harness: 'codex', account: 'me@example.com', outcome: 'error' });
  assert.equal(text(host.querySelector('[data-testid=request-log-empty]')), 'No requests recorded that match.');
  // the choices stay those seen before the filter narrowed the lines
  assert.equal((host.querySelector('select[aria-label=Harness]') as HTMLSelectElement).options.length, 3);
  const n = reads().length;
  await click(button(host, 'Refresh'));
  await flush();
  assert.equal(reads().length, n + 1);
  // with no filter and nothing recorded
  const { host: fresh } = await render(h(RequestLog, { focus: null }));
  await flush();
  assert.equal(text(fresh.querySelector('[data-testid=request-log-empty]')), 'No requests recorded yet.');
  // the Outcome choices read as the log words them
  assert.deepEqual(
    [...(host.querySelector('select[aria-label=Outcome]') as HTMLSelectElement).options].map((o) => o.textContent),
    ['All', 'OK', 'Retried', 'Error', 'Stopped'],
  );
});

test("a read that fails says so; only the newest read's answer lands", async () => {
  responses['ledger.recent'] = () => Promise.reject(new Error('denied'));
  const { host } = await render(h(RequestLog, { focus: null }));
  await flush();
  assert.equal(text(host.querySelector('[role=alert]')), "Couldn't read the request log: denied");
  let release: (v: any) => void = () => {};
  responses['ledger.recent'] = () => new Promise((r) => (release = r));
  await click(button(host, 'Refresh'));
  const slow = release;
  responses['ledger.recent'] = [lines[1]];
  await click(button(host, 'Refresh'));
  await flush();
  slow(lines);
  await flush();
  assert.equal(host.querySelectorAll('[data-testid=request-log-line]').length, 1);
  responses['ledger.recent'] = () => new Promise((_r, reject) => (release = reject));
  await click(button(host, 'Refresh'));
  const late = release;
  responses['ledger.recent'] = [lines[1]];
  await click(button(host, 'Refresh'));
  await flush();
  late(new Error('too late'));
  await flush();
  assert.equal(host.querySelector('[role=alert]'), null);
});

test('Reveal folder opens it, and says why when it cannot', async () => {
  const { host } = await render(h(RequestLog, { focus: null }));
  await flush();
  responses['ledger.reveal'] = { ok: true };
  await click(button(host, 'Reveal folder'));
  await flush();
  responses['ledger.reveal'] = { ok: false, error: 'no Finder' };
  await click(button(host, 'Reveal folder'));
  await flush();
  responses['ledger.reveal'] = { ok: false };
  await click(button(host, 'Reveal folder'));
  await flush();
  responses['ledger.reveal'] = () => Promise.reject(new Error('gone'));
  await click(button(host, 'Reveal folder'));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'toast').map((c) => c[1]),
    ["Couldn't open the folder: no Finder", "Couldn't open the folder: it did not open", "Couldn't open the folder: gone"],
  );
});

test("a banner's link marks the turn's lines on its chat, and the chat filter can be let go", async () => {
  const focus = { chat: 'c1', from: Date.parse(T) / 1000 - 3, to: Date.parse(T) - 1000 };
  const { host } = await render(h(RequestLog, { focus }));
  await flush();
  assert.deepEqual(reads(), [{ limit: 200, chat: 'c1' }]);
  assert.deepEqual(
    [...host.querySelectorAll('[data-testid=request-log-line]')].map((r) => r.classList.contains('marked')),
    [true, false, false],
  );
  const box = host.querySelector('input[type=checkbox]') as HTMLInputElement;
  assert.equal(box.checked, true);
  await click(box);
  await flush();
  assert.deepEqual(reads().at(-1), { limit: 200 });
});

test('a link to another chat while the log is open narrows it to that chat again', async () => {
  const v = await render(h(RequestLog, { focus: null }));
  await flush();
  assert.equal(v.host.querySelector('input[type=checkbox]'), null);
  await v.rerender(h(RequestLog, { focus: { chat: 'c2', from: null, to: null } }));
  await flush();
  assert.deepEqual(reads().at(-1), { limit: 200, chat: 'c2' });
  assert.equal((v.host.querySelector('input[type=checkbox]') as HTMLInputElement).checked, true);
});

test('the failed-turn link opens the request log on that chat and turn', async () => {
  const { host } = await render(h(RequestLogLink, { chatId: 'c1', turn: { startedAt: 10, completedAt: null } }));
  await click(host.querySelector('[data-testid=turn-error-request-log]')!);
  assert.deepEqual(
    calls.find((c) => c[0] === 'navigate'),
    ['navigate', { name: 'settings', section: 'about', tab: 'request-log', ledger: { chat: 'c1', from: 10, to: null } }],
  );
});

test('wording: times, counts, accounts, models, tokens and outcomes', () => {
  assert.equal(rl.epochMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(rl.epochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(rl.epochMs(null), null);
  assert.equal(rl.epochMs(0), null);
  assert.equal(rl.epochMs(Number.NaN), null);
  assert.deepEqual([999, 1234, 12_345, 1_234_567].map(rl.compact), ['999', '1.2k', '12k', '1.2M']);
  const base: any = { v: 1, t: T, harness: 'codex', outcome: 'ok' };
  assert.equal(rl.accountText(base), '—');
  assert.equal(rl.accountText({ ...base, account: { id: 'a', email: 'e@x.y', verified: true } }), 'e@x.y');
  assert.equal(rl.modelText(base), '—');
  assert.equal(rl.modelText({ ...base, req: 'a', served: 'b' }), 'a → b');
  assert.equal(rl.modelText({ ...base, req: 'a' }), 'a');
  assert.equal(rl.modelText({ ...base, served: 'b' }), 'b');
  assert.equal(rl.tokensText(base), '—');
  assert.equal(rl.tokensText({ ...base, cacheWrite: 3, reasoning: 2 }), 'cache 0/3 · think 2');
  assert.equal(rl.tokensText({ ...base, reasoning: 0 }), '—');
  assert.equal(rl.outcomeText({ ...base, outcome: 'error', status: 429, code: 'x' }), 'Error 429');
  assert.equal(rl.outcomeText({ ...base, outcome: 'retry' }), 'Retried');
  assert.equal(rl.outcomeText({ ...base, code: 'ignored on ok' }), 'OK');
  assert.equal(rl.outcomeText({ ...base, outcome: 'strange' }), 'strange');
  const now = Date.parse(T);
  assert.equal(rl.timeText(T, now), new Date(T).toLocaleTimeString());
  assert.equal(rl.timeText(T, now + 3 * 86_400_000), new Date(T).toLocaleString());
  assert.deepEqual(
    rl.choices([base, { ...base, harness: 'claude' }, { ...base, harness: '' }], (l: any) => l.harness),
    ['claude', 'codex'],
  );
});

test('focus: a turn with times marks the lines inside them; without times the chat lines that failed', () => {
  const at = (t: string, o: any = {}) => ({ v: 1, t, harness: 'codex', outcome: 'ok', chat: 'c', ...o }) as any;
  const from = Date.parse('2026-10-17T10:00:00.000Z');
  const to = Date.parse('2026-10-17T10:01:00.000Z');
  assert.equal(rl.inFocus(at('2026-10-17T09:59:59.000Z'), { chat: 'c', from, to }), true, 'a little before the start');
  assert.equal(rl.inFocus(at('2026-10-17T09:59:00.000Z'), { chat: 'c', from, to }), false);
  assert.equal(rl.inFocus(at('2026-10-17T10:01:09.000Z'), { chat: 'c', from, to }), true, 'a little after the end');
  assert.equal(rl.inFocus(at('2026-10-17T10:02:00.000Z'), { chat: 'c', from, to }), false);
  assert.equal(rl.inFocus(at('2026-10-17T12:00:00.000Z'), { chat: 'c', from }), true, 'no end: everything after');
  assert.equal(rl.inFocus(at('2026-10-17T08:00:00.000Z'), { chat: 'c', to }), true, 'no start: everything before');
  assert.equal(rl.inFocus(at(T, { chat: 'other' }), { chat: 'c', from, to }), false);
  assert.equal(rl.inFocus(at(T), null), false);
  assert.equal(rl.inFocus(at(T), { chat: 'c' }), false);
  assert.equal(rl.inFocus(at(T, { outcome: 'error' }), { chat: 'c', from: null, to: null }), true);
});
