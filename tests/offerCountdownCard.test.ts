// src/components/thread/SuggestionCard.tsx with OfferCountdown.tsx: a waiting offer's card draws main's countdown to
// "New session" (the seconds under its title and that answer filling), holds it when the user takes the card in hand
// (its start options, "Don't ask again"), and shows the start main made for a user who did not answer.
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
let notify: (v: any) => void = () => {};
/** the card action main refuses, and with what */
let refuse: { action: string; error: Error } | null = null;
stubStore(
  {
    useStore: store.useStore,
    openInSplit: () => {},
    chatKind: () => 'codex',
    giveBackToComposer: () => {},
    navigate: () => {},
    toast: (...a: any[]) => calls.push(['toast', ...a]),
    sendOrDraft: async () => undefined,
  },
  { 'src/store/core.ts': { setPrefs: (p: any) => calls.push(['prefs', p]) } },
);
// the harnesses and settings a card's start options offer
mock.module('../src/session/harness/select.ts', {
  namedExports: { useHarnessModels: () => [], useEffectiveSelection: () => ({ model: null }) },
});
mock.module('../src/lib/flags.ts', { namedExports: { useEnabledHarnesses: () => ['codex', 'claude'] } });
mock.module('../src/session/useChatRowState.ts', {
  namedExports: { useChatRowState: () => ({ state: 'working' }), useChatTurn: () => 'idle', retryChatState: async () => {} },
});
installNativeStub({
  git: { branches: async () => ({ current: 'main', default: 'main', branches: ['main'], commits: true }) },
  orchestration: {
    snapshot: async () => ({ children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} }),
    onChanged: (cb: any) => ((notify = cb), () => {}),
    task: async (id: string, action: string) => {
      calls.push(['task', id, action]);
      if (refuse?.action === action) throw refuse.error;
      return undefined;
    },
  },
});
mock.module('../src/components/ui/Popover.tsx', {
  namedExports: { Popover: (p: any) => (p.open ? h('div', { 'data-popover': p.placement }, p.children) : null) },
});
const { TurnSuggestions } = await import('../src/components/thread/SuggestionCard.tsx');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const proposal = (o: any = {}) => ({
  parentId: 'top',
  kind: 'own_initiative',
  title: 'T',
  prompt: 'The brief',
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

test('a waiting offer shows main’s countdown to "New session", and taking the card in hand holds it', async () => {
  calls.length = 0;
  const now = Date.now();
  const counting = (o: any = {}) =>
    proposal({ kind: 'offer', title: 'Docs', waiting: true, place: 'folder', countdown: { from: now - 10_000, at: now + 50_000 }, ...o });
  // the window reads main's view once it is first used, then follows what main publishes
  const v = await render(h(TurnSuggestions, { calls: [call(null, 'Docs', true)], threadId: 'top' }));
  await flush();
  await show({ c1: counting() });
  const note = () => v.host.querySelector('.suggest-row-countdown');
  const here = () => buttons(v.host)[0];
  const fresh = () => buttons(v.host)[1];
  // the seconds under the title, and "New session" filling from where main's countdown is
  assert.match(text(note()), /^Starting a new session in (50|49)s$/);
  assert.equal(note()!.getAttribute('role'), 'timer');
  assert.ok(fresh().classList.contains('offer-countdown-fill'));
  assert.ok(fresh().classList.contains('primary'), 'still the primary answer');
  assert.equal(fresh().style.getPropertyValue('--offer-countdown'), '60000ms');
  assert.match(fresh().style.getPropertyValue('--offer-countdown-ran'), /^-1\d{4}ms$/);
  assert.equal(fresh().getAttribute('aria-describedby'), note()!.id, 'the answer says what happens without one');
  assert.ok(!here().classList.contains('offer-countdown-fill'), '"Do it here" does not fill');
  assert.equal(here().getAttribute('aria-describedby'), null);
  assert.deepEqual(labels(v.host), ['Do it here Esc', 'New session ⌘↵'], 'the answers read as before');
  // opening where it starts takes the card in hand: main holds the countdown; closing the options holds nothing more
  const options = v.host.querySelector('.suggest-row-place.link') as HTMLButtonElement;
  await click(options);
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 'c1', 'hold']]);
  await click(options);
  assert.deepEqual(calls.splice(0), []);
  // main's view, once it held it: no countdown is drawn
  await show({ c1: counting({ countdown: null }) });
  assert.equal(note(), null);
  assert.ok(!fresh().classList.contains('offer-countdown-fill'));
  assert.equal(fresh().getAttribute('style'), null);
  assert.equal(fresh().getAttribute('aria-describedby'), null);
  // with nothing counting, the options hold nothing
  await click(options);
  await click(options);
  await flush();
  assert.deepEqual(calls.splice(0), []);
  // "Don't ask again" takes it in hand too; the seconds stay until main took the hold, as main still counts till then
  await show({ c1: counting() });
  await click(v.host.querySelector('.suggest-head-link'));
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 'c1', 'hold']]);
  assert.match(text(note()), /^Starting a new session in \d+s$/);
  assert.deepEqual(labels(v.host), ['Cancel', 'Always do it here', 'Always start a new session']);
  await show({ c1: counting({ countdown: null }) });
  assert.equal(note(), null);
  await click(buttons(v.host)[0]);
  // a hold main refuses (the countdown already answered) is no news: the card follows main's view
  await show({ c1: counting() });
  refuse = { action: 'hold', error: new Error('That proposal is declined') };
  await click(options);
  await flush();
  refuse = null;
  assert.deepEqual(calls.splice(0), [['task', 'c1', 'hold']], 'no toast');
  // nobody answered: main started a new session for the user (its first publish, while the call still waits), and the
  // row says so until the call's answer replaces the card
  await show({ c1: counting({ status: 'starting', countdown: null }) });
  assert.equal(text(v.host.querySelector('.suggest-row-status-label')), 'Starting…');
  assert.equal(note(), null, 'an answered offer counts no more');
  // a screen reader hears what the row says
  assert.equal(text(v.host.querySelector('[aria-live]')), 'Docs: Starting…');
  await v.unmount();
  // a "Don't ask again" with nothing counting holds nothing
  await show({ c2: proposal({ kind: 'offer', title: 'Plain', waiting: true, place: 'folder' }) });
  const plain = await render(h(TurnSuggestions, { calls: [call(null, 'Plain', true)], threadId: 'top' }));
  await click(plain.host.querySelector('.suggest-head-link'));
  await flush();
  assert.deepEqual(calls.splice(0), []);
  await plain.unmount();
  // a read-only chat shows no countdown and holds nothing
  await show({ c1: counting() });
  const ro = await render(h(TurnSuggestions, { calls: [call(null, 'Docs', true)], threadId: 'top', readOnly: true }));
  assert.equal(ro.host.querySelector('.suggest-row-countdown'), null);
  await ro.unmount();
});

