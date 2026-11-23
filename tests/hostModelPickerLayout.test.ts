// The machine chat's model picker is This Mac's two-level picker fed by the machine (#4907): the chip is the agent's mark, the model with its version and the effort; the head holds one line; the
// first level lists the machine's agents with their state, usage and account; the models sit beside the agent with their versions; an agent the machine lacks is a not-set-up row, not a section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act } from 'react';
import { $, $$, click, fire, mockTsx, mount } from './support/composer-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative, installNativeStub, useFakeNative } from './support/ports/native.ts';
import { claudeLoginsOf } from '../host/src/claudeLogins.mjs';

installNativeStub(fakeNative({ host: { access: async () => true } }));
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// what the Host's Claude catalog sends today: names without versions, the version in the description, no default effort
const claudeModels = (defaultText = 'Use the default model (currently Opus 5.5) · $5/$25') => [
  { id: 'default', name: 'Default (recommended)', default: true, efforts: LEVELS, defaultEffort: null, description: defaultText },
  { id: 'opus', name: 'Opus', default: false, efforts: LEVELS, defaultEffort: null, description: 'Opus 5.5 · Best for complex work' },
  { id: 'sonnet', name: 'Sonnet', default: false, efforts: LEVELS, defaultEffort: null, description: 'Sonnet 5.5 · Everyday' },
  { id: 'claude-opus-4-1', name: 'Opus 4.1', default: false, efforts: LEVELS, defaultEffort: null, description: 'Pinned' },
];
const pick = { id: 'box', name: 'Box', path: '/remote' };
let state: any = { newChatHost: pick, chatConfig: {} };
let machines: any[] = [];
const calls: any[] = [];
const draft = { pick, want: 'claude', choice: { harness: 'claude' } };
mockSource('src/store/core.ts', {
  toast: () => undefined,
  useStore: (sel: any) => sel(state),
  set: (patch: any) => {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
  },
});
mockSource('src/store/chats.ts', { chatBasicHarness: () => 'host-claude' });
mockSource('src/store/projects.ts', {
  setChatConfig: (id: string, patch: any) => {
    state.chatConfig[id] = { ...state.chatConfig[id], ...patch };
  },
});
mockSource('src/store/panes.ts', { navigate: (...a: any[]) => void calls.push(['navigate', ...a]) });
const mark = (id: string) => ({
  type: 'span',
  props: { className: 'harness-icon', 'data-h': id },
  key: null,
  ref: null,
  $$typeof: Symbol.for('react.transitional.element'),
});
mockTsx(new URL('../src/components/harnessPicker/badges.tsx', import.meta.url), {
  HarnessIcon: ({ h: id }: any) => mark(id),
  BasicHarnessIcon: ({ id }: any) => mark(id),
  BasicBadge: () => null,
});
mockSource('src/store/session/useSession.ts', {
  useSessionField: (_id: string, pickField: (x: any) => unknown) => pickField({ pendingSwitch: null }),
  setSession: async () => undefined,
});
mockSource('src/store/machineChatSwitch.ts', {
  agentOfKind: (kind: unknown) => (typeof kind === 'string' && kind ? kind.replace(/^acp:/, '') : null),
  switchMachineChat: async () => null,
  dropMachineSwitch: async () => undefined,
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines }) });
mockSource('src/session/useHostAgentChoice.ts', { useHostAgentChoice: () => draft });
const { createElement: h } = await import('react');
const { HostModelPicker } = await import('../src/components/composer/HostModelPicker.tsx');
const chip = () => $('button[aria-label="Select model"]');
const agent = (id: string, label: string, st: string, over: Record<string, unknown> = {}) => ({
  id,
  label,
  state: st,
  reason: st === 'signin' ? 'Sign in on Box' : st === 'missing' ? `Not installed on Box` : '',
  ...over,
});
const LOGIN = {
  id: 'a',
  label: 'me@work.com',
  state: 'ok',
  limited: false,
  billing: 'subscription',
  active: true,
  usage: [{ label: '5h', usedPercent: 84, resetsAt: null }],
};
const CLAUDE = () => agent('claude', 'Claude Code', 'ready', { models: claudeModels(), logins: [LOGIN] });
function setup(agents: unknown[]) {
  state = { newChatHost: pick, chatConfig: {} };
  calls.length = 0;
  machines = [{ id: 'box', name: 'Box', agents }];
}
/** The popover on its harness list. */
async function openList() {
  await click(chip());
  const title = $('button[aria-label="Select harness and model"]');
  if (title) await click(title);
}
const rowOf = (label: string) => $$('.hp-row').find((r) => r.textContent?.includes(label))!;
const renewRow = (label: string) => $(`[role=menuitem][aria-label="Sign in again to ${label}"]`);
/** Each row's name, then its state badge when it has one (the badge sits beside the name, not inside it). */
const titles = () =>
  $$('.hp-row .hp-heading').map((x) =>
    [x.querySelector('.hp-title')!.textContent, x.querySelector('.hp-badge')?.textContent].filter(Boolean).join(' '),
  );

