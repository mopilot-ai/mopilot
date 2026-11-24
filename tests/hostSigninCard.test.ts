// The chat's machine sign-in card (src/components/composer/HostSigninCard.tsx) and its plain words (src/lib/hostSigninCopy.ts): shown only when the chat's agent is signed out on the chat's machine, it signs in from this Mac, shows the code, takes a code typed back, words a vendor's failure in one line with Details, offers an API key where Google ended the sign-in, and goes when the agent is ready.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import type { HostMachineRow } from '../src/lib/hostMachines.ts';
import type { HostSigninView } from '../src/lib/native/host.ts';

let allowed = true;
let machines: any[] = [];
let owner = 'mini';
let pick: { id: string } | null = null;
const toasts: unknown[][] = [];
const navigations: unknown[] = [];
mockSource('src/lib/host.ts', { useHostAccess: () => allowed });
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });
mockSource('src/lib/hostOwner.ts', { useChatOwner: () => ({ ownerId: owner, known: true, refresh: () => undefined }) });
mockSource('src/store/core.ts', {
  toast: (...a: unknown[]) => void toasts.push(a),
  useStore: (sel: (s: object) => unknown) => sel({}),
});
mockSource('src/store/projects.ts', { newChatHostPick: () => pick });
mockSource('src/store/panes.ts', { navigate: (to: unknown) => void navigations.push(to) });
let want: string | undefined;
let standIn: string | null = null;
mockSource('src/session/useHostAgentChoice.ts', {
  useHostAgentChoice: () => (want ? { want, choice: standIn ? { harness: standIn } : { harness: null } } : null),
});
const { createElement } = await import('react');
const { HostSigninCard } = await import('../src/components/composer/HostSigninCard.tsx');
const { signinStatus, ACTION_LABEL } = await import('../src/lib/hostSigninCopy.ts');

