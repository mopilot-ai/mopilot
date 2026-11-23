// The Chats page: chats by state with Quiet folded, a card per computer, the search circle, and Settings / MoMo / Scheduled from the drawer, pushed over the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText, openComputer } from './support/phone/component-kit';
import { scripted, fakeMedia } from './support/phone/m3';
import { fakeCache, hello } from './support/phone/momo-kit';
import { BY_STATE } from './support/phone/home-layout';
const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u', name: 'Dana' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
  selectedPair: 'p',
  error: null,
};
const chats = [
  { id: 'c1', title: 'Fix login', state: 'waiting', harness: 'claude', project: 'App' },
  { id: 'c2', title: 'Write docs', state: 'running', harness: 'codex', project: 'App' },
  { id: 'c3', title: 'Plan release', state: 'idle', unread: true, harness: 'acp:gemini-cli', project: null },
];

async function mount(handler: (m: string) => unknown = () => undefined, snap: any = online, props: any = {}) {
  const s = scripted((m) => (m === 'chats.recent' ? { chats } : handler(m)), snap);
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE, ...props })));
  await flush();
  return {
    host,
    s,
    text: () => host.textContent!,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
/** What the drawer offers of Settings and MoMo: it is opened and closed again to read it; none without a drawer. */
const bar = async (host: HTMLElement) => {
  const menu = host.querySelector('button[aria-label="Open menu"]') as HTMLElement | null;
  if (!menu) return [];
  await act(async () => menu.click());
  await flush();
  const found = [...host.querySelectorAll('button')]
    .map((b) => b.getAttribute('aria-label'))
    .filter((label) => label === 'MoMo' || label === 'Settings');
  await act(async () => (host.querySelector('button[aria-label="Close menu"]') as HTMLElement).click());
  await flush();
  return found;
};
const stack = (host: HTMLElement) => host.querySelector('[data-stack]')?.getAttribute('data-stack');
const rows = (host: HTMLElement) => [...host.querySelectorAll('button[aria-label^="Open chat"]')].map((b) => b.getAttribute('aria-label'));

test('chats show by state with the computer’s card at the bottom, a waiting one in place with the amber hand', async () => {
  const v = await mount();
  assert.doesNotMatch(v.text(), /Computers/, 'no Computers header: the computers are cards');
  assert.ok(
    v.host.querySelector('button[aria-label="Studio Mac, Connected, 1 need input"]'),
    'the Mac’s card names it, its link and the chats that need input',
  );
  assert.match(
    v.text(),
    /Needs input.*Fix login.*Write docs.*Plan release.*Studio Mac/,
    'Needs input first, then the active chats, the cards last',
  );
  assert.doesNotMatch(v.text(), /Running|Quiet/, 'the active chats sit under no header, and nothing is quiet');
  const row = v.host.querySelector('button[aria-label="Open chat Fix login"]')!;
  assert.equal(row.getAttribute('aria-valuetext'), 'Needs you, Claude Code', 'a screen reader hears the state and the agent');
  assert.deepEqual(rows(v.host), ['Open chat Fix login', 'Open chat Write docs', 'Open chat Plan release']);
  assert.match(v.text(), /Fix loginApp · Waiting for you/, 'the project is named on the row’s grey line');
  assert.match(v.text(), /Write docsApp · Working/);
  assert.match(v.text(), /Plan releaseDone/);
  assert.equal(v.host.querySelector('button[aria-label="Open chat Plan release"]')?.getAttribute('aria-valuetext'), 'Done, Gemini cli');
  await v.done();
});

test('idle chats are not folded away: after Needs input every other chat is one list, in the order the computer listed them', async () => {
  const idle = { id: 'c4', title: 'Old idea', state: 'idle', harness: 'claude', project: 'App' };
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [...chats, idle] } : undefined), online);
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE })));
  await flush();
  assert.match(host.textContent!, /Needs input.*Fix login.*Write docs.*Plan release.*Old idea.*Studio Mac/);
  assert.deepEqual(
    rows(host),
    ['Open chat Fix login', 'Open chat Write docs', 'Open chat Plan release', 'Open chat Old idea'],
    'the idle one is in the list',
  );
  assert.equal(host.querySelector('button[aria-label^="Quiet"]'), null, 'there is no Quiet fold');
  assert.doesNotMatch(host.textContent!, /Quiet/);
  assert.match(host.textContent!, /Old ideaApp/);
  await act(async () => root.unmount());
  host.remove();
});

