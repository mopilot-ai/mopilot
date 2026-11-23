// src/components/thread/SuggestionCard.tsx: the sessions a turn proposed, as one card after its reply on any harness,
// in Claude Desktop's shape: a header (one offer asks, one suggestion is "New session", several are counted with Start
// all), a row per proposal with where it would run (which opens its start options), an offer's Do it here / New session
// beside its title (answered in its waiting call, or as the user's reply once that call ended), its keys and the header's
// "Don't ask again", a suggestion's Start and dismiss, and a row that started as the session's live card.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click, flush } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
const store = fakeStore<any>({ archived: [], runtime: {}, segments: {}, basicHarnesses: [], threads: { top: { cwd: '/repo' } } });
store.setState({ claudeArchived: {}, agentTabs: {} });
const REPO = { current: 'main', default: 'main', branches: ['main'], commits: true };
/** each folder's branch list (missing: not a repo), and the folders a card read */
let lists: Record<string, any> = { '/repo': REPO };
const loads: string[] = [];
let fail: Error | null = null;
/** the one action `fail` refuses, or every action */
let failOn: string | null = null;
let sendAnswer: boolean | undefined;
let sendFail: Error | null = null;
let notify: (v: any) => void = () => {};
/** what main answers a click: answered when the offer's call was waiting and took it */
let taskAnswer: any;
stubStore(
  {
    useStore: store.useStore,
    // a chat link's ⌥-click (session/openChat.ts)
    openInSplit: () => {},
    chatKind: () => 'codex',
    giveBackToComposer: (...args: any[]) => calls.push(['draft', ...args]),
    navigate: (r: any) => calls.push(['navigate', r]),
    toast: (...a: any[]) => calls.push(['toast', ...a]),
    sendOrDraft: async (...a: any[]) => {
      calls.push(['send', ...a]);
      if (sendFail) throw sendFail;
      return sendAnswer;
    },
  },
  {
    'src/store/core.ts': { setPrefs: (p: any) => calls.push(['prefs', p]) },
  },
);
mock.module('../src/session/harness/select.ts', {
  namedExports: { useHarnessModels: () => [], useEffectiveSelection: () => ({ model: null }) },
});
// "Don't ask again" saves the choice through the store's core
// the harnesses a card's Options offer
mock.module('../src/lib/flags.ts', { namedExports: { useEnabledHarnesses: () => ['codex', 'claude'] } });
mock.module('../src/session/useChatRowState.ts', {
  namedExports: { useChatRowState: () => ({ state: 'working' }), useChatTurn: () => 'idle', retryChatState: async () => {} },
});
installNativeStub({
  git: { branches: async (p: string) => (loads.push(p), lists[p] ?? null) },
  orchestration: {
    snapshot: async () => ({ children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} }),
    onChanged: (cb: any) => ((notify = cb), () => {}),
    task: async (id: string, action: string, options?: unknown) => {
      calls.push(options ? ['task', id, action, options] : ['task', id, action]);
      if (fail && (!failOn || failOn === action)) throw fail;
      return taskAnswer;
    },
  },
});
mock.module('../src/components/ui/Popover.tsx', {
  namedExports: {
    Popover: (p: any) =>
      p.open
        ? h(
            'div',
            { 'data-popover': p.placement },
            p.children,
            h('button', { 'aria-label': 'Close start options', onClick: p.onClose }, 'Close'),
          )
        : null,
  },
});
const { TurnSuggestions, herePrompt, PLACE } = await import('../src/components/thread/SuggestionCard.tsx');
const { ARM_MS, offerKey } = await import('../src/components/thread/offerKeys.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const proposal = (o: any = {}) => ({
  parentId: 'top',
  kind: 'own_initiative',
  title: 'T',
  prompt: 'The brief\nmore',
  status: 'open',
  chatId: null,
  expiresAt: 9e15,
  waiting: false,
  place: 'worktree',
  ...o,
});
const show = (proposals: any) => act(async () => notify({ children: {}, deliveries: {}, proposals, queue: [], plans: {}, wrapUps: {} }));
const call = (taskId: string | null, title: string, offer = false) => ({ kind: 'proposed' as const, taskId, title, offer });
const text = (el: Element | null) => el?.textContent ?? '';
const buttons = (host: Element) => [...host.querySelectorAll('.suggest-row-actions button')] as HTMLButtonElement[];
const labels = (host: Element) => buttons(host).map((b) => b.textContent);
const key = (init: KeyboardEventInit) =>
  act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true })));
