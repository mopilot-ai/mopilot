// MoMo's first run (src/components/momo/setup/MomoSetup.tsx, MeetStep.tsx, ProgressStep.tsx, runSetup.ts, mounted by MomoPage.tsx, #2607): nothing for an account MoMo isn't allowed for; for an invited one the MoMo page is Meet (name and color, the brain chosen for the user and only footnoted), Notifications, then Setting up, with no Skip; the real work applies the brain, reads memory, proposes the starter routines, marks setup done and has MoMo greet in its main chat (the first time only, best effort); its screen shows only if the work takes a moment, and a failure says why with Try again.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, byText, flush, fakeStore } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { readMomoPrefs, setMomoPref } = await import('../shared/momoPrefs.mjs');
const store = fakeStore<any>({ route: { name: 'momo' }, back: [], forward: [], prefs: {} });
const saves: any[] = [];
const toasts: string[] = [];
let refuse: string | null = null;
/** main's merge and its broadcast back to this window, or a refusal of one key */
const save = async (key: string, value: unknown) => {
  saves.push([key, value]);
  if (refuse === key) return false;
  const r = setMomoPref(store.getState().prefs.momo, key, value);
  if (!r.ok) throw new Error(r.error);
  act(() => store.setState({ prefs: { momo: r.momo } }));
  return true;
};
stubStore({
  useStore: store.useStore,
  navigate: (route: any) => store.setState({ route }),
  getState: () => store.getState(),
  setState: (p: any) => store.setState(p),
  toastFailure: (what: string) => (e: any) => toasts.push(`${what}: ${e.message}`),
  toast: (t: string, kind: string) => toasts.push(`${kind}: ${t}`),
});
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => readMomoPrefs(store.useStore((s: any) => s.prefs.momo)),
  saveMomoPref: save,
});
/** MoMo's main chat (#2183) and memory (#2159) as far as setup uses them. */
let chat: any;
let memory: any;
mockSource('src/lib/momoBridges.ts', { momoChatBridge: () => chat, momoMemoryBridge: () => memory });
let pushAccess: (a: boolean) => void = () => {};
let greet: () => Promise<boolean> = async () => true;
const greets: number[] = [];
installNativeStub({
  momo: {
    access: async () => false,
    onAccess: (cb: (a: boolean) => void) => ((pushAccess = cb), () => {}),
  },
  momoChat: { greet: () => (greets.push(1), greet()) },
});
// the brain's own tests are tests/momoBrainRowUI.test.ts; the Notifications screen's, tests/momoNotificationsStepUI.test.ts
let shown: any = { harness: 'claude', account: 'work', model: 'sonnet', modelLabel: 'Sonnet' };
let ready = true;
let allLimited = false;
mockSource('src/components/momo/setup/BrainRow.tsx', {
  useSetupBrain: () => ({ probes: h('i', { 'data-stub': 'probes' }), shown, allLimited, ready }),
  NoBrain: ({ allLimited: l }: any) => h('div', { 'data-stub': 'no-brain' }, l ? 'limited' : 'signed out'),
  brainText: (b: any) => `${b.harness}/${b.model}`,
});
let stepProps: any;
let stepClicks = 1;
mockSource('src/components/momo/setup/NotificationsStep.tsx', {
  NotificationsStep: (p: any) => (
    (stepProps = p),
    h(
      'div',
      { 'data-stub': 'notifications', 'data-busy': String(p.busy) },
      h(
        'button',
        {
          onClick: () => {
            for (let i = 0; i < stepClicks; i++) p.onDone();
          },
        },
        'Go on',
      ),
    )
  ),
});
mockSource('src/components/momo/MomoChatTab.tsx', {
  MomoChatTab: () => h('div', { role: 'tabpanel' }, 'chat'),
});
mockSource('src/components/momo/MemoryTab.tsx', { MemoryTab: () => h('div', null, 'memory') });
const { MomoRoute } = await import('../src/components/momo/MomoRoute.tsx');
const { SHOW_AFTER_MS } = await import('../src/components/momo/setup/ProgressStep.tsx');
const App = () => h(MomoRoute, { route: store.useStore((s: any) => s.route) });
const title = (host: HTMLElement) => host.querySelector('.momo-setup-title')?.textContent;
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** The MoMo page once MoMo is allowed (an account it isn't allowed for is sent back to a new chat), on setup. */
async function mount() {
  const r = await render(h(App));
  await flush();
  await act(async () => pushAccess(true));
  await act(async () => store.setState({ route: { name: 'momo' } }));
  await waitFor(() => title(r.host), 'the setup title', { step: flush }).catch(() => {});
  return r;
}
const sets: any[] = [];
const files: number[] = [];
const reset = () => {
  saves.length = 0;
  toasts.length = 0;
  sets.length = 0;
  files.length = 0;
  greets.length = 0;
  greet = async () => true;
  refuse = null;
  shown = { harness: 'claude', account: 'work', model: 'sonnet', modelLabel: 'Sonnet' };
  ready = true;
  allLimited = false;
  stepClicks = 1;
  chat = { setBrain: async (b: any) => (sets.push(b), { brain: b, chatId: 'c', applied: 'now', warning: null }) };
  memory = { files: async () => (files.push(1), { ok: true, persona: '' }) };
  act(() => store.setState({ route: { name: 'momo' }, prefs: {} }));
};
const input = (host: HTMLElement) => host.querySelector<HTMLInputElement>('#momo-name')!;
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

test('not allowed: no setup and no page; invited: Meet, with the name, five colors and Continue, the brain only in a footnote, and no way to skip', async () => {
  reset();
  const { host, unmount } = await render(h(App));
  await flush();
  assert.equal(host.innerHTML, '', 'an account MoMo is not allowed for sees nothing');
  assert.deepEqual(store.getState().route, { name: 'home' }, 'and the window goes back to a new chat');
  await act(async () => pushAccess(true));
  await act(async () => store.setState({ route: { name: 'momo' } }));
  await waitFor(() => title(host), 'the setup title', { step: flush }).catch(() => {});
  assert.equal(title(host), 'Meet MoMo');
  assert.equal(
    host.querySelector('.momo-setup-lead')!.textContent,
    'Your personal agent. It remembers what matters to you and helps with your day.',
  );
  assert.ok(host.querySelector('[data-stub=probes]'));
  assert.equal(input(host).value, 'MoMo');
  assert.equal(host.querySelector('label[for=momo-name]')!.textContent, 'Name');
  assert.deepEqual(
    [...host.querySelectorAll('[role=radio]')].map((b) => b.getAttribute('aria-label')),
    ['Clay', 'Blue', 'Green', 'Violet', 'Ink'],
  );
  assert.equal(host.querySelector('[role=radio][aria-checked=true]')!.getAttribute('aria-label'), 'Clay');
  assert.deepEqual(
    [...host.querySelectorAll('.momo-setup button:not([role=radio])')].map((b) => b.textContent),
    ['Continue'],
    'no Skip setup, no brain picker',
  );
  assert.equal(host.querySelector('.momo-setup-note')!.textContent, 'Thinks with claude/sonnet. You can change this in Settings.');
  assert.equal(host.querySelector('section')?.getAttribute('aria-labelledby'), 'momo-meet-title');
  assert.equal(host.querySelector('main'), null, 'the app has the main landmark');
  assert.deepEqual(saves, [], 'nothing saved by looking');
  await unmount();
});

test('Meet: the name and color show as they are tried and are saved by Continue, only what changed; an empty name is MoMo', async () => {
  reset();
  const { host, unmount } = await mount();
  await type(input(host), 'Pip');
  assert.equal(title(host), 'Meet Pip');
  await click(host.querySelector('[role=radio][aria-label=Blue]'));
  assert.equal(host.querySelector('[role=radio][aria-checked=true]')!.getAttribute('aria-label'), 'Blue');
  assert.equal(
    host.querySelector<HTMLElement>('.momo-orb-wrap')!.style.getPropertyValue('--orb'),
    'var(--momo-blue)',
    'the dot is in the color',
  );
  assert.deepEqual(saves, [], 'trying is not saving');
  await click(byText(host, 'Continue'));
  await flush();
  assert.deepEqual(saves, [
    ['persona.name', 'Pip'],
    ['persona.color', 'blue'],
  ]);
  assert.ok(host.querySelector('[data-stub=notifications]'), 'then Notifications');
  await unmount();
  // unchanged: nothing to save; empty: MoMo's own name
  reset();
  const same = await mount();
  await click(byText(same.host, 'Continue'));
  assert.deepEqual(saves, []);
  assert.ok(same.host.querySelector('[data-stub=notifications]'));
  await same.unmount();
  reset();
  act(() => store.setState({ prefs: { momo: { persona: { name: 'Pip', color: 'ink' } } } }));
  const empty = await mount();
  assert.equal(input(empty.host).value, 'Pip', 'setup run again starts from what is saved');
  await type(input(empty.host), '   ');
  assert.equal(title(empty.host), 'Meet MoMo');
  await click(byText(empty.host, 'Continue'));
  await flush();
  assert.deepEqual(saves, [['persona.name', 'MoMo']]);
  await empty.unmount();
});

test('Meet: a refused save stays on Meet (the save told the user) and can be tried again; Enter continues; Continue waits for the brain', async () => {
  reset();
  refuse = 'persona.color';
  const { host, unmount } = await mount();
  await click(host.querySelector('[role=radio][aria-label=Green]'));
  await click(byText(host, 'Continue'));
  await flush();
  assert.equal(title(host), 'Meet MoMo');
  assert.equal((byText(host, 'Continue') as HTMLButtonElement).disabled, false);
  refuse = null;
  await act(async () => {
    input(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    input(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await flush();
  assert.ok(host.querySelector('[data-stub=notifications]'), 'Enter goes on');
  await unmount();
  reset();
  ready = false;
  const waiting = await mount();
  const go = byText(waiting.host, 'Continue') as HTMLButtonElement;
  assert.equal(go.disabled, true);
  assert.equal(go.getAttribute('aria-busy'), 'true');
  await act(async () => {
    input(waiting.host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.equal(title(waiting.host), 'Meet MoMo', 'Enter waits too');
  await waiting.unmount();
});

test('with no brain MoMo can run on, Meet says why instead of Continue', async () => {
  reset();
  shown = null;
  const { host, unmount } = await mount();
  assert.equal(host.querySelector('[data-stub=no-brain]')!.textContent, 'signed out');
  assert.equal(
    [...host.querySelectorAll('button')].some((b) => b.textContent === 'Continue'),
    false,
  );
  assert.equal(host.querySelector('.momo-setup-note'), null);
  await unmount();
  allLimited = true;
  const limited = await mount();
  assert.equal(limited.host.querySelector('[data-stub=no-brain]')!.textContent, 'limited');
  await limited.unmount();
  await flush();
});

test('a quick setup: the brain applied, memory read, the starter routines proposed, setup done, MoMo greets: straight to Chat, no screen in between', async () => {
  reset();
  chat.setBrain = async (b: any) => (sets.push(b), { brain: b, chatId: 'n', applied: 'newChat', warning: null });
  const { host, unmount } = await mount();
  await type(input(host), 'Pip');
  await click(byText(host, 'Continue'));
  await flush();
  await click(byText(host, 'Go on'));
  assert.equal(host.querySelector('.momo-progress'), null, 'it was done before the screen was due');
  await flush();
  assert.deepEqual(sets, [{ harness: 'claude', account: 'work', model: 'sonnet', modelLabel: 'Sonnet' }]);
  assert.equal(files.length, 1);
  assert.deepEqual(
    saves.map((s) => s[0]),
    ['persona.name', 'routines.starter', 'onboarding'],
  );
  // not the Morning briefing: the Morning brief replaces it
  assert.deepEqual(saves[1], ['routines.starter', ['weekAhead', 'bills']]);
  assert.deepEqual(saves[2], ['onboarding', { done: true, step: 0 }]);
  assert.equal(greets.length, 1, 'MoMo says hello once, after setup is done');
  assert.deepEqual(toasts, ['info: MoMo started a new chat on its new brain']);
  assert.equal(host.querySelector('[role=tabpanel]')?.textContent, 'chat');
  assert.equal(host.querySelector('.momo-setup'), null);
  await unmount();
});

test('meanwhile Notifications stays up with its buttons off, and a second press changes nothing', async () => {
  reset();
  let release: () => void = () => {};
  chat.setBrain = (b: any) =>
    new Promise((r) => (release = () => (sets.push(b), r({ brain: b, chatId: 'c', applied: 'now', warning: null }))));
  stepClicks = 2;
  const { host, unmount } = await mount();
  await click(byText(host, 'Continue'));
  await flush();
  await click(byText(host, 'Go on'));
  assert.equal(host.querySelector('[data-stub=notifications]')!.getAttribute('data-busy'), 'true');
  assert.equal(stepProps.busy, true);
  release();
  await flush();
  await flush();
  assert.equal(sets.length, 1, 'one run');
  assert.equal(saves.filter((s) => s[0] === 'onboarding').length, 1);
  await unmount();
});

test('a setup that takes a moment shows its screen with the steps as they finish', async () => {
  reset();
  let release: () => void = () => {};
  chat.setBrain = (b: any) => new Promise((r) => (release = () => r({ brain: b, chatId: 'c', applied: 'now', warning: null })));
  const { host, unmount } = await mount();
  await click(byText(host, 'Continue'));
  await click(byText(host, 'Go on'));
  await wait(SHOW_AFTER_MS + 100);
  assert.equal(title(host), 'Setting up MoMo');
  assert.equal(host.querySelector('[data-stub=notifications]'), null);
  const marks = () =>
    [...host.querySelectorAll('.momo-progress-steps li')].map((li) => `${li.getAttribute('data-mark')}:${li.textContent}`);
  assert.deepEqual(marks(), ['active:Picked a brain with room to think', 'waiting:Getting its memory ready', 'waiting:Almost done']);
  assert.equal(host.querySelector('.momo-orb-ring') !== null, true, 'ringed while it works');
  release();
  await flush();
  await flush();
  assert.equal(host.querySelector('[role=tabpanel]')?.textContent, 'chat');
  await unmount();
  // each step is marked done as the next starts
  reset();
  let memoryRelease: () => void = () => {};
  memory.files = () => new Promise((r) => (memoryRelease = () => r({ ok: true, persona: '' })));
  const slow = await mount();
  await click(byText(slow.host, 'Continue'));
  await click(byText(slow.host, 'Go on'));
  await wait(SHOW_AFTER_MS + 100);
  assert.deepEqual(
    [...slow.host.querySelectorAll('.momo-progress-steps li')].map((li) => li.getAttribute('data-mark')),
    ['done', 'active', 'waiting'],
  );
  assert.equal(slow.host.querySelectorAll('.momo-progress-steps li')[0].querySelector('svg') !== null, true, 'a check for a finished step');
  memoryRelease();
  await flush();
  await flush();
  await slow.unmount();
});

test('a step that fails says why with Try again, which runs it all once more; never held back by the 300 ms', async () => {
  reset();
  let attempts = 0;
  chat.setBrain = async (b: any) => {
    if (attempts++ === 0) throw new Error('That brain is gone.');
    return { brain: b, chatId: 'c', applied: 'now', warning: null };
  };
  const { host, unmount } = await mount();
  await click(byText(host, 'Continue'));
  await click(byText(host, 'Go on'));
  await flush();
  assert.equal(title(host), 'Couldn’t set up MoMo');
  assert.equal(host.querySelector('[role=alert]')!.textContent, 'That brain is gone.');
  assert.equal(host.querySelector('.momo-progress-steps'), null);
  assert.equal(host.querySelector('.momo-orb-ring'), null, 'no ring on a failure');
  assert.equal(
    saves.some((s) => s[0] === 'onboarding'),
    false,
    'setup stays open',
  );
  await click(byText(host, 'Try again'));
  await flush();
  await flush();
  assert.equal(host.querySelector('[role=tabpanel]')?.textContent, 'chat');
  await unmount();
});

test('memory that can’t be read and a save that is refused each stop there and can be tried again', async () => {
  reset();
  memory.files = async () => ({ ok: false, error: 'MoMo’s memory is locked.' });
  const { host, unmount } = await mount();
  await click(byText(host, 'Continue'));
  await click(byText(host, 'Go on'));
  await flush();
  assert.equal(host.querySelector('[role=alert]')!.textContent, 'MoMo’s memory is locked.');
  memory.files = async () => ({ ok: true, persona: '' });
  refuse = 'routines.starter';
  await click(byText(host, 'Try again'));
  await flush();
  assert.equal(host.querySelector('[role=alert]')!.textContent, "Couldn't save MoMo's settings.");
  refuse = 'onboarding';
  await click(byText(host, 'Try again'));
  await flush();
  assert.equal(host.querySelector('[role=alert]')!.textContent, "Couldn't save MoMo's settings.");
  assert.equal(title(host), 'Couldn’t set up MoMo');
  refuse = null;
  await click(byText(host, 'Try again'));
  await flush();
  await flush();
  assert.equal(host.querySelector('[role=tabpanel]')?.textContent, 'chat');
  await unmount();
});

test('no brain or bridges in this build: nothing is applied or read, the rest goes on; setup run again from Settings does not greet again', async () => {
  reset();
  chat = undefined;
  memory = undefined;
  const { host, unmount } = await mount();
  await click(byText(host, 'Continue'));
  await click(byText(host, 'Go on'));
  await flush();
  await flush();
  assert.deepEqual(
    saves.map((s) => s[0]),
    ['routines.starter', 'onboarding'],
  );
  assert.equal(host.querySelector('[role=tabpanel]')?.textContent, 'chat');
  await unmount();
  // opened again from Settings: its starter routines were proposed; a step an older build saved is still Meet
  reset();
  act(() =>
    store.setState({
      prefs: { momo: { routines: { starter: ['bills'] }, onboarding: { done: false, step: 2 } } },
    }),
  );
  const again = await mount();
  assert.equal(title(again.host), 'Meet MoMo');
  await click(byText(again.host, 'Continue'));
  await click(byText(again.host, 'Go on'));
  await flush();
  await flush();
  assert.deepEqual(
    saves.map((s) => s[0]),
    ['routines.starter', 'onboarding'],
    'the brain and the starters are saved again, the greeting is not',
  );
  assert.equal(sets.length, 1);
  assert.equal(greets.length, 0);
  await again.unmount();
  // setup with no brain to apply
  reset();
  shown = { harness: 'claude', account: null, model: null, modelLabel: null };
  const bare = await mount();
  assert.equal(bare.host.querySelector('.momo-setup-note')!.textContent, 'Thinks with claude/null. You can change this in Settings.');
  await bare.unmount();
});

test('leaving the page while setup works stops its timer', async () => {
  reset();
  chat.setBrain = () => new Promise(() => {});
  const { host, unmount } = await mount();
  await click(byText(host, 'Continue'));
  await click(byText(host, 'Go on'));
  await unmount();
  await wait(SHOW_AFTER_MS + 100);
});

test('a hello that fails is told, and setup stays done on the chat; a retry after a refused save still greets', async () => {
  reset();
  greet = async () => {
    throw new Error('no harness');
  };
  const { host, unmount } = await mount();
  await click(byText(host, 'Continue'));
  await click(byText(host, 'Go on'));
  await flush();
  await flush();
  assert.deepEqual(toasts, ["MoMo couldn't say hello: no harness"]);
  assert.deepEqual(saves.at(-1), ['onboarding', { done: true, step: 0 }]);
  assert.equal(host.querySelector('[role=tabpanel]')?.textContent, 'chat');
  await unmount();
  // a save that was refused leaves setup open, and the run that finally goes through still greets (first is read once)
  reset();
  refuse = 'onboarding';
  const retry = await mount();
  await click(byText(retry.host, 'Continue'));
  await click(byText(retry.host, 'Go on'));
  await flush();
  assert.equal(greets.length, 0, 'not before setup is done');
  refuse = null;
  await click(byText(retry.host, 'Try again'));
  await flush();
  await flush();
  assert.equal(greets.length, 1);
  await retry.unmount();
});