test('the search circle opens a search that narrows the list across projects, says when nothing matches, and clears when closed', async () => {
  const v = await mount();
  assert.equal(v.host.querySelector('input[placeholder="Search chats"]'), null, 'the search field waits behind its circle');
  await click('Search chats');
  await inputText('Search chats', 'docs');
  assert.deepEqual(rows(v.host), ['Open chat Write docs']);
  await inputText('Search chats', 'zzz');
  assert.match(v.text(), /No chat matches “zzz”/);
  await inputText('Search chats', 'login');
  assert.deepEqual(rows(v.host), ['Open chat Fix login'], 'a waiting chat matches like any other');
  await click('Close search');
  assert.equal(v.host.querySelector('input[placeholder="Search chats"]'), null);
  assert.equal(rows(v.host).length, 3, 'closing the search shows every chat again');
  await click('Search chats');
  assert.equal((v.host.querySelector('input[placeholder="Search chats"]') as HTMLInputElement).value, '', 'it opens empty again');
  await v.done();
});

test('chats of no project are listed on their own, with no "No project" header and no project line', async () => {
  const chats = [
    { id: 'x', title: 'Solo' },
    { id: 'y', title: 'Duo', project: null },
  ];
  const s = scripted((m) => (m === 'chats.recent' ? { chats } : undefined), online);
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE })));
  await flush();
  assert.doesNotMatch(host.textContent!, /No project/, 'no header, and no project to name on the row');
  assert.deepEqual(rows(host), ['Open chat Solo', 'Open chat Duo']);
  assert.equal(
    s.calls.some(([m]) => m === 'projects.list'),
    false,
    'the project is named in the chat list, so there is nothing else to ask',
  );
  await act(async () => root.unmount());
  host.remove();
});

test('the list says so when there are no chats, they cannot be read, or they are still loading', async () => {
  const none = scripted((m) => (m === 'chats.recent' ? { chats: [] } : undefined), online);
  const lazy = scripted((m) => (m === 'chats.recent' ? new Promise(() => {}) : undefined), online);
  const broken = scripted((m) => (m === 'chats.recent' ? Promise.reject(new Error('Mac said no')) : undefined), online);
  const out: string[] = [];
  for (const s of [none, lazy, broken]) {
    s.runtime.start = async () => {};
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE })));
    await flush();
    out.push(host.textContent!);
    await act(async () => root.unmount());
    host.remove();
  }
  assert.match(out[0], /No recent chats on this computer/);
  assert.match(out[1], /Loading chats…/);
  assert.match(out[2], /Could not load chats\. Pull down to try again\./);
});

test('the Mac’s card names it and its link, Asleep or Offline when it is away', async () => {
  const here = await mount(() => undefined, { ...online, presence: { p: { state: 'online', lastSeen: Date.now() } } });
  assert.ok(here.host.querySelector('button[aria-label="Studio Mac, Connected, 1 need input"]'));
  await here.done();
  for (const [state, word] of [
    ['sleeping', 'Asleep'],
    ['gone', 'Offline'],
  ]) {
    const away = await mount(() => undefined, { ...online, presence: { p: { state, lastSeen: Date.now() - 120_000 } } });
    assert.ok(away.host.querySelector(`button[aria-label="Studio Mac, ${word}, 1 need input"]`), state);
    await away.done();
  }
});

