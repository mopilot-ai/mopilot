// Machine model/effort picker interactions for drafts, started chats and absent/obsolete machine catalogs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { $, $$, click, mockTsx, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
const MODEL = { id: 'remote', name: 'Remote model', default: true, efforts: ['low', 'high'], defaultEffort: 'low' };
const pick = { id: 'box', name: 'Box', path: '/remote' };
let state: any = { newChatHost: pick, chatConfig: {} };
let machines: any[] = [];
let basic: string | null = 'host-claude';
let draft: any = { pick, want: 'claude', choice: { harness: 'claude' } };
const patches: any[] = [];
const toasts: any[] = [];
mockSource('src/store/core.ts', {
  toast: (...a: any[]) => void toasts.push(a),
  useStore: (sel: any) => sel(state),
  set: (patch: any) => {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
  },
});
mockSource('src/store/chats.ts', { chatBasicHarness: () => basic });
mockSource('src/store/projects.ts', {
  setChatConfig: (id: string, patch: any) => {
    patches.push([id, patch]);
    state.chatConfig[id] = { ...state.chatConfig[id], ...patch };
  },
});
let pendingSwitch: any = null;
let refusal: string | null = null;
const calls: any[] = [];
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
  useSessionField: (_id: string, pickField: (x: any) => unknown) => pickField({ pendingSwitch }),
  setSession: async (...a: any[]) => void calls.push(['setSession', ...a]),
});
mockSource('src/store/machineChatSwitch.ts', {
  agentOfKind: (kind: unknown) => (typeof kind === 'string' && kind ? kind.replace(/^acp:/, '') : null),
  switchMachineChat: async (...a: any[]) => (calls.push(['switch', ...a]), refusal),
  dropMachineSwitch: async (...a: any[]) => void calls.push(['drop', ...a]),
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines }) });
let signinFails = false;
installNative(
  fakeNative({
    host: {
      signin: async (hostId: string, harness: string) => {
        calls.push(['signin', hostId, harness]);
        if (signinFails) throw new Error('Host said no');
      },
    },
  }),
);
mockSource('src/session/useHostAgentChoice.ts', { useHostAgentChoice: () => draft });
const { createElement: h } = await import('react');
const { HostModelPicker } = await import('../src/components/composer/HostModelPicker.tsx');
const button = () => $('button[aria-label="Select model"]');
/** Opens the popover on its harness list (a chat with no usable model opens on it) and the models of the agent named. */
async function openAgent(label: string) {
  await click(button());
  const title = $('button[aria-label="Select harness and model"]');
  if (title) await click(title);
  await click($$('.hp-row').find((r) => r.textContent?.includes(label))!);
}
function reset() {
  basic = 'host-claude';
  draft = { pick, want: 'claude', choice: { harness: 'claude' } };
  state = { newChatHost: pick, chatConfig: {} };
  patches.length = 0;
  calls.length = 0;
  pendingSwitch = null;
  refusal = null;
  machines = [
    {
      id: 'box',
      name: 'Box',
      agents: [
        {
          id: 'claude',
          label: 'Claude Code',
          state: 'ready',
          models: [MODEL, { ...MODEL, id: 'second', name: 'Second', default: false, defaultEffort: 'high' }],
        },
        { id: 'custom', label: 'Custom', state: 'ready', models: [{ ...MODEL, id: 'custom-model' }] },
      ],
    },
  ];
}

test('new chat picks from its machine, changes effort and resets it; another harness stays draft-local', async () => {
  reset();
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    assert.match(button().textContent!, /Remote model/);
    await click(button());
    const panel = $('.effort-pop');
    await import('react').then(({ act }) =>
      act(async () => {
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      }),
    );
    assert.equal(state.newChatHost.selection.effort, 'high');
    await m.render(h(HostModelPicker, { threadId: null, hostId: 'box' }));
    await click($('button[aria-label="Reset to default"]'));
    assert.equal(state.newChatHost.selection.effort, 'low');
    await click($('button[aria-label="Select harness and model"]'));
    await click($$('.hp-row').find((r) => r.textContent?.includes('Claude Code'))!);
    await click($$('[role=menuitemradio]').find((x) => x.textContent === 'Second')!);
    assert.equal(state.newChatHost.selection.model, 'second');
    assert.deepEqual(patches, []);
    await click($('button[aria-label="Select harness and model"]'));
    await click($$('.hp-row').find((r) => r.textContent?.includes('Custom'))!);
    await click($$('[role=menuitemradio]').find((x) => x.textContent === 'Remote model')!);
    assert.equal(state.newChatHost.agent, 'custom');
  } finally {
    await m.unmount();
  }
});

