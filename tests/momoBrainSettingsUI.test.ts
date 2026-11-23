// Settings › MoMo › Brain (src/components/momo/settings/Brain.tsx, BrainPicker.tsx, #2527): one row, one brain (harness · model · account, or a basic harness by name) picked from the model picker's own rows on any harness family and changed through MoMo's main chat (latest change wins, its notes told), and one At limit rule offering what the brain's harness allows. No roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, byText, flush, fakeStore } from './support/shell-chrome-kit.ts';
import { mockSource, popoverStubs, stubStore } from './support/stubs.ts';

const store = fakeStore<any>({ prefs: {} });
const toasts: any[] = [];
const saves: any[] = [];
stubStore({
  useStore: store.useStore,
  toast: (text: string, kind = 'info') => toasts.push([text, kind]),
  toastFailure: (what: string) => (e: any) => toasts.push([`${what}: ${e.message}`, 'error']),
});
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => {
    const { readMomoPrefs } = (globalThis as any).__momoPrefs;
    return readMomoPrefs(store.useStore((s: any) => s.prefs.momo));
  },
  saveMomoPref: async (key: string, value: unknown) => (saves.push([key, value]), true),
});
(globalThis as any).__momoPrefs = await import('../shared/momoPrefs.mjs');

type Bridge = { getBrain: () => Promise<any>; setBrain: (b: any) => Promise<any>; onBrainChanged: (cb: any) => () => void };
let bridge: Bridge | undefined;
mockSource('src/lib/momoBridges.ts', { momoChatBridge: () => bridge });
mockSource('src/lib/flags.ts', { useEnabledHarnesses: () => ['codex', 'claude'] });
let noModels = false;
const chosen: string[] = [];
mockSource('src/session/harness/select.ts', {
  useHarnessModels: (hh: string) =>
    noModels
      ? []
      : hh === 'claude'
        ? [
            { id: 'haiku', label: 'Haiku' },
            { id: 'sonnet', label: 'Sonnet' },
            { id: 'opus', label: 'Opus', isDefault: true },
          ]
        : [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
  chooseAccount: (a: any) => chosen.push(a.id),
});
const acct = (h: string, id: string, name: string, o: { kind?: string; status?: string; state?: string; plan?: string } = {}) => ({
  key: `${h}:${id}`,
  account: { id, kind: o.kind ?? 'subscription', status: o.status ?? 'ok' },
  name,
  plan: o.plan ?? null,
  state: o.state ?? 'signed-in',
  status: { text: o.status === 'expired' ? 'Sign-in expired' : '62% left', tone: 'ok' },
});
// Codex: two subscriptions, an API key and a lapsed login; Claude Code: one subscription
const VIEWS: Record<string, any> = {
  codex: {
    accounts: [
      acct('codex', 'team', 'Team', { plan: 'Business' }),
      acct('codex', 'personal', 'Personal'),
      // per use in any state: an API key being checked, and MoPilot credits (a subscription by kind)
      acct('codex', 'key', 'API key', { kind: 'apiKey', state: 'checking' }),
      acct('codex', 'credits', 'MoPilot', { plan: 'MoPilot credits', state: 'checking' }),
      acct('codex', 'old', 'Old', { status: 'expired', state: 'lapsed' }),
    ],
  },
  claude: { accounts: [acct('claude', 'du@work', 'du@work.com')] },
};
VIEWS.codex.active = VIEWS.codex.accounts[0];
VIEWS.claude.active = VIEWS.claude.accounts[0];
mockSource('src/session/harness/useAccountView.ts', { useAccountView: (hh: string) => VIEWS[hh] });
mockSource('src/session/harness/acp.ts', { basicLabel: (id: string) => `Basic ${id}` });
const stubs = popoverStubs();
mockSource('src/components/ui/Popover.tsx', {
  ...stubs,
  // each popover can be dismissed (Escape, a click outside) by its close button
  Popover: ({ open, children, onClose, placement }: any) =>
    open ? h('div', { 'data-popover': placement }, children, h('button', { onClick: onClose }, `close ${placement}`)) : null,
});
mockSource('src/components/ui/MenuList.tsx', {
  MenuList: ({ children, label, onBack, autoFocus }: any) =>
    h(
      'div',
      { role: 'menu', 'aria-label': label, 'data-autofocus': String(autoFocus ?? true) },
      children,
      onBack ? h('button', { onClick: onBack }, `back ${label}`) : null,
    ),
  MenuRow: ({ children, onClick, ...rest }: any) =>
    h('button', { onClick, disabled: rest.disabled, 'aria-checked': rest['aria-checked'], 'data-account': rest['data-account'] }, children),
});
mockSource('src/components/ui/icons.tsx', { ChevronDown: () => null, Check: () => h('i', null, '✓') });
mockSource('src/components/harnessPicker/badges.tsx', {
  HarnessIcon: ({ h: id }: any) => h('i', { 'data-icon': id }),
  BasicHarnessIcon: ({ id }: any) => h('i', { 'data-icon': `acp:${id}` }),
});
mockSource('src/components/harnessPicker/BasicPicker.tsx', {
  BasicRows: ({ current, onPick, momo }: any) =>
    h('button', { 'data-current': current ?? '', 'data-momo': String(momo), onClick: () => onPick('gemini') }, 'row gemini'),
});
mockSource('src/components/harnessPicker/rows.tsx', {
  // a click, or Enter on the row (opened from the keyboard)
  HarnessRow: ({ h: id, current, onHover, rowRef }: any) => (
    rowRef(null),
    h(
      'span',
      null,
      h('button', { 'data-current': String(current), onClick: (e: any) => onHover(id, e.currentTarget, false) }, `row ${id}`),
      h('button', { onClick: (e: any) => onHover(id, e.currentTarget, true) }, `key ${id}`),
    )
  ),
  ModelList: ({ h: id, currentModel, onPick }: any) =>
    h('button', { 'data-current': currentModel ?? '', onClick: () => onPick({ id: `${id}-m`, label: `${id} model` }) }, `model ${id}`),
});

const { BrainSettings } = await import('../src/components/momo/settings/Brain.tsx');

const rowOf = (host: HTMLElement) => host.querySelector<HTMLElement>('.settings-row')!;
const picker = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('.momo-brain-btn')!;
const limit = (row: HTMLElement) => row.querySelectorAll<HTMLButtonElement>('.select-btn')[1];
/** The flyout's accounts: [name, checked]. */
const accounts = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('[data-popover=right-start] [data-account]')].map((b) => [
    b.textContent,
    b.getAttribute('aria-checked'),
  ]);
