// The machine's Harness menu names the agent a chat wants and the machine lacks (#5119): reported missing, or not reported at all, for a new chat and a started one; a signed-out agent keeps its row; a test agent is never listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mockTsx, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const MODEL: any = { id: 'remote', name: 'Remote model', default: true, efforts: ['low', 'high'], defaultEffort: 'low' };
const pick = { id: 'box', name: 'Box', path: '/remote' };
let state: any = { newChatHost: pick, chatConfig: {} };
let machines: any[] = [];
let wanted = 'claude';
let basic: string | null = 'host-claude';
mockSource('src/store/core.ts', {
  toast: () => undefined,
  useStore: (sel: any) => sel(state),
  set: () => undefined,
});
mockSource('src/store/chats.ts', { chatBasicHarness: () => basic });
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
  useHostAgentChoice: () => ({ pick, want: wanted, choice: { harness: 'claude' } }),
});
installNative(fakeNative({ host: { access: async () => true, check: async () => undefined } }));
const { createElement: h } = await import('react');
const { HostModelPicker } = await import('../src/components/composer/HostModelPicker.tsx');

const rowOf = (label: string) => $$('.hp-row').find((r) => r.textContent?.includes(label));
const titles = () => $$('.hp-row .hp-title').map((x) => x.textContent!.trim());
const withShell = (child: any) => h('div', { 'data-composer-chat': 'a', 'data-composer-main': 'true' }, child);
function reset(extra: any[] = []) {
  wanted = 'claude';
  basic = 'host-claude';
  state = { newChatHost: pick, chatConfig: {} };
  machines = [
    {
      id: 'box',
      name: 'Box',
      installable: [],
      platform: 'linux',
      agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', models: [MODEL] }, ...extra],
    },
  ];
}
async function openList(threadId: string | null) {
  const m = await mount(withShell(h(HostModelPicker, { threadId, hostId: 'box' })));
  await click($('button[aria-label="Select model"]'));
  // a chat with no usable model opens on the list itself
  const title = $('button[aria-label="Select harness and model"]');
  if (title) await click(title);
  return m;
}

test('a new chat wants an agent the Host reports not found: its row says Not installed with the hint and its fix', async () => {
  reset([{ id: 'opencode', label: 'opencode', state: 'missing', reason: 'Not installed on Box' }]);
  wanted = 'opencode';
  const m = await openList(null);
  try {
    const row = rowOf('opencode')!;
    assert.ok(row, 'the wanted agent has a row');
    assert.equal($('.hp-badge', row)!.textContent, 'Not installed');
    assert.equal($('.menu-desc', row)!.textContent, 'Install opencode on Box.');
    assert.ok($('[data-install-by-hand="opencode"]', row) || $$('.hp-mini', row).length || $$('button', row).length, 'a fix to press');
  } finally {
    await m.unmount();
  }
});

test('an agent the Host does not name at all is listed as missing too, by its catalog name', async () => {
  reset();
  wanted = 'kimi';
  const m = await openList(null);
  try {
    const row = rowOf('Kimi')!;
    assert.ok(row);
    assert.equal($('.hp-badge', row)!.textContent, 'Not installed');
    assert.match($('.menu-desc', row)!.textContent!, /^Install Kimi.* on Box\.$/);
  } finally {
    await m.unmount();
  }
});

test("a started chat's own agent missing on the machine is a row too", async () => {
  reset([{ id: 'opencode', label: 'opencode', state: 'missing', reason: '' }]);
  basic = 'opencode';
  const m = await openList('c');
  try {
    assert.ok(rowOf('opencode'));
    assert.equal($('.hp-badge', rowOf('opencode')!)!.textContent, 'Not installed');
  } finally {
    await m.unmount();
  }
});

test('an agent nobody asks for stays out, a signed-out one keeps its Sign in row, a test agent is never listed', async () => {
  reset([
    { id: 'opencode', label: 'opencode', state: 'missing', reason: '' },
    { id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Sign in on Box' },
    { id: 'fake', label: 'fake', state: 'signin', reason: 'Sign in on Box' },
  ]);
  const m = await openList(null);
  try {
    assert.equal(rowOf('opencode'), undefined, 'as This Mac, an agent not installed that nothing wants has no row');
    assert.ok($$('.hp-mini', rowOf('Gemini')!).some((b) => b.textContent === 'Sign in'));
    assert.equal(
      titles().some((t) => t.startsWith('fake')),
      false,
    );
  } finally {
    await m.unmount();
  }
  reset();
  wanted = 'fake';
  const test_ = await openList(null);
  try {
    assert.equal(rowOf('fake'), undefined, 'a test agent is never added, even when wanted');
  } finally {
    await test_.unmount();
  }
});

test('a machine that reported no agent yet gets no invented row: the menu waits for its report', async () => {
  reset();
  machines[0].agents = [];
  wanted = 'opencode';
  const m = await openList(null);
  try {
    assert.equal(rowOf('opencode'), undefined);
    assert.match(document.body.textContent!, /Waiting for Box to report its models/);
  } finally {
    await m.unmount();
  }
});
