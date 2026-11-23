// The machine picker's rows say it once and are never a dead end (#5072): a missing agent has the local hint and its fix (Install, Update, or the vendor's command with Open terminal over ssh); a new chat keeps the effort This Mac would show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mockTsx, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const MODEL: any = { id: 'remote', name: 'Remote model', default: true, efforts: ['low', 'medium', 'high'], defaultEffort: null };
const pick = { id: 'box', name: 'Box', path: '/remote' };
let state: any = { newChatHost: pick, chatConfig: {} };
let machines: any[] = [];
let wanted = 'claude';
mockSource('src/store/core.ts', {
  toast: () => undefined,
  useStore: (sel: any) => sel(state),
  set: (patch: any) => void Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
});
mockSource('src/store/chats.ts', { chatBasicHarness: () => 'host-claude' });
mockSource('src/store/projects.ts', { setChatConfig: () => undefined });
mockSource('src/store/panes.ts', { navigate: () => undefined });
const mark = { type: 'span', props: { className: 'mark' }, key: null, ref: null, $$typeof: Symbol.for('react.transitional.element') };
mockTsx(new URL('../src/components/harnessPicker/badges.tsx', import.meta.url), {
  HarnessIcon: () => mark,
  BasicHarnessIcon: () => mark,
  BasicBadge: () => mark,
});
mockSource('src/store/session/useSession.ts', { useSessionField: () => null, setSession: async () => undefined });
mockSource('src/store/machineChatSwitch.ts', {
  agentOfKind: () => null,
  switchMachineChat: async () => null,
  dropMachineSwitch: async () => undefined,
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines }) });
mockSource('src/session/useHostAgentChoice.ts', {
  useHostAgentChoice: () => ({ pick, want: wanted, choice: { harness: wanted } }),
});
const fake = fakeNative({
  host: {
    access: async () => true,
    check: async () => undefined,
    update: async () => undefined,
    installAgent: async (id: string, harness: string) => ({ hostId: id, harness, state: 'queued', line: '', error: null, version: null }),
  },
});
installNative(fake);
const { createElement: h } = await import('react');
const { HostModelPicker } = await import('../src/components/composer/HostModelPicker.tsx');

const rowOf = (label: string) => $$('.hp-row').find((r) => r.textContent?.includes(label))!;
const listButton = () => $('button[aria-label="Select harness and model"]');
const withShell = (child: any) => h('div', { 'data-composer-chat': 'a', 'data-composer-main': 'true' }, child);
function reset(over: Record<string, unknown> = {}, models: any[] = [MODEL], id = 'box', saved?: unknown) {
  state = { newChatHost: { ...pick, id, ...(saved ? { selection: saved } : {}) }, chatConfig: {} };
  machines = [
    {
      id,
      name: 'Box',
      installable: [],
      platform: 'linux',
      agents: [
        { id: 'claude', label: 'Claude Code', state: 'ready', models },
        { id: 'codex', label: 'Codex', state: 'missing', reason: 'Not installed on Box' },
        { id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Sign in on Box' },
        { id: 'grok', label: 'Grok', state: 'signin', reason: "Box's keychain is locked. Log in on its screen once, or sign in again." },
      ],
      ...over,
    },
  ];
}
async function openRows() {
  await click($('button[aria-label="Select model"]'));
  await click(listButton());
}

test('a missing agent says where to install once, and its fix is the Host install when the Host reports it', async () => {
  reset({ installable: ['codex'] });
  const m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    await openRows();
    assert.match(rowOf('Codex').textContent!, /Install Codex on Box\./);
    assert.doesNotMatch(rowOf('Codex').textContent!, /Not installed on Box/);
    assert.ok($$('.hp-mini', rowOf('Codex')).some((b) => b.textContent === 'Install on Box'));
    assert.equal($('.install-by-hand'), null, 'the by-hand command is for a Host that cannot install');
  } finally {
    await m.unmount();
  }
});

test("a Host too old to install gets the machine row's Update on the missing row", async () => {
  reset({ hostStale: true });
  const m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    await openRows();
    const update = $$('button', rowOf('Codex')).find((b) => b.getAttribute('aria-label') === 'Update the Host on Box')!;
    assert.ok(update);
    assert.equal($('.install-by-hand'), null);
    await click(update);
    assert.deepEqual(fake.callsTo('host.update').pop(), ['box']);
  } finally {
    await m.unmount();
  }
});