const account = (host: HTMLElement, name: string) => byText(host, name, '[data-popover=right-start] [data-account]');
const saved = (momo: unknown) => act(async () => store.setState({ prefs: { momo } }));

function mainBridge(o: { brain?: any; readFails?: boolean } = {}) {
  const listeners = new Set<(b: any) => void>();
  const sets: any[] = [];
  const pending: ((r: any) => void)[] = [];
  let read: (b: any) => void = () => {};
  const b: Bridge & { sets: any[]; push: (x: any) => void; reply: (i: number, r: any) => void; read: (x: any) => void } = {
    sets,
    getBrain: () => (o.readFails ? Promise.reject(new Error('offline')) : new Promise((r) => (read = r))),
    setBrain: (next: any) => (sets.push(next), new Promise((r) => pending.push(r))),
    onBrainChanged: (cb: any) => (listeners.add(cb), () => listeners.delete(cb)),
    push: (x: any) => act(async () => listeners.forEach((l) => l(x))) as any,
    reply: (i: number, r: any) => act(async () => pending[i](r)) as any,
    read: (x: any) => act(async () => read(x)) as any,
  };
  return b;
}

test('one row, one picker: a pick on each harness family goes through MoMo’s main chat, in the brain’s billing lane; another harness starts on its everyday model', async () => {
  const b = mainBridge();
  bridge = b;
  store.setState({ prefs: {} });
  const { host, unmount } = await render(h(BrainSettings));
  assert.deepEqual(
    [...host.querySelectorAll('.settings-row-title')].map((t) => t.textContent),
    ['Brain', 'Let my phone change the brain'],
    'one brain and the phone switch, no roles',
  );
  assert.doesNotMatch(host.textContent!, /Main chat|Topics|Routines|Quick ask/);
  await b.read({ harness: 'codex', account: 'team', model: 'gpt-5.5', modelLabel: 'GPT-5.5' });
  const row = rowOf(host);
  assert.equal(picker(row).textContent, 'Codex · GPT-5.5 · Team');
  // on its brain's harness: its account marked, only its billing lane; a model keeps the account, an account the model
  await click(picker(row));
  await click(byText(host, 'row codex'));
  assert.equal(
    host.querySelector('[data-popover=right-start] [role=menu]')!.getAttribute('data-autofocus'),
    'false',
    'a pointer leaves focus',
  );
  assert.deepEqual(accounts(host), [
    ['TeamBusiness · 62% left✓', 'true'],
    ['Personal62% left', 'false'],
    ['OldSign-in expired', 'false'],
  ]);
  assert.equal(byText(host, 'model codex').getAttribute('data-current'), 'gpt-5.5');
  await click(account(host, 'Personal'));
  assert.deepEqual(b.sets.at(-1), { harness: 'codex', account: 'personal', model: 'gpt-5.5', modelLabel: 'GPT-5.5' });
  await click(picker(row));
  await click(byText(host, 'key codex'));
  assert.equal(
    host.querySelector('[data-popover=right-start] [role=menu]')!.getAttribute('data-autofocus'),
    'true',
    'opened from the keyboard',
  );
  await click(byText(host, 'model codex'));
  assert.deepEqual(b.sets.at(-1), { harness: 'codex', account: 'team', model: 'codex-m', modelLabel: 'codex model' });
  // a signed-out login signs in again and picks nothing
  const n = b.sets.length;
  await click(picker(row));
  await click(byText(host, 'row codex'));
  await click(account(host, 'Old'));
  assert.deepEqual(chosen, ['old']);
  assert.equal(b.sets.length, n);
  assert.ok(host.querySelector('[data-popover=right-start]'), 'the menu stays for a pick once signed in');
  await click(picker(row));
  // Claude Code from Codex: its account, on its everyday model (Sonnet), not the list's strongest default (Opus)
  await click(picker(row));
  await click(byText(host, 'row claude'));
  assert.equal(byText(host, 'model claude').getAttribute('data-current'), '', 'not the brain’s harness: no model marked');
  await click(account(host, 'du@work.com'));
  assert.deepEqual(b.sets.at(-1), { harness: 'claude', account: 'du@work', model: 'sonnet', modelLabel: 'Sonnet' });
  // a model from another harness starts on that harness's own account
  await click(picker(row));
  await click(byText(host, 'row claude'));
  await click(byText(host, 'model claude'));
  assert.deepEqual(b.sets.at(-1), { harness: 'claude', account: null, model: 'claude-m', modelLabel: 'claude model' });
  await click(picker(row));
  await click(byText(host, 'row claude'));
  await click(byText(host, 'back Claude Code'));
  assert.equal(host.querySelector('[aria-label="Claude Code"]'), null, 'back closes the flyout');
  // a basic (ACP) harness: one sign-in, no account or model; MoMo's menu shows one its quirks can't confine as off (#2278)
  assert.equal(byText(host, 'row gemini').dataset.momo, 'true');
  await click(byText(host, 'row gemini'));
  assert.deepEqual(b.sets.at(-1), { harness: 'acp:gemini', account: null, model: null, modelLabel: null });
  await b.push({ harness: 'acp:gemini', account: null, model: null, modelLabel: null });
  assert.equal(picker(row).textContent, 'Basic gemini');
  await click(picker(row));
  assert.equal(byText(host, 'row gemini').getAttribute('data-current'), 'gemini');
  // no Default row: the brain is MoMo's own
  assert.throws(() => byText(host, 'Default', 'button[aria-checked]'));
  assert.match(row.textContent!, /Everything MoMo does runs on it/);
  await unmount();
});