test('started machine chat changes only its own model; removed models and legacy hosts never use Mac choices', async () => {
  reset();
  state.chatConfig.c = { hostSelection: { hostId: 'box', harness: 'claude', model: 'gone', effort: 'high' } };
  const m = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    assert.match(button().textContent!, /Model unavailable/);
    await click(button());
    assert.equal($$('.hp-row').length, 2, "the machine's other agents are offered: choosing one switches the chat");
    assert.equal($$('[role=menuitemradio]').length, 2, "the chat's own agent opens on its models");
    await click($$('[role=menuitemradio]')[0]);
    assert.equal(patches[0][0], 'c');
    assert.equal(patches[0][1].hostSelection.model, 'remote');
    assert.match(document.body.textContent!, /Applies from the next message/);
  } finally {
    await m.unmount();
  }
  machines[0].agents = [{ id: 'claude', label: 'Claude Code', state: 'ready' }];
  const old = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await click(button());
    assert.match(document.body.textContent!, /has not reported models/);
    assert.equal($$('[role=menuitemradio]').length, 0);
  } finally {
    await old.unmount();
  }
});

test('D13: another agent on the machine is picked for a started chat: the Host agrees first, a refusal stays in the list as one line', async () => {
  reset();
  state.chatConfig.c = { hostSelection: { hostId: 'box', harness: 'claude', model: 'gone', effort: 'high' } };
  const m = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await openAgent('Custom');
    refusal = 'Sign in to Custom on Box first.';
    await click($$('[role=menuitemradio]')[0]);
    assert.deepEqual(calls, [
      ['switch', 'c', { agent: 'custom', model: 'custom-model', modelLabel: 'Remote model', effort: 'low' }, 'Box'],
    ]);
    assert.equal($('[role=alert]').textContent, 'Sign in to Custom on Box first.');
    assert.deepEqual(patches, [], 'nothing was saved for a switch the Host refused');
    refusal = null;
    await click($$('[role=menuitemradio]')[0]);
    assert.equal(calls.length, 2);
    assert.equal(document.body.querySelector('[role=alert]'), null, 'the line goes once the Host holds the choice');
  } finally {
    await m.unmount();
  }
});

test("D13: the chat's own agent picked again takes back a choice the Host holds, and saves the pick as before", async () => {
  reset();
  state.chatConfig.c = { hostSelection: { hostId: 'box', harness: 'claude', model: 'gone', effort: 'high' } };
  pendingSwitch = { harness: 'acp:custom', model: 'custom-model', modelLabel: 'Remote model', mode: 'auto' };
  const m = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await openAgent('Claude Code');
    await click($$('[role=menuitemradio]')[1]);
    assert.deepEqual(calls, [
      ['setSession', 'c', { pendingSwitch: null }],
      ['drop', 'c', 'claude'],
    ]);
    assert.equal(patches[0][1].hostSelection.model, 'second');
  } finally {
    await m.unmount();
  }
});

test('D13: a chat the Host moved to another agent is read as that agent, so the machine’s Claude Code is now the other one to switch to', async () => {
  reset();
  state.chatConfig.c = { hostAgent: 'acp:custom', hostSelection: { hostId: 'box', harness: 'custom', model: 'gone', effort: 'high' } };
  const m = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await openAgent('Claude Code');
    await click($$('[role=menuitemradio]')[0]);
    assert.deepEqual(calls[0].slice(0, 2), ['switch', 'c']);
    assert.equal(calls[0][2].agent, 'claude');
  } finally {
    await m.unmount();
  }
});

test('D13: a model with no effort levels switches without naming one', async () => {
  reset();
  state.chatConfig.c = { hostSelection: { hostId: 'box', harness: 'claude', model: 'gone', effort: 'high' } };
  machines[0].agents[1].models = [{ ...MODEL, id: 'plain', name: 'Plain', efforts: [], defaultEffort: null }];
  const m = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await openAgent('Custom');
    await click($$('[role=menuitemradio]').find((x) => x.textContent === 'Plain')!);
    assert.deepEqual(calls, [['switch', 'c', { agent: 'custom', model: 'plain', modelLabel: 'Plain', effort: undefined }, 'Box']]);
  } finally {
    await m.unmount();
  }
});

test('D13: a ready agent the machine reports no models for (a machine with only a lent key) can still be switched to, on its own default model', async () => {
  reset();
  state.chatConfig.c = { hostSelection: { hostId: 'box', harness: 'claude', model: 'gone', effort: 'high' } };
  machines[0].agents[1] = { id: 'custom', label: 'Custom', state: 'ready' };
  const m = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await openAgent('Custom');
    const row = $$('[role=menuitem]').find((x) => /Switch to Custom/.test(x.textContent ?? ''))!;
    assert.ok(row, 'the row is offered');
    await click(row);
    assert.deepEqual(calls, [['switch', 'c', { agent: 'custom', modelLabel: 'Custom' }, 'Box']]);
  } finally {
    await m.unmount();
  }
});