const armed = () => new Promise((r) => setTimeout(r, ARM_MS + 50));
/** An IntersectionObserver that reports every card it watches as on screen, or not. */
const observer = (onScreen: boolean) =>
  class {
    cb: (e: { isIntersecting: boolean }[]) => void;
    constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
      this.cb = cb;
    }
    observe() {
      this.cb([{ isIntersecting: onScreen }]);
    }
    disconnect() {}
  };

test('one suggestion: "New session", where it runs and its brief, Start, a dismiss, and its state from main', async () => {
  calls.length = 0;
  const v = await render(h(TurnSuggestions, { calls: [call('t1', 'Add tests')], threadId: 'top' }));
  await flush();
  // the window reads main's view once it is first used, then follows its changes
  await show({ t1: proposal({ title: 'Add tests' }) });
  assert.equal(v.host.querySelector('.session-suggestions')!.getAttribute('aria-label'), '1 suggested task');
  assert.equal(text(v.host.querySelector('.suggest-head-text')), 'New session');
  assert.equal(text(v.host.querySelector('.suggest-row-desc')), 'In a worktree · The brief');
  // the title opens the whole brief in place of its first line
  const title = v.host.querySelector('.suggest-row-title.link') as HTMLButtonElement;
  await click(title);
  assert.equal(title.getAttribute('aria-expanded'), 'true');
  assert.equal(text(v.host.querySelector('.suggest-row-prompt')), 'The brief\nmore');
  assert.equal(text(v.host.querySelector('.suggest-row-desc')), 'In a worktree');
  assert.deepEqual(labels(v.host), ['Start']);
  await click(buttons(v.host)[0]);
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 't1', 'start']]);
  // a start main refuses is told, and the row says it couldn't start
  fail = new Error('No folder');
  await click(buttons(v.host)[0]);
  await flush();
  fail = null;
  assert.deepEqual(calls.splice(0), [
    ['task', 't1', 'start'],
    ['toast', 'No folder', 'error'],
  ]);
  assert.equal(text(v.host.querySelector('.suggest-row-failed')), 'Couldn’t start');
  await click(v.host.querySelector('[aria-label="Dismiss suggestion Add tests"]')!);
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 't1', 'dismiss']]);
  for (const [status, words] of [
    ['dismissed', 'Dismissed'],
    ['expired', 'Expired'],
    ['starting', 'Starting…'],
    ['briefing', 'Writing the brief…'],
    ['declined', 'Sent to this session'],
    ['weird', 'weird'],
  ]) {
    await show({ t1: proposal({ title: 'Add tests', status }) });
    assert.equal(text(v.host.querySelector('.suggest-row-status-label')), words);
  }
  assert.equal(text(v.host.querySelector('[aria-live]')), 'Add tests: weird');
  // once it starts, the lone card is just the session's live card, which opens it
  await show({ t1: proposal({ title: 'Add tests', status: 'started', chatId: 'kid' }) });
  assert.equal(v.host.querySelector('.suggest-card'), null);
  await click(v.host.querySelector('.session-card')!);
  assert.deepEqual(calls.splice(0), [['navigate', { name: 'thread', id: 'kid' }]]);
  await v.unmount();
});