test('a connection that is online before any computer is selected still draws the card, for the first paired computer', async () => {
  // hello can land before the selection (the race in #3248): there is no presence to read, and the card must not throw
  const none = await mount(() => undefined, { ...online, selectedPair: null, presence: {} });
  assert.ok(none.host.querySelector('button[aria-label^="Studio Mac, Offline"]'), 'not called connected before it is selected');
  await none.done();
});

test('New session is offered with media only, and the computer’s card opens Settings', async () => {
  const bare = await mount();
  assert.equal(bare.host.querySelector('button[aria-label="New session"]'), null);
  await click('Studio Mac');
  assert.match(bare.text(), /DanaMoPilot account/);
  await bare.done();
  const withMedia = await mount(() => undefined, online, { media: fakeMedia().media });
  await click('New session');
  // New chat is a sheet over the list, which stays under it
  assert.equal(withMedia.host.querySelector('[data-screen="newChat"]')?.getAttribute('data-presentation'), 'modal');
  await withMedia.done();
});

test('the drawer opens Settings as a sheet, a swipe back returns to the list, and a chat has no drawer button of its own', async () => {
  const v = await mount();
  assert.deepEqual(await bar(v.host), ['Settings'], 'MoMo is not offered without MoMo wiring');
  await click('Settings');
  assert.equal(stack(v.host), 'home settings');
  assert.match(v.text(), /DanaMoPilot account/);
  await click('Swipe back');
  assert.equal(stack(v.host), 'home');
  await click('Open chat Write docs');
  assert.equal(stack(v.host), 'home chat:c2');
  assert.equal(v.host.querySelector('[data-screen="chat:c2"] button[aria-label="Open menu"]'), null, 'a chat has no drawer button');
  await click('Swipe back');
  assert.equal(stack(v.host), 'home', 'a swipe back closes the chat');
  await v.done();
});

test('an invited account gets MoMo in the drawer; an uninvited one, a signed-out one and one with a pairing form open get none', async () => {
  const invited = await mount((m) => (m === 'machine.hello' ? hello(true) : undefined), online, {
    momo: { cache: Promise.resolve(fakeCache()) },
  });
  assert.deepEqual(await bar(invited.host), ['MoMo', 'Settings']);
  await click('MoMo');
  assert.equal(stack(invited.host), 'home momo');
  await click('Swipe back');
  assert.equal(stack(invited.host), 'home');
  await invited.done();

  const outsider = await mount((m) => (m === 'machine.hello' ? hello(false) : undefined), online, {
    momo: { cache: Promise.resolve(null) },
  });
  assert.deepEqual(await bar(outsider.host), ['Settings']);
  await outsider.done();

  const out = await mount(() => undefined, { phase: 'signedOut', generation: 1, user: null, pairs: [], selectedPair: null, error: null });
  assert.deepEqual(await bar(out.host), []);
  await out.done();

  const offline = await mount(() => undefined, { ...online, phase: 'offline', selectedPair: null });
  // with a Mac paired but away the page keeps its shape: another computer is added from Settings
  await click('Settings');
  await click('Add a computer');
  assert.equal(stack(offline.host), 'home pairing', 'the pairing form is pushed, with its own Back');
  await offline.done();
});

test('a waiting row opens its quick review, then its chat; New session waits while the app is busy, with the pull showing it', async () => {
  let release = () => {};
  const v = await mount(() => undefined, online, { media: fakeMedia().media });
  v.s.runtime.connect = () => new Promise<void>((resolve) => (release = resolve));
  await click('Settings');
  await openComputer();
  await click('Reconnect');
  await click('Swipe back');
  assert.equal(v.host.querySelector('button[aria-label="Refreshing"]'), null, 'another action holding the screen is not a refresh');
  const disabled = (label: string) => (v.host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).disabled;
  assert.equal(disabled('New session'), true);
  await act(async () => release());
  await flush();
  assert.ok(v.host.querySelector('button[aria-label="Pull to refresh"]'));
  assert.equal(disabled('New session'), false);
  await click('Open chat Fix login');
  await click('Open chat');
  assert.equal(stack(v.host), 'home chat:c1', 'the chat opened');
  await v.done();
});