test('a Host that neither installs nor needs an update: the vendor command; over ssh Open terminal opens it', async () => {
  reset({}, [MODEL], 'ssh:me@box');
  const m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'ssh:me@box' })));
  try {
    await openRows();
    assert.ok($('[data-install-by-hand="codex"]', rowOf('Codex')));
    const open = $$('.hp-mini', rowOf('Codex')).find((b) => b.textContent === 'Open terminal')!;
    await click(open);
    assert.equal(state.bottomPanelOpen, true, "the bottom terminal panel opens: its shell on this machine comes from the chat's machine");
    assert.equal($('.hp-harnesses'), null, 'the picker closes');
  } finally {
    await m.unmount();
  }
  // a machine with no ssh from here: the hint and the vendor command, no terminal
  reset();
  const plain = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    await openRows();
    assert.ok($('[data-install-by-hand="codex"]', rowOf('Codex')));
    assert.equal($$('.hp-mini', rowOf('Codex')).length, 0);
  } finally {
    await plain.unmount();
  }
});

test('a signed-out row says its cause only: the badge and Sign in say the rest', async () => {
  reset();
  const m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    await openRows();
    assert.doesNotMatch(rowOf('Gemini').textContent!, /Sign in on Box/);
    assert.ok($$('.hp-mini', rowOf('Gemini')).some((b) => b.textContent === 'Sign in'));
    assert.match(rowOf('Grok').textContent!, /keychain is locked/);
  } finally {
    await m.unmount();
  }
});

test('a new chat on a Host that reports no default effort starts on High and keeps it as its pick; a reported one is left alone', async () => {
  reset();
  const m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    assert.equal($('.model-effort')!.textContent, 'High');
    assert.deepEqual(state.newChatHost.selection, { hostId: 'box', harness: 'claude', model: 'remote', effort: 'high' });
    await click($('button[aria-label="Select model"]'));
    assert.equal($('.effort-name')!.textContent, 'High');
  } finally {
    await m.unmount();
  }
  reset({}, [{ ...MODEL, defaultEffort: 'medium' }]);
  const reported = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    assert.equal($('.model-effort')!.textContent, 'Medium');
    assert.equal(state.newChatHost.selection, undefined);
  } finally {
    await reported.unmount();
  }
  // a started chat never writes a pick by itself
  reset();
  const started = await mount(withShell(h(HostModelPicker, { threadId: 'c', hostId: 'box' })));
  try {
    assert.equal(state.newChatHost.selection, undefined);
  } finally {
    await started.unmount();
  }
});

test('a new chat starts on the effort a new local chat remembers when the model offers it; else the Host default, else the shared rule; a started chat keeps its pick', async () => {
  const mounted = async (threadId: string | null) => mount(withShell(h(HostModelPicker, { threadId, hostId: 'box' })));
  // remembered Medium, offered: the chip and the panel show Medium, and the pick keeps it
  reset();
  state.prefs = { claudeSelection: { effort: 'medium' } };
  let m = await mounted(null);
  try {
    assert.equal($('.model-effort')!.textContent, 'Medium');
    assert.equal(state.newChatHost.selection.effort, 'medium');
    await click($('button[aria-label="Select model"]'));
    assert.equal($('.effort-name')!.textContent, 'Medium');
  } finally {
    await m.unmount();
  }
  // remembered but not offered by the model: the Host's default
  reset({}, [{ ...MODEL, efforts: ['low', 'high'], defaultEffort: 'low' }]);
  state.prefs = { claudeSelection: { effort: 'medium' } };
  m = await mounted(null);
  try {
    assert.equal($('.model-effort')!.textContent, 'Low');
    assert.equal(state.newChatHost.selection, undefined, 'the Host default needs no pick');
  } finally {
    await m.unmount();
  }
  // nothing remembered, a Host default: the Host's
  reset({}, [{ ...MODEL, defaultEffort: 'medium' }]);
  state.prefs = { claudeSelection: { effort: null } };
  m = await mounted(null);
  try {
    assert.equal($('.model-effort')!.textContent, 'Medium');
  } finally {
    await m.unmount();
  }
  // neither: the shared rule
  reset();
  state.prefs = { claudeSelection: { effort: null } };
  m = await mounted(null);
  try {
    assert.equal($('.model-effort')!.textContent, 'High');
  } finally {
    await m.unmount();
  }
  // a started chat never takes the remembered effort
  reset();
  state.prefs = { claudeSelection: { effort: 'medium' } };
  m = await mounted('c');
  try {
    assert.equal($('.model-effort')!.textContent, 'High');
    assert.equal(state.newChatHost.selection, undefined);
  } finally {
    await m.unmount();
  }
});