test('the chip is the same as This Mac: the mark, the model with its version, the effort', async () => {
  setup([CLAUDE()]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    // the default resolves to Opus 5.5 (the Host's description says so), and the effort the Host reports none for resolves as on This Mac (High)
    assert.equal(chip().querySelector('.harness-icon')!.getAttribute('data-h'), 'claude');
    assert.equal(chip().querySelector('.model-name')!.textContent, 'Opus 5.5');
    assert.equal(chip().querySelector('.model-effort')!.textContent, 'High');
    assert.match(chip().getAttribute('title')!, /Claude Code · Opus 5.5 · me@work.com on Box/);
    await click(chip());
    await act(async () => {
      $('.effort-pop').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await m.render(h(HostModelPicker, { threadId: null, hostId: 'box' }));
    assert.equal(chip().querySelector('.model-effort')!.textContent, 'Extra high');
  } finally {
    await m.unmount();
  }
});

test('one layout for every selection: the effort is always named, the head is one line with its whole text on hover', async () => {
  setup([CLAUDE()]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(chip());
    assert.equal($('.effort-name').textContent, 'High');
    assert.ok($('.effort-knob'), 'the level is marked: there is no unset state');
    assert.equal($('.effort-model-text').textContent!.trim(), 'Claude Code · Opus 5.5');
    assert.equal($('.effort-model-text').getAttribute('title'), 'Claude Code · Opus 5.5');
    assert.doesNotMatch(document.body.textContent!, /Runs on/);
    assert.doesNotMatch(document.body.textContent!, /Applies from the next message/);
    // reset goes to the model's own default, which the Host does not report: the level This Mac would show (High)
    await click($('button[aria-label="Reset to default"]'));
    assert.equal(state.newChatHost.selection.model, 'default');
    assert.equal(state.newChatHost.selection.effort, 'high');
  } finally {
    await m.unmount();
  }
  const started = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await click(chip());
    assert.match(document.body.textContent!, /Applies from the next message/);
  } finally {
    await started.unmount();
  }
});

test("the account the agent runs on is in the panel, and opens the list; Manage harnesses goes to the machine's settings", async () => {
  setup([CLAUDE()]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(chip());
    const account = $('button[aria-label="Account: me@work.com"]');
    assert.equal($('.hp-account-name').textContent, 'me@work.com');
    assert.equal($('.hp-account-note').textContent, 'Subscription · 16% left');
    await click(account);
    assert.ok($('.hp-harnesses'), 'the list gave way to the panel');
    await click($$('.menu-item').find((x) => /Manage harnesses/.test(x.textContent ?? ''))!);
    assert.deepEqual(calls.at(-1), ['navigate', { name: 'settings', section: 'connections' }]);
  } finally {
    await m.unmount();
  }
  // an agent that reports no login has no account row
  setup([agent('claude', 'Claude Code', 'ready', { models: claudeModels() })]);
  const none = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(chip());
    assert.equal($('.hp-account'), null);
  } finally {
    await none.unmount();
  }
});