test('At limit: one rule, named, with the choices the brain’s harness allows; Next account only with another account in its lane', async () => {
  const b = mainBridge();
  bridge = b;
  store.setState({ prefs: {} });
  const { host, unmount } = await render(h(BrainSettings));
  const row = rowOf(host);
  const menuItems = () => [...host.querySelectorAll('[role=menu] button')].map((x) => x.textContent).filter((t) => t && !/close/.test(t));
  const choices = async () => {
    await click(limit(row));
    const items = menuItems();
    await click(limit(row));
    return items;
  };
  assert.equal(limit(row).getAttribute('aria-label'), 'Brain at limit');
  // no brain yet: every choice, the default Next account
  assert.equal(limit(row).textContent, 'Next account');
  assert.deepEqual(await choices(), ['Next account', 'Pause', 'Skip this run']);
  await click(limit(row));
  await click(byText(host, 'Pause', '[role=menu] *'));
  assert.deepEqual(saves.at(-1), ['atLimit', 'pause']);
  await click(limit(row));
  await click(byText(host, 'Skip this run', '[role=menu] *'));
  assert.deepEqual(saves.at(-1), ['atLimit', 'skip']);
  // Claude Code with one account: no next account, so Next account pauses there
  await b.read({ harness: 'claude', account: 'du@work' });
  await saved({ atLimit: 'nextAccount' });
  assert.equal(limit(row).textContent, 'Pause');
  assert.deepEqual(await choices(), ['Pause', 'Skip this run']);
  // Codex: two subscriptions; an API key alone in its lane; no account named: the one new chats use
  await b.push({ harness: 'codex', account: 'team' });
  assert.equal(limit(row).textContent, 'Next account');
  assert.deepEqual(await choices(), ['Next account', 'Pause', 'Skip this run']);
  // an API key and MoPilot credits share the per-use lane
  await b.push({ harness: 'codex', account: 'key' });
  assert.equal(limit(row).textContent, 'Next account');
  const credits = VIEWS.codex.accounts.splice(3, 1);
  await b.push({ harness: 'codex', account: 'key', model: null });
  assert.equal(limit(row).textContent, 'Pause', 'a key alone in its lane');
  VIEWS.codex.accounts.splice(3, 0, ...credits);
  await b.push({ harness: 'codex' });
  assert.equal(limit(row).textContent, 'Next account');
  VIEWS.codex.active = null;
  await b.push({ harness: 'codex', account: 'gone' });
  assert.equal(limit(row).textContent, 'Next account', 'no account known: every login counts');
  VIEWS.codex.active = VIEWS.codex.accounts[0];
  // a basic harness: one sign-in
  await b.push({ harness: 'acp:gemini' });
  assert.equal(limit(row).textContent, 'Pause');
  assert.deepEqual(await choices(), ['Pause', 'Skip this run']);
  await unmount();
});