test('several suggestions: counted, how many started, Start all at once, and Show more past six', async () => {
  calls.length = 0;
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  await show(Object.fromEntries(ids.map((id) => [id, proposal({ title: id, place: id === 'a' ? 'fork' : 'folder' })])));
  const v = await render(h(TurnSuggestions, { calls: ids.map((id) => call(id, id)), threadId: 'top' }));
  assert.equal(text(v.host.querySelector('.suggest-head-text')), '7 suggested tasks');
  assert.equal(v.host.querySelector('.suggest-head-started'), null);
  assert.equal(v.host.querySelectorAll('.suggest-row').length, 5);
  assert.equal(text(v.host.querySelector('.suggest-row-place')), PLACE.fork);
  await click(v.host.querySelector('.suggest-more')!);
  assert.equal(v.host.querySelectorAll('.suggest-row').length, 7);
  assert.equal(text(v.host.querySelector('.suggest-more')), 'Show fewer');
  let release = (_?: unknown) => {};
  taskAnswer = new Promise((resolve) => (release = resolve)); // main holds every start: each is sent before any is done
  await click(v.host.querySelector('.suggest-start-all')!);
  await flush();
  assert.deepEqual(
    calls.splice(0),
    ids.map((id) => ['task', id, 'start']),
  );
  assert.equal((v.host.querySelector('.suggest-start-all') as HTMLButtonElement).disabled, true);
  await act(async () => release((taskAnswer = undefined)));
  await show(Object.fromEntries(ids.map((id) => [id, proposal({ title: id, status: id < 'c' ? 'started' : 'open', chatId: `k${id}` })])));
  assert.equal(text(v.host.querySelector('.suggest-head-started')), '2 started');
  assert.equal(v.host.querySelectorAll('.suggest-row[data-state="started"] .session-card').length, 2);
  await v.unmount();
  // a read-only chat shows them with nothing to answer (a title still opens its brief)
  const ro = await render(h(TurnSuggestions, { calls: ids.slice(2, 4).map((id) => call(id, id)), threadId: 'top', readOnly: true }));
  assert.equal(ro.host.querySelectorAll('.suggest-row-actions, .suggest-row-dismiss, .suggest-start-all').length, 0);
  assert.equal(ro.host.querySelectorAll('.suggest-row-place.link').length, 0, 'where it runs is only a label');
  assert.equal(ro.host.querySelectorAll('.suggest-row-title.link').length, 2);
  await ro.unmount();
});

test('an offer whose call ended: New session, or "Do it here" as the user’s reply, given back when refused', async () => {
  calls.length = 0;
  await show({});
  // Until main names its owner, a historical task id cannot authorize an action.
  const v = await render(h(TurnSuggestions, { calls: [call('gone', 'Offer title', true)], threadId: 'top' }));
  assert.equal(text(v.host.querySelector('.suggest-head-text')), 'Start this in its own session?');
  assert.equal(v.host.querySelector('.suggest-row-desc'), null);
  assert.equal(v.host.querySelector('.suggest-row-dismiss'), null, 'an offer is answered, not dismissed');
  assert.deepEqual(labels(v.host), ['Do it here ', 'New session ']);
  const here = () => click(buttons(v.host).find((button) => button.textContent?.startsWith('Do it here')));
  assert.ok(buttons(v.host).every((button) => button.disabled));
  assert.equal(v.host.querySelector('.suggest-head-link'), null, 'nothing to remember before main names the offer');
  await click(buttons(v.host)[1]);
  assert.deepEqual(calls.splice(0), []);
  await show({ gone: proposal({ kind: 'offer', title: 'Offer title' }) });
  assert.equal(text(v.host.querySelector('.suggest-head-link')), 'Don’t ask again');
  await click(buttons(v.host).find((button) => button.textContent?.startsWith('New session')));
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 'gone', 'start']]);
  sendAnswer = false;
  await here();
  await flush();
  assert.deepEqual(calls.splice(0), [
    ['task', 'gone', 'here'],
    ['send', 'top', herePrompt('Offer title'), { human: true }],
    ['task', 'gone', 'reopen'],
  ]);
  sendAnswer = undefined;
  // main refuses an offer that expired or started elsewhere: nothing is sent (#1988)
  fail = new Error('That proposal is expired');
  await here();
  await flush();
  fail = null;
  assert.deepEqual(calls.splice(0), [
    ['task', 'gone', 'here'],
    ['toast', 'That proposal is expired', 'error'],
  ]);
  // a send that throws gives the offer back, and a reopen main refuses is told without hiding the send's failure
  sendFail = new Error('chat closed');
  fail = new Error('That proposal is open');
  failOn = 'reopen';
  await here();
  await flush();
  sendFail = null;
  fail = null;
  failOn = null;
  assert.deepEqual(calls.splice(0), [
    ['task', 'gone', 'here'],
    ['send', 'top', herePrompt('Offer title'), { human: true }],
    ['task', 'gone', 'reopen'],
    ['toast', 'That proposal is open', 'error'],
    ['toast', 'chat closed', 'error'],
  ]);
  // an offer starting shimmers its title, and then says so
  await show({ gone: proposal({ kind: 'offer', title: 'Offer title', status: 'starting' }) });
  assert.ok(v.host.querySelector('.suggest-row-title.shimmer-text'));
  assert.equal(text(v.host.querySelector('.suggest-row-status-label')), 'Starting…');
  await v.unmount();
});