test('the first level: each agent with its mark, state, usage and account; usable ones first; not-set-up ones as rows', async () => {
  setup([
    agent('codex', 'Codex', 'missing'),
    agent('opencode', 'opencode', 'missing'),
    agent('claude', 'Claude Code', 'signin', { reason: 'Sign in on Box' }),
    agent('gemini', 'Gemini', 'ready', { models: [{ id: 'g', name: 'Gemini Pro', default: true, efforts: [], defaultEffort: null }] }),
    { ...CLAUDE(), id: 'grok', label: 'Grok' },
  ]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await openList();
    // the machine row's order (core agents first), usable before signed out; opencode, which the machine lacks and the user never runs, is not listed
    assert.deepEqual(titles(), ['Gemini', 'Grok', 'Claude Code Signed out', 'Codex Not installed']);
    assert.equal(rowOf('Grok').querySelector('.menu-desc')!.textContent, 'me@work.com · 16% left');
    assert.equal(rowOf('Gemini').querySelector('.menu-desc')!.textContent, 'Signed in on Box');
    assert.equal(rowOf('Claude Code').getAttribute('data-disabled'), 'true');
    assert.doesNotMatch(rowOf('Claude Code').textContent!, /Sign in on Box/, 'the badge and the button say it');
    assert.match(rowOf('Codex').textContent!, /Install Codex on Box\./);
    assert.doesNotMatch(rowOf('Codex').textContent!, /Not installed on Box/);
    assert.equal(rowOf('Gemini').querySelector('.harness-icon')!.getAttribute('data-h'), 'gemini');
    assert.equal(
      $$('.hp-head').filter((x) => /Not installed/.test(x.textContent ?? '')).length,
      0,
      'no section for an agent the machine lacks',
    );
  } finally {
    await m.unmount();
  }
});

test('the models beside an agent carry their versions; the default is the model it is; the account is listed', async () => {
  setup([CLAUDE()]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await openList();
    assert.equal($('.hp-row').getAttribute('aria-expanded'), 'true', "the chat's own agent opens on its models");
    assert.deepEqual(
      $$('[role=menuitemradio]').map((r) => r.textContent),
      ['Opus 5.5Default', 'Sonnet 5.5'],
    );
    assert.equal($('[role=menuitemradio][aria-checked=true]').textContent, 'Opus 5.5Default');
    assert.equal($('[data-account=a] .acct-email').textContent, 'me@work.com');
    assert.equal($('[data-account=a] .acct-status').textContent, 'Subscription · 16% left');
    assert.deepEqual(
      $$('.hp-head').map((x) => x.textContent),
      ['‹ Harness', 'Account', 'Models'],
    );
    // an older pinned version is under More versions
    await click($$('[aria-expanded]').find((r) => /More versions/.test(r.textContent ?? ''))!);
    assert.ok($$('[role=menuitemradio]').some((r) => r.textContent === 'Opus 4.1'));
    await click($$('[role=menuitemradio]').find((r) => r.textContent === 'Sonnet 5.5')!);
    assert.equal(state.newChatHost.selection.model, 'sonnet');
    assert.equal(chip().querySelector('.model-name')!.textContent, 'Sonnet 5.5');
  } finally {
    await m.unmount();
  }
});

test('where the Host does not say what the default is, the row says so; it never reads "Default (recommended)" alone', async () => {
  setup([agent('claude', 'Claude Code', 'ready', { models: claudeModels('Most capable for complex work') })]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    assert.equal(chip().querySelector('.model-name')!.textContent, 'Default');
    await openList();
    const first = $$('[role=menuitemradio]')[0];
    assert.equal(first.querySelector('.menu-title')!.textContent, 'Default');
    assert.equal(first.querySelector('.menu-desc')!.textContent, 'Model not reported by Box');
    assert.doesNotMatch(document.body.textContent!, /recommended/);
  } finally {
    await m.unmount();
  }
});