test('legacy ready agents retain a draft-local default action and a missing started agent has an explanation', async () => {
  reset();
  machines[0].agents = [
    { id: 'custom', label: 'Custom', state: 'ready' },
    { id: 'codex', label: 'Codex', state: 'missing', reason: 'Not installed on Box' },
  ];
  const draft = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await openAgent('Custom');
    assert.match(document.body.textContent!, /Install Codex on Box\./);
    await click($$('[role=menuitemradio]')[0]);
    assert.equal(state.newChatHost.agent, 'custom');
    assert.equal(state.newChatHost.selection, undefined);
  } finally {
    await draft.unmount();
  }
  const started = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await openAgent('Custom');
    assert.match(document.body.textContent!, /Install Codex on Box\./, 'the agents the machine lacks say so on their row');
  } finally {
    await started.unmount();
  }
});

test('obsolete effort is visibly unavailable, and a stale draft click cannot change another machine', async () => {
  reset();
  state.newChatHost = { ...pick, selection: { hostId: 'box', harness: 'claude', model: 'remote', effort: 'removed' } };
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    assert.match(button().textContent!, /Effort unavailable/);
    assert.equal(button().querySelector('.model-effort'), null);
    await click(button());
    state.newChatHost = { id: 'other', name: 'Other', path: '/other' };
    await click($$('[role=menuitemradio]')[0]);
    assert.equal(state.newChatHost.id, 'other');
    assert.equal(state.newChatHost.selection, undefined);
  } finally {
    await m.unmount();
  }
  reset();
  machines[0].agents = [{ id: 'claude', label: 'Claude Code', state: 'ready' }];
  const old = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(button());
    state.newChatHost = null;
    await click($$('[role=menuitemradio]')[0]);
    assert.equal(state.newChatHost, null);
  } finally {
    await old.unmount();
  }
});

test('unknown machine and harness identities show waiting and never local catalogs', async () => {
  reset();
  machines = [];
  draft = { pick, want: 'custom', choice: null };
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    assert.match(button().getAttribute('title')!, /Box|box/);
    await click(button());
    assert.match(document.body.textContent!, /Waiting for Box/);
    draft = null;
    await m.render(h(HostModelPicker, { threadId: null, hostId: 'unknown' }));
    assert.match(button().getAttribute('title')!, /unknown/);
    draft = { pick, choice: null };
    await m.render(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  } finally {
    await m.unmount();
  }
  for (const id of ['custom', null]) {
    basic = id;
    const started = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
    try {
      await click(button());
      assert.match(document.body.textContent!, /Waiting for/);
    } finally {
      await started.unmount();
    }
  }
});