const machine = (state: string, o: object = {}): Partial<HostMachineRow> => ({
  id: 'mini',
  name: 'mac-mini-test',
  status: 'attention',
  note: 'gemini is not signed in on this machine.',
  agents: [
    { id: 'gemini', label: 'Gemini', state: state as any, reason: '' },
    { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
  ],
  ...o,
});
const view = (o: object = {}) =>
  ({
    hostId: 'mini',
    harness: 'gemini',
    state: 'waiting',
    codes: [],
    link: false,
    url: null,
    error: null,
    reason: null,
    ...o,
  }) as HostSigninView;
const card = () => $('.host-signin-card');
const button = () => $('.host-signin-card .host-signin-act');

test('the plain words: running, a code, done, expired, unreachable, no page, a known vendor failure and an unknown one', () => {
  assert.equal(signinStatus(undefined, 'Gemini'), null);
  assert.deepEqual(signinStatus(view({ state: 'starting' }), 'Gemini'), { text: 'Opening the sign-in page…', action: 'cancel' });
  assert.deepEqual(signinStatus(view(), 'Gemini'), { text: 'Opening the sign-in page…', action: 'cancel' });
  assert.deepEqual(signinStatus(view({ link: true }), 'Gemini'), { text: 'Finish signing in in your browser', action: 'cancel' });
  assert.deepEqual(signinStatus(view({ codes: ['ABCD-1234', 'X'] }), 'Gemini'), {
    text: 'Enter this code in the page that opened',
    code: 'ABCD-1234',
    action: 'cancel',
  });
  assert.deepEqual(signinStatus(view({ state: 'signed-in' }), 'Gemini'), { text: 'Signed in' });
  assert.equal(signinStatus(view({ state: 'cancelled' }), 'Gemini'), null);
  assert.deepEqual(signinStatus(view({ state: 'expired' }), 'Gemini'), { text: 'That code expired', action: 'retry' });
  assert.deepEqual(signinStatus(view({ state: 'unreachable' }), 'Gemini'), { text: "Couldn't reach the machine", action: 'retry' });
  assert.deepEqual(signinStatus(view({ state: 'unreachable', error: 'ssh: timeout' }), 'Gemini'), {
    text: "Couldn't reach the machine",
    action: 'retry',
    details: 'ssh: timeout',
  });
  assert.deepEqual(signinStatus(view({ state: 'failed', reason: 'no_page', error: 'x' }), 'Grok'), {
    text: "Grok didn't open a sign-in page",
    action: 'retry',
  });
  const google =
    'This client is no longer supported for Gemini Code Assist for individuals. To continue, migrate to the Antigravity suite of products: https://antigravity.google';
  assert.deepEqual(signinStatus(view({ state: 'failed', error: google }), 'Gemini'), {
    text: 'Google ended this sign-in for personal accounts',
    action: 'api-key',
    details: google,
  });
  assert.deepEqual(signinStatus(view({ state: 'failed', error: 'Something odd happened in the vendor CLI.' }), 'Kimi Code'), {
    text: "Couldn't sign in to Kimi Code",
    action: 'retry',
    details: 'Something odd happened in the vendor CLI.',
  });
  assert.deepEqual(signinStatus(view({ state: 'failed' }), 'Kimi Code'), { text: "Couldn't sign in to Kimi Code", action: 'retry' });
  assert.deepEqual(ACTION_LABEL, { retry: 'Try again', 'api-key': 'Use an API key', cancel: 'Cancel' });
});

test('only when needed: this Mac, a ready agent, an offline machine, another agent, no Host access or no machine show nothing', async () => {
  installNative(fakeNative());
  const none = async (props: object, setup: () => void) => {
    setup();
    const m = await mount(createElement(HostSigninCard, { threadId: 'c1', agent: 'gemini', ...props }));
    try {
      assert.equal(card(), null);
    } finally {
      await m.unmount();
    }
  };
  await none({}, () => ((owner = 'local'), (machines = [machine('signin', { id: 'local' })])));
  await none({}, () => ((owner = 'mini'), (machines = [machine('ready')])));
  await none({}, () => (machines = [machine('signin', { status: 'offline' })]));
  await none({ agent: 'claude' }, () => (machines = [machine('signin')]));
  await none({ agent: null }, () => (machines = [machine('signin')]));
  // a read still under way is no sign-in need (#5118): the strip waits for the answer
  await none({}, () => {
    owner = 'mini';
    machines = [machine('signin', { agents: [{ id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Checking on mini…' }] })];
  });
  await none({}, () => ((owner = 'gone'), (machines = [machine('signin')])));
  await none({}, () => ((owner = 'mini'), (allowed = false)));
  allowed = true;
});

test('a signed-out agent on the chat’s machine: Sign in opens the page on this Mac, the code shows, Cancel stops, and the card goes once ready', async () => {
  owner = 'mini';
  machines = [machine('signin')];
  const fake = fakeNative({ host: { signin: async () => view({ state: 'starting' }), cancelSignin: async () => true } });
  installNative(fake);
  const m = await mount(createElement(HostSigninCard, { threadId: 'c1', agent: 'gemini' }));
  try {
    assert.equal(card().getAttribute('aria-label'), 'Sign in to Gemini on mac-mini-test');
    assert.equal($('.host-signin-title', card()).textContent, 'Sign in to Gemini on mac-mini-test');
    assert.equal($('.host-signin-line').textContent, 'Sign in to send messages here', 'before it starts: what waits on it');
    assert.equal(button().textContent, 'Sign in');
    assert.ok(button().classList.contains('primary'), 'Sign in is the card’s one strong action');
    await click(button());
    assert.deepEqual(fake.callsTo('host.signin'), [['mini', 'gemini']]);
    assert.equal($('.host-signin-line').textContent, 'Opening the sign-in page…');
    assert.equal(button().textContent, 'Cancel');
    assert.ok(button().classList.contains('ghost'), 'Cancel is quiet');
    assert.equal($$('.host-signin-actions .btn-pill').length, 1, 'no Open page before a page opened');
    await act(async () => fake.emit('host.onSignin', view({ codes: ['ABCD-1234'], link: true, url: 'https://auth.example.com/device' })));
    assert.equal($('.host-signin-code').textContent, 'ABCD-1234');
    // the code copies in one click, and the page opens again from the card
    await click($('.host-signin-link'));
    assert.deepEqual(fake.callsTo('clipboard.write'), [['ABCD-1234']]);
    assert.deepEqual(toasts.at(-1), ['Code copied']);
    const open = $$('.host-signin-actions .btn-pill').find((b) => b.textContent === 'Open page')!;
    await click(open);
    assert.deepEqual(fake.callsTo('shell.openExternal'), [['https://auth.example.com/device']]);
    await click(button());
    assert.deepEqual(fake.callsTo('host.cancelSignin'), [['mini', 'gemini']]);
    await act(async () => fake.emit('host.onSignin', view({ state: 'signed-in' })));
    assert.equal($('.host-signin-line').textContent, 'Signed in');
    assert.equal(button(), null, 'nothing to press once signed in');
  } finally {
    await m.unmount();
  }
  // the machine reads the agent ready: the card is gone
  machines = [machine('ready')];
  const after = await mount(createElement(HostSigninCard, { threadId: 'c1', agent: 'gemini' }));
  assert.equal(card(), null);
  await after.unmount();
});

test('a page that asks for a code typed back gets it from the card; an empty field sends nothing', async () => {
  owner = 'mini';
  machines = [machine('signin')];
  const fake = fakeNative({ host: { signin: async () => view({ link: true }), signinInput: async () => true } });
  installNative(fake);
  const m = await mount(createElement(HostSigninCard, { threadId: 'c1', agent: 'gemini' }));
  try {
    await click(button());
    const input = $('.host-signin-form input') as HTMLInputElement;
    assert.equal(($('.host-signin-form button') as HTMLButtonElement).disabled, true);
    await act(async () => $('.host-signin-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(fake.callsTo('host.signinInput'), [], 'empty: nothing sent');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, '  code-from-page  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => $('.host-signin-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(fake.callsTo('host.signinInput'), [['mini', 'gemini', 'code-from-page']]);
    assert.equal(input.value, '', 'the field empties once sent');
  } finally {
    await m.unmount();
  }
});

test('failures: Google’s retired sign-in offers an API key with Details; any other says it plainly and tries again; a refusal is a toast', async () => {
  owner = 'mini';
  machines = [machine('signin')];
  toasts.length = 0;
  navigations.length = 0;
  let refuse = false;
  const fake = fakeNative({
    host: {
      signin: async () => (refuse ? Promise.reject(new Error('That machine does not list that agent.')) : view({ state: 'starting' })),
      cancelSignin: async () => Promise.reject(new Error('gone')),
    },
  });
  installNative(fake);
  const m = await mount(createElement(HostSigninCard, { threadId: 'c1', agent: 'gemini' }));
  try {
    await click(button());
    const said = 'This client is no longer supported for Gemini Code Assist for individuals.';
    await act(async () => fake.emit('host.onSignin', view({ state: 'failed', error: said })));
    assert.equal($('.host-signin-line').textContent, 'Google ended this sign-in for personal accounts');
    assert.equal($('.host-signin-details summary').textContent, 'Details');
    assert.ok($('.host-signin-details').textContent!.includes(said), 'the vendor’s words only behind Details');
    assert.equal(button().textContent, 'Use an API key');
    await click(button());
    assert.deepEqual(navigations, [{ name: 'settings', section: 'connections', tab: 'other' }]);
    await act(async () => fake.emit('host.onSignin', view({ state: 'failed', reason: 'no_page' })));
    assert.equal($('.host-signin-line').textContent, "Gemini didn't open a sign-in page");
    assert.equal(button().textContent, 'Try again');
    refuse = true;
    await click(button());
    assert.deepEqual(toasts.at(-1), ['That machine does not list that agent.', 'error']);
    // a cancel main refuses is a toast too
    await act(async () => fake.emit('host.onSignin', view({ state: 'waiting' })));
    await click(button());
    assert.deepEqual(toasts.at(-1), ['Gone.', 'error']);
  } finally {
    await m.unmount();
  }
});

test('the new chat signs in on the machine the host chip picked; a Host chat’s agent reads as its own (host-claude is Claude Code)', async () => {
  owner = 'local';
  pick = { id: 'mini' };
  machines = [
    machine('ready', {
      agents: [{ id: 'claude', label: 'Claude Code', state: 'signin', reason: '' }],
      note: 'claude is not signed in on this machine.',
    }),
  ];
  installNative(fakeNative());
  const m = await mount(createElement(HostSigninCard, { threadId: null, agent: 'host-claude' }));
  try {
    assert.equal(card().getAttribute('aria-label'), 'Sign in to Claude Code on mac-mini-test');
  } finally {
    await m.unmount();
  }
  // the new chat's pick wants Claude Code (the agent the routing note names) while the composer still shows another: the card follows the pick
  want = 'claude';
  const wanted = await mount(createElement(HostSigninCard, { threadId: null, agent: 'codex' }));
  try {
    assert.equal(card().getAttribute('aria-label'), 'Sign in to Claude Code on mac-mini-test');
  } finally {
    await wanted.unmount();
    pick = null;
    want = undefined;
  }
});

test('the card names the agent new chats start on meanwhile, so no second line above the composer repeats it', async () => {
  owner = 'local';
  pick = { id: 'mini' };
  want = 'gemini';
  standIn = 'claude';
  machines = [machine('signin')];
  installNative(fakeNative());
  const m = await mount(createElement(HostSigninCard, { threadId: null, agent: 'gemini' }));
  try {
    assert.equal($('.host-signin-line').textContent, 'Until then, new chats start in Claude Code');
  } finally {
    await m.unmount();
  }
  // an attempt that failed still says where new chats go meanwhile, under its own line
  const fake = fakeNative({ host: { signin: async () => view({ state: 'starting' }) } });
  installNative(fake);
  const failed = await mount(createElement(HostSigninCard, { threadId: null, agent: 'gemini' }));
  try {
    await click(button());
    await act(async () => fake.emit('host.onSignin', view({ state: 'expired' })));
    assert.deepEqual(
      $$('.host-signin-line').map((l) => l.textContent),
      ['That code expired', 'Until then, new chats start in Claude Code'],
    );
    await act(async () => fake.emit('host.onSignin', view({ state: 'waiting' })));
    assert.equal($$('.host-signin-line').length, 1, 'not while it runs');
  } finally {
    await failed.unmount();
  }
  installNative(fakeNative());
  // a stand-in the machine row does not name reads by its id
  standIn = 'kimi';
  const bare = await mount(createElement(HostSigninCard, { threadId: null, agent: 'gemini' }));
  try {
    assert.equal($('.host-signin-line').textContent, 'Until then, new chats start in kimi');
  } finally {
    await bare.unmount();
    pick = null;
    want = undefined;
    standIn = null;
  }
});

test('B: a code that cannot be copied says so', async () => {
  owner = 'mini';
  machines = [machine('signin')];
  toasts.length = 0;
  const fake = fakeNative({
    host: { signin: async () => view({ codes: ['WXYZ-9876'] }) },
    clipboard: { write: async () => Promise.reject(new Error('denied')) },
  });
  installNative(fake);
  const m = await mount(createElement(HostSigninCard, { threadId: 'c1', agent: 'gemini' }));
  try {
    await click(button());
    await click($('.host-signin-link'));
    assert.deepEqual(toasts.at(-1), ['Couldn’t copy the code', 'error']);
  } finally {
    await m.unmount();
  }
});

test('Send waits only while the chat’s agent is signed out there and nothing stands in; its tooltip says Sign in first', async () => {
  const { useSendBlock } = await import('../src/session/useHostSigninNeed.ts');
  const { SendButton } = await import('../src/components/composer/SendButton.tsx');
  installNative(fakeNative());
  let seen: string | null | undefined;
  const Probe = ({ threadId, agent }: { threadId: string | null; agent: string | null }) => ((seen = useSendBlock(threadId, agent)), null);
  const probe = async (threadId: string | null, agent: string | null) => {
    const m = await mount(createElement(Probe, { threadId, agent }));
    await m.unmount();
    return seen;
  };
  owner = 'mini';
  machines = [machine('signin')];
  assert.equal(await probe('c1', 'gemini'), 'Sign in first');
  machines = [machine('ready')];
  assert.equal(await probe('c1', 'gemini'), null, 'ready (signed in, or covered by a key or lease): Send works');
  owner = 'local';
  assert.equal(await probe('c1', 'gemini'), null, 'this Mac');
  // a new chat whose pick starts on another agent that is ready there is not blocked by this one
  owner = 'local';
  pick = { id: 'mini' };
  machines = [machine('signin')];
  want = 'gemini';
  standIn = 'claude';
  assert.equal(await probe(null, 'gemini'), null);
  standIn = null;
  assert.equal(await probe(null, 'gemini'), 'Sign in first');
  pick = null;
  want = undefined;

  const sent = { n: 0 };
  const b = await mount(
    createElement(SendButton, {
      label: 'Send',
      block: 'Sign in first',
      morph: null,
      onAnimationEnd: () => undefined,
      onSend: () => void sent.n++,
    }),
  );
  try {
    const btn = $('button[aria-label="Send"]') as HTMLButtonElement;
    assert.equal(btn.disabled, true);
    await click(btn);
    assert.equal(sent.n, 0);
    await b.render(
      createElement(SendButton, { label: 'Send', block: null, morph: null, onAnimationEnd: () => undefined, onSend: () => void sent.n++ }),
    );
    await click($('button[aria-label="Send"]'));
    assert.equal(sent.n, 1);
  } finally {
    await b.unmount();
  }
});