test('the list goes back to the panel by its row or the arrow key; with no model chosen it only lists; none to list says it is waiting', async () => {
  setup([CLAUDE()]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await openList();
    await click($$('.hp-back')[0]);
    assert.ok($('.effort-pop'));
    await click($('button[aria-label="Select harness and model"]'));
    await fire($('.hp-harnesses'), new (window as any).KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.ok($('.effort-pop') || $('.hp-harnesses'));
  } finally {
    await m.unmount();
  }
  setup([agent('claude', 'Claude Code', 'ready')]);
  const bare = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(chip());
    assert.equal($('.hp-back'), null, 'no model to go back to');
    assert.match(document.body.textContent!, /has not reported models/);
  } finally {
    await bare.unmount();
  }
  setup([]);
  const none = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(chip());
    assert.match(document.body.textContent!, /Waiting for Box to report its models/);
  } finally {
    await none.unmount();
  }
});

test("an expired login is on the agent's row too, in the warning tone, not only in the account list", async () => {
  setup([agent('claude', 'Claude Code', 'ready', { models: claudeModels(), logins: [{ ...LOGIN, state: 'expired', usage: undefined }] })]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await openList();
    const line = rowOf('Claude Code').querySelector('.menu-desc')!;
    assert.equal(line.textContent, 'me@work.com · Expired');
    assert.match(line.className, /warn/);
    assert.equal($('[data-account=a] .acct-status').textContent, 'Subscription · Expired');
  } finally {
    await m.unmount();
  }
});

test('a signed-out, an expired and a limited login say so in the account list', async () => {
  const logins = [
    LOGIN,
    { ...LOGIN, id: 'b', label: 'old@x.com', state: 'signedOut', active: false, usage: undefined },
    { ...LOGIN, id: 'c', label: 'busy@x.com', limited: true, active: false },
  ];
  setup([agent('claude', 'Claude Code', 'ready', { models: claudeModels(), logins })]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await openList();
    assert.equal($('.hp-head:not(.hp-back)').textContent, 'Accounts');
    assert.deepEqual(
      $$('[data-account] .acct-status').map((x) => x.textContent),
      ['Subscription · 16% left', 'Subscription · Signed out', 'Subscription · Limited'],
    );
    assert.match($$('[data-account] .acct-status')[1].className, /warn/);
  } finally {
    await m.unmount();
  }
});