test("a new Codex chat on a machine starts on what a new local Codex chat shows: the remembered pick, else this Mac's config file, else the Host's default", async () => {
  const codex = (over: Record<string, unknown> = {}) => {
    machines[0].agents[1] = {
      id: 'codex',
      label: 'Codex',
      state: 'ready',
      models: [{ ...MODEL, efforts: ['low', 'medium', 'high'], ...over }],
    };
  };
  wanted = 'codex';
  try {
    // this Mac's config file says Medium and nothing is remembered
    reset();
    codex();
    state.prefs = { effort: null };
    state.config = { model_reasoning_effort: 'medium' };
    let m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
    try {
      assert.equal($('.model-effort')!.textContent, 'Medium');
      assert.equal(state.newChatHost.selection.effort, 'medium', "sent with the chat, so the machine agent's own config does not matter");
    } finally {
      await m.unmount();
    }
    // a remembered pick wins over the config file, as locally
    reset();
    codex();
    state.prefs = { effort: 'high' };
    state.config = { model_reasoning_effort: 'medium' };
    m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
    try {
      assert.equal($('.model-effort')!.textContent, 'High');
    } finally {
      await m.unmount();
    }
    // a level the machine's model does not offer: the Host's default
    reset();
    codex({ efforts: ['low', 'high'], defaultEffort: 'low' });
    state.prefs = { effort: null };
    state.config = { model_reasoning_effort: 'medium' };
    m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
    try {
      assert.equal($('.model-effort')!.textContent, 'Low');
    } finally {
      await m.unmount();
    }
  } finally {
    wanted = 'claude';
  }
});

test('every action in a disabled row is pressable and does its work: no ancestor reads as disabled, each click reaches its handler', async () => {
  const noDisabledAncestor = (el: Element) =>
    assert.equal(el.closest('[aria-disabled="true"]'), null, 'the choice is disabled, its actions are not');
  // a Host that cannot install Codex, reached over ssh: Copy, Check again, Open terminal
  reset({}, [MODEL], 'ssh:me@box');
  let m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'ssh:me@box' })));
  try {
    await openRows();
    assert.ok($('.hp-row[data-disabled]'));
    const codexRow = rowOf('Codex');
    const copy = $$('button', codexRow).find((b) => b.getAttribute('aria-label') === 'Copy the Codex command')!;
    const check = $$('button', codexRow).find((b) => b.textContent === 'Check again')!;
    const terminal = $$('.hp-mini', codexRow).find((b) => b.textContent === 'Open terminal')!;
    for (const el of [copy, check, terminal]) noDisabledAncestor(el);
    await click(copy);
    assert.deepEqual(fake.callsTo('clipboard.write').pop(), ['curl -fsSL https://chatgpt.com/codex/install.sh | sh']);
    await click(check);
    assert.equal(fake.callsTo('host.check').length > 0, true, 'Check again asks the Host to check');
    await click(terminal);
    assert.equal(state.bottomPanelOpen, true, "the bottom terminal panel opens: its shell on this machine comes from the chat's machine");
  } finally {
    await m.unmount();
  }
  // Install, Update and Sign in sit in the same kind of row
  reset({ installable: ['codex'] });
  m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    await openRows();
    const install = $$('.hp-mini', rowOf('Codex')).find((b) => b.textContent === 'Install on Box')!;
    noDisabledAncestor(install);
    await click(install);
    assert.deepEqual(fake.callsTo('host.installAgent').pop(), ['box', 'codex']);
    const signIn = $$('.hp-mini', rowOf('Gemini')).find((b) => b.textContent === 'Sign in')!;
    noDisabledAncestor(signIn);
    await click(signIn);
    assert.deepEqual(fake.callsTo('host.signin').at(-1), ['box', 'gemini']);
  } finally {
    await m.unmount();
  }
  reset({ hostStale: true });
  m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    await openRows();
    const update = $$('button', rowOf('Codex')).find((b) => b.getAttribute('aria-label') === 'Update the Host on Box')!;
    noDisabledAncestor(update);
    await click(update);
    assert.deepEqual(fake.callsTo('host.update').pop(), ['box']);
  } finally {
    await m.unmount();
  }
});