test('typing a reply in the chat’s composer while the card counts holds it once; a draft already there does not', async () => {
  calls.length = 0;
  const now = Date.now();
  const counting = (o: any = {}) =>
    proposal({ kind: 'offer', title: 'Docs', waiting: true, place: 'folder', countdown: { from: now, at: now + 60_000 }, ...o });
  const type = (text: string) => act(async () => store.setState({ drafts: { top: { text, attachments: [] } } }));
  // a draft left from before the card appeared is not a reply to it
  await type('an old draft');
  const v = await render(h(TurnSuggestions, { calls: [call(null, 'Docs', true)], threadId: 'top' }));
  await flush();
  await show({ d1: counting() });
  await type('an old draft');
  assert.deepEqual(calls.splice(0), []);
  // the user writes: main holds the countdown, once however many keys follow
  await type('wait,');
  await type('wait, do X first');
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 'd1', 'hold']]);
  // a new countdown (the next offer) is watched afresh from its own start
  await show({
    d1: counting({ status: 'declined', countdown: null }),
    d2: counting({ title: 'Tests', countdown: { from: now, at: now + 61_000 } }),
  });
  const next = await render(h(TurnSuggestions, { calls: [call(null, 'Tests', true)], threadId: 'top' }));
  await flush();
  await type('wait, do X first');
  assert.deepEqual(calls.splice(0), []);
  await type('wait, do X first, then Y');
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 'd2', 'hold']]);
  // a card that doesn't count leaves the draft alone
  await show({ d2: counting({ title: 'Tests', countdown: null }) });
  await type('more');
  await flush();
  assert.deepEqual(calls.splice(0), []);
  await next.unmount();
  await v.unmount();
  await type('');
});