test('a Codex chat can sign in again to Claude Code on its machine from the account flyout', async (t) => {
  const launch = deferred();
  const view = { hostId: 'box', harness: 'claude', state: 'waiting', codes: ['TEST-1234'], link: false };
  const native = useFakeNative(t, {
    host: { signin: () => launch.promise, signinInput: async () => true },
  });
  const codex = agent('codex', 'Codex', 'ready', { models: [{ id: 'gpt', name: 'GPT', default: true, efforts: [], defaultEffort: null }] });
  const logins = claudeLoginsOf({ active: 'default', accounts: [{ id: 'default', email: 'me@work.com', loggedIn: false }] });
  setup([{ ...CLAUDE(), logins }, codex]);
  const config = { hostAgent: 'codex', hostSelection: { hostId: 'box', harness: 'codex', model: 'gpt' } };
  state.chatConfig.chat = config;
  let composerClicks = 0;
  const picker = () => h('div', { onMouseDown: () => composerClicks++ }, h(HostModelPicker, { threadId: 'chat', hostId: 'box' }));
  const m = await mount(picker());
  try {
    await openList();
    await click(rowOf('Claude Code'));
    assert.equal($('[data-account=default] .acct-status').textContent, 'Subscription · Signed out');
    const renew = renewRow('Claude Code');
    assert.ok(renew, 'the signed-out account offers sign-in even though the agent has models');
    const flyout = $('[role=menu][aria-label="Claude Code"]');
    flyout.focus();
    await fire(flyout, new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(flyout.getAttribute('aria-activedescendant'), renew.id);
    await fire(flyout, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(native.callsTo('host.signin'), [['box', 'claude']]);
    assert.equal($('.dialog [role=status]').textContent, 'Opening the sign-in page…');
    await act(() => native.emit('host.onSignin', view));
    const deviceCode = $('.dialog .host-signin-code');
    assert.equal(deviceCode.textContent, 'TEST-1234');
    await fire(deviceCode, new MouseEvent('mousedown', { bubbles: true }));
    assert.equal(composerClicks, 0, 'selecting the code does not focus the draft');
    await act(() => launch.resolve({ ...view, state: 'starting', codes: [] }));
    assert.equal($('.dialog .host-signin-code').textContent, 'TEST-1234', 'a late acknowledgment cannot hide the live code');
    await act(() => native.emit('host.onSignin', { ...view, codes: [], link: true, url: 'https://claude.com/signin' }));
    const field = $('input[aria-label="Code from the page"]');
    assert.ok(field, 'the browser can ask for a code even while the composer is on Codex');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'test-code');
    await fire(field, new Event('input', { bubbles: true }));
    await click($$('.dialog button').find((b) => b.textContent === 'Send'));
    assert.deepEqual(native.callsTo('host.signinInput'), [['box', 'claude', 'test-code']]);
    await act(() => native.emit('host.onSignin', { ...view, state: 'signed-in' }));
    assert.equal($('.dialog [role=status]').textContent, 'Signed in');
    assert.equal($$('.dialog button').length, 1, 'a successful attempt offers only Close while the account report refreshes');
    await click($('.dialog [aria-label=Close]'));
    machines[0].agents = [CLAUDE(), codex];
    await m.render(picker());
    await openList();
    await click(rowOf('Claude Code'));
    assert.equal(renewRow('Claude Code'), null, 'the fresh Host report removes the action');
    assert.deepEqual(state.chatConfig.chat, config);
    assert.equal(chip().querySelector('.model-name')!.textContent, 'GPT');
  } finally {
    await m.unmount();
  }
});

test('a refused renewal can be retried, and a closed attempt cannot replace a newer dialog', async (t) => {
  const old = deferred();
  const latest = deferred();
  const view = { hostId: 'box', harness: 'gemini', state: 'starting' };
  let request = 0;
  const native = useFakeNative(t, {
    host: {
      access: async () => true,
      signin: async () => [old.promise, latest.promise, Promise.resolve(view)][request++],
    },
  });
  const gemini = agent('gemini', 'Gemini', 'ready', { logins: [{ ...LOGIN, id: 'default', state: 'expired' }] });
  setup([gemini]);
  const picker = () => h(HostModelPicker, { threadId: null, hostId: 'box' });
  const m = await mount(picker());
  const start = async () => {
    await openList();
    await click(rowOf('Gemini'));
    await click(renewRow('Gemini'));
  };
  try {
    await start();
    assert.equal($('.dialog [role=status]').textContent, 'Opening the sign-in page…');
    await click($('.dialog [aria-label=Close]'));
    await start();
    await act(() => old.reject(new Error('Old refusal')));
    assert.equal($('.dialog [role=alert]'), null);
    await act(() => latest.reject(new Error('The machine refused sign-in.')));
    assert.equal($('.dialog [role=alert]').textContent, 'The machine refused sign-in.');
    await click($$('.dialog button').find((b) => b.textContent === 'Try again'));
    assert.deepEqual(native.callsTo('host.signin'), [
      ['box', 'gemini'],
      ['box', 'gemini'],
      ['box', 'gemini'],
    ]);
    assert.equal($('.dialog [role=alert]'), null);
    await act(() => native.emit('host.onSignin', { ...view, state: 'cancelled' }));
    assert.equal($('.dialog [role=status]').textContent, 'Start the sign-in again.');
    assert.ok($$('.dialog button').some((b) => b.textContent === 'Try again'));
    assert.deepEqual(state.newChatHost, pick);
    await click($('.dialog [aria-label=Close]'));
    await start();
    assert.equal(native.callsTo('host.signin').length, 3, 'reopening an ended attempt shows its outcome');
    assert.ok($$('.dialog button').some((b) => b.textContent === 'Try again'));
    machines[0].status = 'offline';
    await m.render(picker());
    assert.ok(!$$('.dialog button').some((b) => b.textContent === 'Try again'), 'the latest offline report retires retry');
    machines[0].status = 'online';
    machines[0].agents = [{ ...gemini, logins: [{ ...LOGIN, id: 'default' }] }];
    await m.render(picker());
    assert.ok(!$$('.dialog button').some((b) => b.textContent === 'Try again'), 'a healthy profile retires retry');
    machines[0].agents = [];
    await m.render(picker());
    assert.equal($('.dialog'), null, 'removing the agent dismisses its dialog');
  } finally {
    await m.unmount();
  }
});

test('an offline machine shows the account from its last report without offering sign-in', async () => {
  setup([{ ...CLAUDE(), logins: [{ ...LOGIN, id: 'default', state: 'signedOut' }] }]);
  machines[0].status = 'offline';
  const m = await mount(h(HostModelPicker, { threadId: 'chat', hostId: 'box' }));
  try {
    await openList();
    assert.equal($('[data-account=default] .acct-status').textContent, 'Subscription · Signed out');
    assert.equal(renewRow('Claude Code'), null);
  } finally {
    await m.unmount();
  }
});

test('the models beside an agent close by the left arrow or Escape, leaving the list or closing the picker', async () => {
  setup([
    CLAUDE(),
    agent('gemini', 'Gemini', 'ready', { models: [{ id: 'g', name: 'Gemini Pro', default: true, efforts: [], defaultEffort: null }] }),
  ]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await openList();
    await click(rowOf('Gemini'));
    assert.ok($$('[role=menuitemradio]').some((r) => r.textContent === 'Gemini Pro'));
    // the keys go to the menu that has focus: the models, once they have it
    $('[role=menu][aria-label="Gemini"]').focus();
    await fire(document.activeElement ?? document.body, new (window as any).KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal($$('[role=menuitemradio]').length, 0, 'the models folded away');
    assert.ok($('.hp-harnesses'), 'the list stays');
    await click(rowOf('Gemini'));
    await fire(document.body, new (window as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal($('.hp-harnesses'), null, 'the whole picker closed');
  } finally {
    await m.unmount();
  }
});

test('the models beside an agent go when the agent stops being usable, and open on a signed-out agent never', async () => {
  setup([CLAUDE()]);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await openList();
    assert.ok($$('[role=menuitemradio]').length > 0);
    // the machine reports its login refused: the row becomes a not-ready row and its models can no longer be picked
    machines = [
      {
        id: 'box',
        name: 'Box',
        agents: [{ ...CLAUDE(), state: 'signin', reason: "Claude Code on Box can't run: its login is refused. Sign in again on Box." }],
      },
    ];
    await m.render(h(HostModelPicker, { threadId: null, hostId: 'box' }));
    assert.equal($$('[role=menuitemradio]').length, 0);
    assert.match(rowOf('Claude Code').textContent!, /its login is refused/);
    assert.equal(rowOf('Claude Code').getAttribute('data-disabled'), 'true');
  } finally {
    await m.unmount();
  }
  setup([agent('claude', 'Claude Code', 'signin', { models: claudeModels() })]);
  const out = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await openList();
    assert.equal($$('[role=menuitemradio]').length, 0, 'a signed-out agent opens no models');
  } finally {
    await out.unmount();
  }
});
