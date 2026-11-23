// A chat on a machine moves to another agent there from the phone (mobile/src/remote/controls.ts, components/ChatModelSheet.tsx): the controls list the machine's agents with the machine's own words for what is not ready (A), the pill names the agent where a machine has no model of this Mac's to show (W), a ready agent is asked for and an unready one says why and asks nothing (B), and a held move can be called off (I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { useState } from 'react';
import { scripted } from './support/phone/m3';
import './support/phone/register.ts';
const sheetPath = '../mobile/src/components/ChatModelSheet';
const hookPath = '../mobile/src/remote/useChatControls';
const clientPath = '../mobile/src/remote/client';
const controlsPath = '../mobile/src/remote/controls';
const { ChatModelPill, ChatModelSheets, pillWords } = await import(sheetPath);
const { useChatControls } = await import(hookPath);
const { ownedRequest } = await import(clientPath);
const { loadChatControls } = await import(controlsPath);

const ALL = ['options.get', 'options.set', 'chat.switch', 'chats.pin'];
const AGENTS = [
  { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
  { id: 'codex', label: 'Codex', state: 'signin', reason: 'Sign in on Box' },
  { id: 'acp:gemini', label: 'Gemini CLI', state: 'ready', reason: '' },
  { id: 'acp:amp', label: 'Amp', state: 'missing', reason: 'Not installed on Box' },
  { id: 'acp:none', state: 'missing' },
  { label: 'No id' },
];
/** What the Mac answers for a chat on a machine: no model of this Mac's, the agent it runs on, and the machine's agents. */
const machineReply = (over: Record<string, unknown> = {}) => ({
  models: [],
  model: null,
  effort: null,
  harness: 'Claude Code',
  harnessId: 'claude',
  current: 'claude',
  switching: false,
  permission: { value: 'default', rows: [{ id: 'default', label: 'Ask', detail: 'Ask first' }] },
  machine: { id: 'ssh:box', name: 'Box', agents: AGENTS },
  ...over,
});

function mac(o: { methods?: string[]; reply?: Record<string, unknown>; over?: (method: string, params: any) => unknown } = {}) {
  const { runtime, calls } = scripted((method, p) => {
    const given = o.over?.(method, p);
    if (given !== undefined) return given;
    if (method === 'machine.hello') return { capabilities: { methods: o.methods ?? ALL, permissionCeiling: 'auto-review' } };
    if (method === 'options.get') return machineReply(o.reply);
    if (method === 'harnesses.list') return { harnesses: [{ id: 'claude', label: 'Claude Code' }] };
    if (method === 'chat.switch') return { switched: true };
    return undefined;
  });
  return { runtime, calls };
}

const mounted: any[] = [];
async function mount(runtime: any, tweak: (controls: any) => any = (c) => c) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const failures: string[] = [];
  const request = ownedRequest(runtime);
  const Probe = () => {
    const s = useChatControls(request, 'c');
    const [sheet, setSheet] = useState<any>(null);
    return createElement(
      'div',
      null,
      createElement(ChatModelPill, { controls: tweak(s.controls), open: () => setSheet('model') }),
      createElement(ChatModelSheets, {
        request,
        chatId: 'c',
        controls: tweak(s.controls),
        reload: s.reload,
        ownHarness: 'acp',
        failed: (m: string) => failures.push(m),
        clear: (m: string) => failures.includes(m) && failures.splice(failures.lastIndexOf(m), 1),
        sheet,
        setSheet,
      }),
    );
  };
  await act(async () => root.render(createElement(Probe)));
  await flush();
  return { host, failures };
}
const labels = (host: HTMLElement) => [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
const switches = (calls: any[]) => calls.filter(([c]) => c === 'chat.switch');

test("A: the controls of a chat on a machine list that machine's agents, ready or with the machine's words for why not, and never ask this Mac's list", async () => {
  const m = mac();
  const c = await loadChatControls(ownedRequest(m.runtime), 'c');
  assert.deepEqual(c.harnesses, [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex', unavailable: true, detail: 'Sign in on Box' },
    { id: 'acp:gemini', label: 'Gemini CLI' },
    { id: 'acp:amp', label: 'Amp', unavailable: true, detail: 'Not installed on Box' },
    { id: 'acp:none', label: 'acp:none', unavailable: true, detail: 'Not ready on this machine' },
  ]);
  assert.deepEqual(c.machine, { name: 'Box', current: 'claude' });
  assert.deepEqual(c.harness, { id: 'claude', label: 'Claude Code' });
  assert.equal(
    m.calls.some(([x]) => x === 'harnesses.list'),
    false,
  );
  // a Mac that moves no chat leaves the agents out, the machine's name still known; a machine with no name, or a Mac that sends none, is a chat of this Mac
  const none = await loadChatControls(ownedRequest(mac({ methods: ['options.get'] }).runtime), 'c');
  assert.deepEqual([none.harnesses, none.methods.agent, none.machine?.name], [[], false, 'Box']);
  const unnamed = await loadChatControls(ownedRequest(mac({ reply: { machine: { agents: AGENTS } } }).runtime), 'c');
  assert.equal(unnamed.machine, undefined);
  assert.deepEqual(unnamed.harnesses, [{ id: 'claude', label: 'Claude Code' }]);
  const bare = await loadChatControls(ownedRequest(mac({ reply: { machine: { name: 'Box' }, current: undefined } }).runtime), 'c');
  assert.deepEqual([bare.harnesses, bare.machine], [[], { name: 'Box', current: null }]);
});

test('W: where a machine has no model of this Mac’s to show, the pill names the agent the chat runs on, and the sheet it opens has the Agent row', async () => {
  const m = mac();
  const v = await mount(m.runtime);
  assert.ok(v.host.querySelector('button[aria-label="Model, Claude Code"]'));
  await click('Model, Claude Code');
  assert.ok(labels(v.host).includes('Agent, Claude Code'));
  // a Mac chat without models and without a machine still shows no pill
  assert.equal(pillWords({ options: { models: [] }, machine: undefined, harness: { id: 'claude', label: 'Claude Code' } }), null);
  assert.equal(pillWords({ options: { models: [] }, machine: { name: 'Box', current: null }, harness: null }), null);
  assert.equal(pillWords(null), null);
});

test('B: a ready agent is asked for with one chat.switch; one that is not ready says why in the machine’s words and asks nothing', async () => {
  const m = mac();
  const v = await mount(m.runtime);
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  const list = v.host.textContent!;
  assert.match(list, /Sign in on Box/);
  assert.match(list, /Not installed on Box/);
  await click('Codex, not available: Sign in on Box');
  assert.deepEqual(v.failures, ['Sign in on Box']);
  assert.equal(switches(m.calls).length, 0);
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  await click('Gemini CLI');
  await flush();
  assert.deepEqual(switches(m.calls), [['chat.switch', { chatId: 'c', harness: 'acp:gemini' }]]);
  // the agent it already runs on moves nothing
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  await click('Claude Code, current agent');
  assert.equal(switches(m.calls).length, 1);
});

test('B: the Mac’s refusal of a move (an older Host, a machine out of reach) is the line the chat shows', async () => {
  const m = mac({ over: (method) => (method === 'chat.switch' ? Promise.reject(new Error('Update Box to switch agents.')) : undefined) });
  const v = await mount(m.runtime);
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  await click('Gemini CLI');
  await flush();
  assert.deepEqual(v.failures, ['Update Box to switch agents.']);
});

test('I: a move that waits for the next message says so, and the chat’s own agent from the machine calls it off', async () => {
  const m = mac({ reply: { harnessId: 'acp:gemini', harness: 'Gemini CLI', switching: true, current: 'claude' } });
  const v = await mount(m.runtime);
  assert.ok(v.host.querySelector('button[aria-label="Model, Gemini CLI"]'));
  await click('Model, Gemini CLI');
  await click('Agent, Gemini CLI');
  assert.match(v.host.textContent!, /Next message continues on Gemini CLI/);
  await click('Undo, stay on Claude Code');
  await flush();
  assert.deepEqual(switches(m.calls), [['chat.switch', { chatId: 'c', harness: 'claude' }]]);
});

test('B: an agent marked not ready with no reason says it is not ready on the machine, and a machine that does not say which agent runs the chat still lists them', async () => {
  const m = mac({ reply: { current: undefined } });
  const v = await mount(m.runtime, (c) =>
    c?.harnesses ? { ...c, harnesses: [...c.harnesses, { id: 'acp:x', label: 'Xeno', unavailable: true }] } : c,
  );
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  await click('Xeno, not available: not ready on this machine');
  assert.deepEqual(v.failures, ['Xeno is not ready on this machine.']);
  assert.equal(switches(m.calls).length, 0);
});

const button = (host: HTMLElement, label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null;

test('A: an agent that cannot be chosen reads as unavailable (dimmed, its reason in its label), stays pressable to show why, and a ready one does not', async () => {
  const m = mac();
  const v = await mount(m.runtime);
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  const gemini = button(v.host, 'Codex, not available: Sign in on Box')!;
  assert.ok(gemini, 'the reason is in the label');
  assert.equal(gemini.getAttribute('aria-disabled'), 'true', 'read as dimmed');
  assert.ok(button(v.host, 'Amp, not available: Not installed on Box'));
  const ready = button(v.host, 'Gemini CLI')!;
  assert.equal(ready.getAttribute('aria-disabled'), null, 'a ready one is not dimmed');
  // the agent the chat is on is the selected one and says so; the others do not
  const own = button(v.host, 'Claude Code, current agent')!;
  assert.equal(own.getAttribute('aria-selected'), 'true');
  assert.equal(ready.getAttribute('aria-selected'), null);
  // dimmed, yet still pressable: it shows the reason and moves nothing
  await click('Codex, not available: Sign in on Box');
  assert.deepEqual(v.failures, ['Sign in on Box']);
  assert.equal(switches(m.calls).length, 0);
});

test('A: a held move names where the next message continues, the Undo row has a label of its own, and the current agent says so too', async () => {
  const m = mac({ reply: { harnessId: 'acp:gemini', harness: 'Gemini CLI', switching: true, current: 'claude' } });
  const v = await mount(m.runtime);
  await click('Model, Gemini CLI');
  await click('Agent, Gemini CLI');
  assert.ok(button(v.host, 'Gemini CLI, the next message continues here'), 'the chosen row says it is where the next message goes');
  assert.equal(button(v.host, 'Gemini CLI, the next message continues here')!.getAttribute('aria-selected'), 'true');
  assert.ok(button(v.host, 'Claude Code'), 'the agent it is on now is a plain row while the move waits');
  const undo = button(v.host, 'Undo, stay on Claude Code')!;
  assert.ok(undo, 'Undo names where it stays');
  assert.notEqual(undo.getAttribute('aria-label'), button(v.host, 'Claude Code')!.getAttribute('aria-label'));
});

test('A: the sheet’s line goes when its next pick works, when a sheet is opened or closed, and another control’s line stays', async () => {
  let refuse = true;
  const m = mac({
    over: (method) => (method === 'chat.switch' && refuse ? Promise.reject(new Error('The machine refused the move.')) : undefined),
  });
  const v = await mount(m.runtime);
  // a refused move puts its words up; the next move that works takes them back
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  await click('Gemini CLI');
  await flush();
  assert.deepEqual(v.failures, ['The machine refused the move.']);
  refuse = false;
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  assert.deepEqual(v.failures, [], 'opening the sheet again is a change: the old line goes');
  // a not-ready agent's reason goes when the sheet is closed
  await click('Codex, not available: Sign in on Box');
  assert.deepEqual(v.failures, ['Sign in on Box']);
  await click('Dismiss');
  assert.deepEqual(v.failures, []);
  // a line some other control set is not the sheet's to take
  (v.failures as string[]).push('The Stop did not reach the Mac.');
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  assert.deepEqual(v.failures, ['The Stop did not reach the Mac.']);
});