test('an installed agent that is signed out has a Sign in on its row; a new chat then follows it, a started chat keeps its agent (#4931)', async () => {
  reset();
  signinFails = false;
  machines[0].agents.push(
    { id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Not signed in on Box', models: [] },
    { id: 'grok', label: 'Grok', state: 'signin', reason: 'Checking on Box…', models: [] },
  );
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(button());
    await click($('button[aria-label="Select harness and model"]'));
    const rows = $$('.hp-row');
    assert.deepEqual(
      rows.map((r) => r.querySelector('.hp-heading')?.textContent?.trim().replace(/\s+/g, ' ')),
      ['Claude Code', 'Custom', 'Gemini Signed out', 'Grok Checking…'],
      'ready agents first, then each signed-out one with its state word',
    );
    // the row's group is aria-disabled, so its button says it is not (as This Mac's Sign in does), else it cannot be clicked (the first CI run)
    const signInButton = rows[2].querySelector('[aria-label="Sign in to Gemini"]')!;
    assert.equal(signInButton.getAttribute('aria-disabled'), 'false');
    assert.equal(rows[3].querySelector('[aria-label^="Sign in"]'), null, 'a read still under way has nothing to sign in to yet');
    await click(signInButton);
    assert.deepEqual(calls, [['signin', 'box', 'gemini']]);
    assert.equal(state.newChatHost.agent, 'gemini', 'the new chat follows it, so its sign-in card shows the progress');
    assert.equal($('button[aria-label="Select harness and model"]'), null, 'the list closes');
  } finally {
    await m.unmount();
  }
  reset();
  machines[0].agents.push({ id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Not signed in on Box', models: [] });
  state.chatConfig.c = { hostSelection: { hostId: 'box', harness: 'claude', model: 'gone', effort: 'high' } };
  signinFails = true;
  const started = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await click(button());
    await click(
      $$('.hp-row')
        .find((r) => r.textContent?.includes('Gemini'))!
        .querySelector('button[aria-label="Sign in to Gemini"]')!,
    );
    assert.deepEqual(calls, [['signin', 'box', 'gemini']]);
    assert.equal(state.newChatHost.agent, undefined, 'a started chat keeps its agent');
    assert.equal(toasts[0][0], 'Signing in to Gemini…');
    assert.deepEqual(
      toasts.map((t) => t[1] ?? 'info'),
      ['info', 'error'],
      'a started chat says the sign-in began (the list closes, and no card follows that chat), and a refusal reaches the user',
    );
  } finally {
    await started.unmount();
  }
});

test('a new chat whose draft points at another machine: Sign in only starts the sign-in, the draft is left as it is (#4931)', async () => {
  reset();
  signinFails = false;
  machines[0].agents.push({ id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Not signed in on Box', models: [] });
  state.newChatHost = { id: 'elsewhere', name: 'Elsewhere', path: '/x', agent: 'claude' };
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(button());
    await click($('button[aria-label="Select harness and model"]'));
    await click($('[aria-label="Sign in to Gemini"]')!);
    assert.deepEqual(calls, [['signin', 'box', 'gemini']]);
    assert.equal(state.newChatHost.agent, 'claude', 'the other machine’s draft keeps its agent');
  } finally {
    await m.unmount();
  }
});

test('an agent the machine reports no models for: only an older Host gets the row’s Update beside the note', async () => {
  reset();
  machines[0].agents = [{ id: 'custom', label: 'Custom', state: 'ready' }];
  for (const [stale, differs, buttons] of [
    [true, false, 1],
    [true, true, 0],
    [false, false, 0],
  ] as const) {
    machines[0].hostStale = stale;
    machines[0].hostDiffers = differs;
    const m = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
    try {
      await openAgent('Custom');
      const note = $$('.hp-note').find((n) => /has not reported models/.test(n.textContent!))!;
      assert.equal($$('button', note).length, buttons);
      if (buttons) assert.equal($('button', note).getAttribute('aria-label'), 'Update the Host on Box');
    } finally {
      await m.unmount();
    }
  }
});

test('C56: the note for a machine with no models says its cause: offline with Check again, an old Host with Update, else it waits', async () => {
  reset();
  machines[0].agents = [];
  machines[0].status = 'offline';
  const off = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(button());
    const note = $('.hp-note');
    assert.match(note.textContent!, /Box is offline, so its models are not shown\./);
    assert.equal($$('button', note)[0].textContent, 'Check again');
  } finally {
    await off.unmount();
  }
  machines[0].status = 'online';
  machines[0].hostStale = true;
  const stale = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(button());
    assert.match($('.hp-note').textContent!, /Box's Host is out of date and has not reported models\. Update the Host\./);
    assert.equal($('.hp-note button').getAttribute('aria-label'), 'Update the Host on Box');
  } finally {
    await stale.unmount();
  }
  machines[0].agents = [{ id: 'claude', label: 'Claude Code', state: 'ready' }];
  machines[0].hostStale = false;
  machines[0].status = 'offline';
  const flyOff = await mount(h(HostModelPicker, { threadId: 'c', hostId: 'box' }));
  try {
    await click(button());
    assert.match(document.body.textContent!, /Box is offline, so models for Claude Code are not shown\./);
  } finally {
    await flyOff.unmount();
  }
});

test('C56: Check again on the offline note asks the machines again, once at a time, and a failed check says so', async () => {
  reset();
  machines[0].agents = [];
  machines[0].status = 'offline';
  let release: () => void = () => undefined;
  let fail = false;
  let checks = 0;
  installNative(
    fakeNative({
      host: {
        check: async () => {
          checks++;
          await new Promise<void>((r) => (release = r));
          if (fail) throw new Error('no route to host');
        },
      },
    }),
  );
  toasts.length = 0;
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click(button());
    const again = () => $$('.hp-note button')[0] as HTMLButtonElement;
    await click(again());
    assert.equal(again().textContent, 'Checking…');
    assert.equal(again().disabled, true);
    await act(async () => {
      release();
      await new Promise((r) => setImmediate(r));
    });
    assert.equal(again().textContent, 'Check again');
    assert.equal(checks, 1);
    fail = true;
    await click(again());
    await act(async () => {
      release();
      await new Promise((r) => setImmediate(r));
    });
    assert.equal(toasts.at(-1)?.[1], 'error');
    assert.equal(again().textContent, 'Check again');
  } finally {
    await m.unmount();
  }
});