test('not available without MoMo’s main chat in this build', async () => {
  bridge = undefined;
  store.setState({ prefs: {} });
  const { host, unmount } = await render(h(BrainSettings));
  const row = rowOf(host);
  assert.match(row.textContent!, /Not available in this build/);
  assert.equal(picker(row), null, 'nothing to pick from');
  assert.equal(row.querySelector('.select-btn')!.textContent, 'Next account');
  assert.equal(row.querySelector('.select-btn')!.getAttribute('aria-label'), 'Brain at limit');
  await unmount();
});

test('read from the main chat, changed through it, the latest change wins, its notes told', async () => {
  const b = mainBridge();
  bridge = b;
  store.setState({ prefs: {} });
  toasts.length = 0;
  const { host, unmount } = await render(h(BrainSettings));
  const main = rowOf(host);
  assert.equal(picker(main).disabled, true, 'until main answers');
  // a change from another window lands before the first read: the read is older and is not shown
  await b.push({ harness: 'codex', account: 'team', model: 'gpt-5.5', modelLabel: 'GPT-5.5' });
  await b.read({ harness: 'claude', account: 'du@work', model: 'opus', modelLabel: 'Opus' });
  assert.equal(picker(main).textContent, 'Codex · GPT-5.5 · Team');
  assert.equal(picker(main).disabled, false);
  await click(picker(main));
  await click(byText(host, 'row claude'));
  await click(byText(host, 'model claude'));
  await click(picker(main));
  await click(byText(host, 'row gemini'));
  assert.deepEqual(b.sets, [
    { harness: 'claude', account: null, model: 'claude-m', modelLabel: 'claude model' },
    { harness: 'acp:gemini', account: null, model: null, modelLabel: null },
  ]);
  // the newer change answers first; the older one's late answer doesn't bring its brain back, but its note is told
  await b.reply(1, {
    brain: { harness: 'acp:gemini', account: null, model: null, modelLabel: null },
    chatId: 'n',
    applied: 'newChat',
    warning: null,
  });
  await b.reply(0, {
    brain: { harness: 'claude', account: null, model: 'claude-m', modelLabel: 'claude model' },
    chatId: 'c',
    applied: 'nextMessage',
    warning: null,
  });
  assert.equal(picker(main).textContent, 'Basic gemini');
  assert.deepEqual(toasts, [
    ['MoMo started a new chat on its new brain', 'info'],
    ['MoMo switches with its next message', 'info'],
  ]);
  // a warning is an error; a change done now says nothing
  await click(picker(main));
  await click(byText(host, 'row gemini'));
  await b.reply(2, {
    brain: { harness: 'acp:gemini', account: null, model: null, modelLabel: null },
    chatId: 'n',
    applied: 'now',
    warning: 'Model not applied',
  });
  await click(picker(main));
  await click(byText(host, 'row gemini'));
  await b.reply(3, {
    brain: { harness: 'acp:gemini', account: null, model: null, modelLabel: null },
    chatId: 'n',
    applied: 'saved',
    warning: null,
  });
  assert.deepEqual(toasts.slice(2), [['Model not applied', 'error']]);
  await unmount();
  // gone: a late read or change event changes nothing
  await b.read({ harness: 'codex' });
});