test('an offer whose call waits: found by its title, answered in that call, by its keys or "Don’t ask again"', async () => {
  calls.length = 0;
  const realObserver = globalThis.IntersectionObserver;
  const setObserver = (o: unknown) => ((globalThis as any).IntersectionObserver = o);
  const waiting = proposal({ kind: 'offer', title: 'Docs', waiting: true, place: 'folder' });
  const pending = call(null, 'Docs', true);
  setObserver(observer(true));
  await show({});
  const v = await render(h(TurnSuggestions, { calls: [pending], threadId: 'top' }));
  // main has not shown its offer yet: nothing to answer
  assert.ok(buttons(v.host).every((b) => b.disabled));
  // another chat's offer of that title, or one no longer waiting, is not this card's
  await show({ x: { ...waiting, parentId: 'other' }, y: { ...waiting, waiting: false } });
  assert.ok(buttons(v.host).every((b) => b.disabled));
  await show({ t9: waiting });
  assert.equal(text(v.host.querySelector('.suggest-row-desc')), 'In this folder');
  assert.deepEqual(
    [...v.host.querySelectorAll('kbd')].map((k) => k.textContent),
    ['Esc', '⌘↵'],
  );
  taskAnswer = { answered: true };
  await click(buttons(v.host)[0]);
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 't9', 'here']], 'the waiting call took it: nothing is sent');
  await armed();
  for (const className of ['popover-layer', 'tooltip interactive']) {
    const popup = document.createElement('div');
    popup.className = className;
    document.body.append(popup);
    await key({ key: 'Escape' });
    await key({ key: 'Enter', metaKey: true });
    assert.deepEqual(calls.splice(0), [], 'an open option/composer popup owns its keys');
    popup.remove();
  }
  // a text field of its own (find in the chat) keeps its keys; the composer's are the card's
  const field = (composer: boolean) => {
    const wrap = document.createElement('div');
    if (composer) wrap.dataset.composerChat = 'top';
    const input = document.createElement('input');
    wrap.append(input);
    document.body.append(wrap);
    return input;
  };
  const find = field(false);
  for (const init of [{ key: 'Escape' }, { key: 'Enter', metaKey: true }])
    await act(async () => void find.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true })));
  assert.deepEqual(calls.splice(0), [], 'a field outside the composer keeps Escape and ⌘↵');
  find.parentElement!.remove();
  const box = field(true);
  await act(async () => void box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 't9', 'here']]);
  box.parentElement!.remove();
  await show({ t9: waiting });
  await flush();
  await key({ key: 'Enter', metaKey: true });
  await flush();
  await key({ key: 'Escape' });
  await flush();
  await key({ key: 'a' });
  assert.deepEqual(calls.splice(0), [
    ['task', 't9', 'start'],
    ['task', 't9', 'here'],
  ]);
  assert.equal(offerKey({ key: 'Enter', metaKey: false, ctrlKey: true, isComposing: false }), 'start');
  assert.equal(offerKey({ key: 'Enter', metaKey: false, ctrlKey: false, isComposing: false }), null);
  assert.equal(offerKey({ key: 'Escape', metaKey: false, ctrlKey: false, isComposing: true }), null);
  // the header's "Don't ask again" shows its choices in place of the answers; one remembers the choice and answers with it
  const dontAsk = () => click(v.host.querySelector('.suggest-head-link'));
  await dontAsk();
  assert.equal(v.host.querySelector('.suggest-head-link'), null);
  assert.deepEqual(labels(v.host), ['Cancel', 'Always do it here', 'Always start a new session']);
  await click(buttons(v.host)[0]);
  assert.deepEqual(labels(v.host), ['Do it here Esc', 'New session ⌘↵']);
  await dontAsk();
  await click(buttons(v.host)[1]);
  await flush();
  await dontAsk();
  await click(buttons(v.host)[2]);
  await flush();
  assert.deepEqual(calls.splice(0), [
    ['prefs', { newTaskPrompt: 'here' }],
    ['task', 't9', 'here'],
    ['prefs', { newTaskPrompt: 'new' }],
    ['task', 't9', 'start'],
  ]);
  // once answered the card no longer takes the keys
  await show({ t9: { ...waiting, status: 'declined', waiting: false } });
  await key({ key: 'Escape' });
  assert.deepEqual(calls.splice(0), []);
  await v.unmount();
  // scrolled away, the card leaves the keys to the composer; with no observer at all it counts as on screen
  await show({ t9: waiting });
  setObserver(observer(false));
  const away = await render(h(TurnSuggestions, { calls: [pending], threadId: 'top' }));
  await armed();
  await key({ key: 'Escape' });
  assert.deepEqual(calls.splice(0), []);
  await away.unmount();
  setObserver(undefined);
  const bare = await render(h(TurnSuggestions, { calls: [pending], threadId: 'top' }));
  await armed();
  await key({ key: 'Escape' });
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 't9', 'here']]);
  await bare.unmount();
  // two offers waiting at once: one key answers the first, never both
  setObserver(observer(true));
  await show({ t9: waiting, t8: { ...waiting, title: 'Tests' } });
  const two = await render(h(TurnSuggestions, { calls: [pending, call(null, 'Tests', true)], threadId: 'top' }));
  assert.equal(two.host.querySelectorAll('kbd').length, 4, 'both show their keys');
  assert.equal(two.host.querySelector('.suggest-head-link'), null, 'only a lone offer asks once for all');
  await armed();
  await key({ key: 'Escape' });
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 't9', 'here']]);
  await two.unmount();
  setObserver(realObserver);
  taskAnswer = undefined;
});