test('MoMo stays in the drawer while the computer is away, and goes with the account', async () => {
  const s = scripted((m) => (m === 'chats.recent' ? { chats } : m === 'machine.hello' ? hello(true) : undefined), online);
  s.runtime.start = async () => {};
  const subscribers = new Set<() => void>();
  s.runtime.subscribe = (f: () => void) => (subscribers.add(f), () => subscribers.delete(f));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE, momo: { cache: Promise.resolve(fakeCache()) } })),
  );
  await flush();
  const move = async (snap: any) => {
    s.state.snap = snap;
    await act(async () => subscribers.forEach((f) => f()));
    await flush();
  };
  assert.deepEqual(await bar(host), ['MoMo', 'Settings']);
  await move({ ...online, phase: 'offline', generation: 2, selectedPair: null });
  assert.deepEqual(await bar(host), ['MoMo', 'Settings'], 'a dropped connection does not take MoMo away');
  await move({ ...online, user: { id: 'other' }, phase: 'offline', generation: 3, selectedPair: null });
  assert.deepEqual(await bar(host), ['Settings'], 'another account has to be asked first');
  await move({ ...online, user: null, phase: 'signedOut', generation: 4, selectedPair: null, pairs: [] });
  assert.equal((await bar(host)).length, 0);
  await act(async () => root.unmount());
  host.remove();
});

test('unsent messages are listed on the home screen while online, so a failed one can be cancelled', async () => {
  const outbox = [
    { id: 'o1', pairId: 'p', chatId: 'gone', text: 'left behind', attachments: [], at: 1, status: 'failed', error: 'Mac said no' },
  ];
  const v = await mount(() => undefined, { ...online, outbox });
  assert.match(v.text(), /Unsent messages/);
  assert.match(v.text(), /left behind/);
  const sent: string[] = [];
  v.s.runtime.cancelSend = (id: string) => void sent.push(`cancel:${id}`);
  v.s.runtime.retrySend = (id: string) => void sent.push(`retry:${id}`);
  await click('Retry sending');
  await click('Cancel this message');
  assert.deepEqual(sent, ['retry:o1', 'cancel:o1']);
  await v.done();
});

test('two projects of one name are each named on their chat’s row, the second numbered where the Mac sends no hint', async () => {
  const twins = [
    { id: 't1', title: 'First app chat', project: 'app', projectId: 'a1' },
    { id: 't2', title: 'Second app chat', project: 'app', projectId: 'a2' },
  ];
  const s = scripted((m) => (m === 'chats.recent' ? { chats: twins } : undefined), online);
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE })));
  await flush();
  assert.deepEqual(rows(host), ['Open chat First app chat', 'Open chat Second app chat']);
  assert.match(
    host.textContent!,
    /First app chatapp▭.*Second app chatapp \(2\)/,
    'each row names its project on its grey line, and which of the two it is',
  );
  await act(async () => root.unmount());
  host.remove();
});

test('a waiting chat of no project says only that it waits', async () => {
  const mixed = [
    { id: 'w', title: 'Loose end', state: 'waiting', harness: 'codex', project: null },
    { id: 'd1', title: 'Docs one', project: 'Docs', projectId: 'd' },
  ];
  const s = scripted((m) => (m === 'chats.recent' ? { chats: mixed } : undefined), online);
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, homeLayout: BY_STATE })));
  await flush();
  assert.match(host.textContent!, /Loose endWaiting for you▭/);
  await act(async () => root.unmount());
  host.remove();
});