test('a failed read or change is told, and a pick still goes to main', async () => {
  const b = mainBridge({ readFails: true });
  b.setBrain = () => Promise.reject(new Error('not_allowed'));
  bridge = b;
  toasts.length = 0;
  const { host, unmount } = await render(h(BrainSettings));
  await flush();
  const main = rowOf(host);
  assert.equal(picker(main).textContent, 'Not set');
  assert.equal(picker(main).disabled, false);
  await click(picker(main));
  await click(byText(host, 'row gemini'));
  assert.deepEqual(toasts, [
    ["Couldn't read MoMo's brain: offline", 'error'],
    ["Couldn't change MoMo's brain: not_allowed", 'error'],
  ]);
  await unmount();
  // a read that fails after the page is gone tells nobody
  const late = mainBridge();
  let fail: (e: Error) => void = () => {};
  late.getBrain = () => new Promise((_r, j) => (fail = j));
  bridge = late;
  const again = await render(h(BrainSettings));
  await again.unmount();
  toasts.length = 0;
  await act(async () => fail(new Error('late')));
  assert.deepEqual(toasts, []);
  // a read that fails after a brain was heard says nothing: the brain shown is newer
  const heard = mainBridge();
  heard.getBrain = () => new Promise((_r, j) => (fail = j));
  bridge = heard;
  const third = await render(h(BrainSettings));
  await heard.push({ harness: 'acp:gemini', account: null, model: null, modelLabel: null });
  await act(async () => fail(new Error('slow')));
  assert.deepEqual(toasts, []);
  assert.equal(picker(rowOf(third.host)).textContent, 'Basic gemini');
  await third.unmount();
});