test('Options change where a suggestion starts and on which harness; only what changed goes with Start', async () => {
  const { startChoice } = await import('../src/components/thread/StartOptions.tsx');
  calls.length = 0;
  const v = await render(h(TurnSuggestions, { calls: [call('t7', 'Docs')], threadId: 'top' }));
  await show({ t7: proposal({ title: 'Docs' }) });
  const options = () => v.host.querySelector('.suggest-row-place.link') as HTMLButtonElement;
  assert.equal(options().textContent, PLACE.worktree);
  await click(options());
  assert.equal(options().getAttribute('aria-expanded'), 'true');
  assert.ok(v.host.querySelector('[data-popover="bottom-start"] [role="dialog"][aria-label="Session start options"]'));
  await click(v.host.querySelector('[aria-label="Close start options"]'));
  assert.equal(v.host.querySelector('.start-options'), null);
  await click(options());
  const box = v.host.querySelector('.start-options input[type="checkbox"]') as HTMLInputElement;
  const pick = v.host.querySelector('.start-options select') as HTMLSelectElement;
  assert.equal(box.checked, true, 'proposed in a worktree');
  assert.deepEqual(
    [...pick.options].map((o) => o.textContent),
    ['As proposed', 'Codex', 'Claude Code'],
  );
  await act(async () => {
    box.click();
    pick.value = 'claude';
    pick.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click([...v.host.querySelectorAll('.suggest-row-actions button')].find((b) => b.textContent === 'Start')!);
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 't7', 'start', { harness: 'claude', useWorktree: false }]]);
  // back to as proposed: nothing extra goes
  await act(async () => {
    pick.value = '';
    pick.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click(options());
  assert.equal(v.host.querySelector('.start-options'), null);
  await v.unmount();
  // a fork stays in the chat's folder: no worktree choice
  const fork = await render(h(TurnSuggestions, { calls: [call('t6', 'Fork')], threadId: 'top' }));
  await show({ t6: proposal({ title: 'Fork', place: 'fork' }) });
  await click(fork.host.querySelector('.suggest-row-place.link'));
  assert.equal(fork.host.querySelector('.start-options input'), null);
  assert.ok(fork.host.querySelector('.start-options select'));
  await fork.unmount();
  assert.equal(startChoice({ harness: null, useWorktree: null }), null);
  assert.deepEqual(startChoice({ harness: 'codex', useWorktree: null }), { harness: 'codex' });
});

test("where the chat's folder can't hold a worktree, a row says it runs in the folder; Start leaves the place to main", async () => {
  const { placeOf } = await import('../src/components/thread/StartOptions.tsx');
  const { NOT_A_REPO, NO_COMMITS } = await import('../shared/worktreeSupport.mjs');
  assert.equal(placeOf('worktree', NOT_A_REPO), 'folder');
  assert.equal(placeOf('worktree', undefined), 'worktree', 'not known yet: as proposed');
  assert.equal(placeOf('fork', NOT_A_REPO), 'fork');
  calls.length = 0;
  loads.length = 0;
  store.set({ threads: { top: { cwd: '/plain' } } });
  lists['/empty'] = { current: 'main', default: null, branches: [], commits: false };
  try {
    await show({ w1: proposal({ title: 'One' }), w2: proposal({ title: 'Two' }) });
    // w3 has no confirmed owner yet and cannot participate in Start all.
    const v = await render(h(TurnSuggestions, { calls: [call('w1', 'One'), call('w2', 'Two'), call('w3', 'Three')], threadId: 'top' }));
    await flush();
    assert.deepEqual(loads, ['/plain'], 'one read for the card');
    const places = () => [...v.host.querySelectorAll('.suggest-row-place')].map(text);
    assert.deepEqual(places(), [PLACE.folder, PLACE.folder]);
    const options = () => v.host.querySelector('.suggest-row-place.link')!;
    await click(options());
    assert.equal(v.host.querySelector('.start-options input'), null, 'not a repo: no worktree to choose');
    assert.ok(v.host.querySelector('.start-options select'));
    await click(v.host.querySelector('.suggest-start-all')!);
    await flush();
    // main runs a start the user asked for in the folder (spawn.cjs makeChild), so nothing extra goes
    assert.deepEqual(calls.splice(0), [
      ['task', 'w1', 'start'],
      ['task', 'w2', 'start'],
    ]);
    const third = v.host.querySelectorAll('.suggest-row')[2];
    assert.equal((third.querySelector('.suggest-row-actions .primary') as HTMLButtonElement).disabled, true);
    await show({ w1: proposal({ title: 'One' }), w2: proposal({ title: 'Two' }), w3: proposal({ title: 'Three' }) });
    await click(third.querySelector('.suggest-row-actions .primary'));
    await flush();
    assert.deepEqual(calls.splice(0), [['task', 'w3', 'start']], 'confirmation restores the pending card action');
    await v.unmount();
    // a repo with no commits keeps the switch, off, and says why
    store.set({ threads: { top: { cwd: '/empty' } } });
    const e = await render(h(TurnSuggestions, { calls: [call('w1', 'One')], threadId: 'top' }));
    await flush();
    assert.equal(text(e.host.querySelector('.suggest-row-place')), PLACE.folder);
    await click(e.host.querySelector('.suggest-row-place.link'));
    const box = e.host.querySelector('.start-options input') as HTMLInputElement;
    assert.deepEqual([box.checked, box.disabled], [false, true]);
    assert.equal((box.closest('label') as HTMLElement).title, `Worktree unavailable: ${NO_COMMITS}`);
    assert.ok(box.closest('label')!.classList.contains('disabled'));
    await click([...e.host.querySelectorAll('.suggest-row-actions button')].find((b) => b.textContent === 'Start')!);
    await flush();
    assert.deepEqual(calls.splice(0), [['task', 'w1', 'start']]);
    await e.unmount();
    // nothing to choose: a read-only chat, or a card with only forks, reads no folder
    loads.length = 0;
    const ro = await render(h(TurnSuggestions, { calls: [call('w1', 'One')], threadId: 'top', readOnly: true }));
    await show({ f1: proposal({ title: 'Fork', place: 'fork' }) });
    const fork = await render(h(TurnSuggestions, { calls: [call('f1', 'Fork')], threadId: 'top' }));
    // nor a chat this window hasn't loaded, whose folder it doesn't know
    await show({ f1: proposal({ title: 'Fork', place: 'fork' }), u1: proposal({ title: 'Unknown', parentId: 'gone' }) });
    const gone = await render(h(TurnSuggestions, { calls: [call('u1', 'Unknown')], threadId: 'gone' }));
    await flush();
    assert.deepEqual(loads, []);
    assert.equal(text(gone.host.querySelector('.suggest-row-place')), PLACE.worktree, 'as proposed: main checks at Start');
    await gone.unmount();
    await ro.unmount();
    await fork.unmount();
  } finally {
    store.set({ threads: { top: { cwd: '/repo' } } });
  }
});