test('an open chat names itself in its bar from the list: its title, its agent and its project', async () => {
  const v = await mount();
  await click('Open chat Fix login');
  await click('Open chat');
  assert.match(v.text(), /Fix login/);
  assert.match(v.text(), /Claude Code · App/);
  await click('Back to chats');
  await click('Open chat Plan release');
  assert.match(v.text(), /Gemini cli/, 'a chat with no project names only its agent');
  assert.doesNotMatch(v.text(), /Gemini cli ·/);
  await v.done();
});

test('the chat’s ⋯ menu pushes Changes and Terminal over the chat, each with a way back', async () => {
  const v = await mount((m) => (m === 'diff.list' ? { files: [] } : undefined));
  await click('Open chat Fix login');
  await click('Open chat');
  assert.equal(v.host.querySelector('[role="tab"]'), null, 'no segmented control in the chat bar');
  await click('Chat menu');
  assert.deepEqual(
    [...v.host.querySelectorAll('[data-menu="Chat menu"] [role="menuitem"]')].map((n) => n.getAttribute('aria-label')),
    ['Changes  None yet', 'Terminal', 'Permissions', 'Pin', 'Rename', 'Archive'],
  );
  await click('Chat menu');
  assert.equal(stack(v.host), 'home chat:c1', 'closing the menu opens nothing');
  for (const [label, key, back] of [
    ['Changes  None yet', 'review', 'Back to chat'],
    ['Terminal', 'terminal', 'Back to chat'],
  ]) {
    await click('Chat menu');
    await click(label);
    assert.equal(stack(v.host), `home chat:c1 ${key}:c1`);
    assert.match(v.text(), new RegExp(`${label.split(' ')[0]}Fix login`), 'the header names the screen and the chat under it');
    assert.equal(v.host.querySelector('button[aria-label="Chat menu"]'), null, 'a chat’s screen has no menu of its own');
    await click(back);
    assert.ok(v.host.querySelector('[aria-label="Message this chat"]'), `back in the chat from ${label}`);
  }
  await v.done();
});

test('a swipe back closes whichever screen is on top and lands one level down', async () => {
  const v = await mount((m) => (m === 'machine.hello' ? hello(true) : m === 'diff.list' ? { files: [] } : undefined), online, {
    media: fakeMedia().media,
    momo: { cache: Promise.resolve(fakeCache()) },
  });
  const back = async (expected: string) => {
    await click('Swipe back');
    assert.equal(stack(v.host), expected);
  };
  for (const [open, key] of [
    ['Settings', 'settings'],
    ['MoMo', 'momo'],
    ['New session', 'newChat'],
    ['Scheduled', 'scheduled'],
  ]) {
    await click(open);
    assert.equal(stack(v.host), `home ${key}`);
    await back('home');
  }
  await click('Open chat Write docs');
  for (const [open, key] of [
    ['Changes', 'review'],
    ['Terminal', 'terminal'],
  ]) {
    await click('Chat menu');
    await click(open);
    assert.equal(stack(v.host), `home chat:c2 ${key}:c2`);
    await back('home chat:c2');
  }
  await back('home');
  await v.done();
  const away = await mount(() => undefined, { ...online, phase: 'offline', selectedPair: null });
  await click('Settings');
  await click('Add a computer');
  await click('Swipe back');
  assert.equal(stack(away.host), 'home');
  await away.done();
});

test('the drawer’s New chat closes the drawer and opens the new chat sheet', async () => {
  const v = await mount(() => undefined, online, { media: fakeMedia().media });
  await click('Open menu');
  const drawerNew = v.host.querySelector('button[aria-label="Close menu"]')!.parentElement!.querySelector('button[aria-label="New chat"]');
  await act(async () => (drawerNew as HTMLElement).click());
  await flush();
  assert.equal(stack(v.host), 'home newChat');
  assert.equal(v.host.querySelector('button[aria-label="Close menu"]'), null, 'the drawer closed');
  await v.done();
});
