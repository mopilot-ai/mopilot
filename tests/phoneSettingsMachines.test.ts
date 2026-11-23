// Settings › Computers lists the Mac's Hosts from machines.list in the Mac's own words, each with a page of its agents; the Mac's own page lists its agents; nothing shows without Host access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, openComputer } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

const online = {
  phase: 'online',
  generation: 1,
  user: { id: 'u', email: 'dana@example.com' },
  pairs: [{ pairId: 'p1', macId: 'm1', name: 'MacBook Pro' }],
  selectedPair: 'p1',
  safetyNumber: null,
  pendingPair: false,
  error: null,
};
const local = {
  id: 'local',
  name: 'MacBook Pro',
  status: 'online',
  line: 'Online',
  tone: 'ok',
  keepRunning: null,
  agents: [
    { id: 'claude', label: 'Claude Code', state: 'ready', via: 'own' },
    { id: 'codex', label: 'Codex', state: 'signin', via: null },
  ],
};
const studio = {
  id: 'h1',
  name: 'Studio',
  status: 'online',
  line: 'Online · direct',
  tone: 'ok',
  keepRunning: true,
  agents: [
    { id: 'claude', label: 'Claude Code', state: 'ready', via: 'key' },
    { id: 'codex', label: 'Codex', state: 'ready', via: 'org' },
  ],
};
const mini = {
  id: 'h3',
  name: 'Old mini',
  status: 'offline',
  line: 'Offline · last seen 2 d ago',
  tone: 'off',
  keepRunning: false,
  agents: [],
};
const lab = {
  id: 'h2',
  name: 'Lab box',
  status: 'offline',
  line: 'Restarted · waiting for sign-in',
  tone: 'warn',
  keepRunning: null,
  agents: [],
};

const mounted: any[] = [];
/** A row of the Settings sheet by its label: the drawer under it lists the same machines. */
async function tapRow(label: string) {
  const sheet = document.querySelector('[data-screen="settings"]')!;
  const row = [...sheet.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as HTMLElement;
  assert.ok(row, label);
  await act(async () => row.click());
  await flush();
}
async function open(machines: unknown, hello: unknown = { capabilities: { machines: true } }) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const s = scripted(
    (m) => (m === 'chats.recent' ? { chats: [] } : m === 'machine.hello' ? hello : m === 'machines.list' ? machines : undefined),
    online,
  );
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  await click('Settings');
  await flush();
  return { host, s };
}

test('each Host is a row with the line and tone the Mac gives, and its page lists its agents and where their sign-in lives', async () => {
  const { host } = await open({ machines: [local, studio, lab] });
  const text = host.textContent!;
  assert.match(text, /StudioOnline · direct/);
  assert.match(text, /Lab boxRestarted · waiting for sign-in/, 'the Mac’s words, not re-derived');
  assert.ok(text.indexOf('Lab box') < text.indexOf('Add a computer'), 'Hosts sit in the Computers group, above Add a computer');
  await tapRow('Studio, Online · direct');
  assert.match(host.textContent!, /StatusOnline · direct/);
  assert.match(host.textContent!, /Keep runningOn/);
  assert.match(host.textContent!, /Claude CodeUses your Mac's key · new turns need your Mac online/);
  assert.match(host.textContent!, /CodexOrganization sign-in/);
  await click('Back');
  await tapRow('Lab box, Restarted · waiting for sign-in');
  assert.doesNotMatch(host.textContent!, /Keep running|Agents/, 'nothing reported, nothing drawn');
  assert.match(host.textContent!, /Change this machine on your Mac/);
});

test("the Mac's own page lists its agents; a missing sign-in points at the Mac", async () => {
  const { host } = await open({ machines: [local, studio] });
  await openComputer('MacBook Pro');
  assert.match(host.textContent!, /AgentsClaude CodeReadyCodexSign in on your Mac/);
});

test('without Host access, or a Mac that does not say it has Hosts, Computers shows only the paired Mac', async () => {
  for (const [machines, hello] of [
    [{ machines: [local] }, { capabilities: { machines: true } }],
    [{ machines: [local, studio] }, { capabilities: {} }],
  ] as const) {
    const { host, s } = await open(machines, hello);
    assert.doesNotMatch(host.textContent!, /Studio/);
    assert.match(host.textContent!, /Computers▭MacBook ProConnected›\+Add a computer/);
    await openComputer('MacBook Pro');
    assert.doesNotMatch(host.textContent!, /Agents/);
    if (!(hello as any).capabilities.machines) assert.ok(!s.calls.some(([m]) => m === 'machines.list'), 'never asked');
  }
});

test('a Host that is away shows gray with the Mac’s words, and a Keep running that is off says so', async () => {
  const { host } = await open({ machines: [local, mini] });
  assert.match(host.textContent!, /Old miniOffline · last seen 2 d ago/);
  await tapRow('Old mini, Offline · last seen 2 d ago');
  assert.match(host.textContent!, /StatusOffline · last seen 2 d ago/);
  assert.match(host.textContent!, /Keep runningOff/);
});