test('a brain names what it can: a model or account the harness no longer lists, and a harness with no models', async () => {
  const b = mainBridge();
  bridge = b;
  const { host, unmount } = await render(h(BrainSettings));
  await b.read({ harness: 'claude', account: 'gone', model: 'sonnet-x', modelLabel: 'Sonnet X' });
  assert.equal(picker(rowOf(host)).textContent, 'Claude Code · Sonnet X');
  await b.push({ harness: 'claude', account: null, model: 'raw-id', modelLabel: null });
  assert.equal(picker(rowOf(host)).textContent, 'Claude Code · raw-id');
  // a model pick on the brain's own harness keeps its account, none here
  await click(picker(rowOf(host)));
  await click(byText(host, 'row claude'));
  await click(byText(host, 'model claude'));
  assert.deepEqual(b.sets.at(-1), { harness: 'claude', account: null, model: 'claude-m', modelLabel: 'claude model' });
  // a harness with no account listed yet: no accounts heading, its models still
  const claudeAccounts = VIEWS.claude.accounts;
  VIEWS.claude.accounts = [];
  await click(picker(rowOf(host)));
  await click(byText(host, 'row claude'));
  assert.doesNotMatch(host.querySelector('[data-popover=right-start]')!.textContent!, /Accounts/);
  assert.ok(byText(host, 'model claude'));
  await click(picker(rowOf(host)));
  VIEWS.claude.accounts = claudeAccounts;
  // the flyout closes by itself (Escape, a click outside)
  await click(picker(rowOf(host)));
  await click(byText(host, 'row codex'));
  await click(byText(host, 'close right-start'));
  assert.equal(host.querySelector('[data-popover=right-start]'), null);
  // a harness that lists no models yet: its account, on no model
  noModels = true;
  await click(byText(host, 'row codex'));
  await click(account(host, 'Personal'));
  assert.deepEqual(b.sets.at(-1), { harness: 'codex', account: 'personal', model: null, modelLabel: null });
  noModels = false;
  await unmount();
});

test('the Change trigger (setup) opens the same picker, with no brain words on the button', async () => {
  const { BrainPicker } = await import('../src/components/momo/settings/BrainPicker.tsx');
  const picked: any[] = [];
  const { host, unmount } = await render(
    h(BrainPicker, {
      label: 'Change brain',
      trigger: 'change',
      brain: { harness: 'codex', account: 'team', model: null, modelLabel: null },
      onPick: (x: any) => picked.push(x),
    }),
  );
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Change brain"]')!;
  assert.equal(button.textContent, 'Change');
  assert.equal(button.className, 'btn-pill');
  await click(button);
  await click(byText(host, 'row codex'));
  await click(account(host, 'Personal'));
  assert.deepEqual(picked, [{ harness: 'codex', account: 'personal', model: null, modelLabel: null }]);
  await unmount();
});

test('Let my phone change the brain: off until the user turns it on, saved through main either way', async () => {
  bridge = undefined;
  store.setState({ prefs: {} });
  saves.length = 0;
  const { host, unmount } = await render(h(BrainSettings));
  const row = () => [...host.querySelectorAll<HTMLElement>('.settings-row')].find((r) => /Let my phone/.test(r.textContent!))!;
  assert.equal(row().querySelector('.toggle')!.getAttribute('aria-checked'), 'false');
  await click(row().querySelector('.toggle')!);
  assert.deepEqual(saves.at(-1), ['remote.brainChange', true]);
  await saved({ remote: { brainChange: true } });
  assert.equal(row().querySelector('.toggle')!.getAttribute('aria-checked'), 'true');
  await click(row().querySelector('.toggle')!);
  assert.deepEqual(saves.at(-1), ['remote.brainChange', false]);
  await unmount();
});
