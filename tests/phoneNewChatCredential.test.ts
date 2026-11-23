// New chat on a machine names what the chat will use before its first message, offers a choice only when the machine has more than one source, sends the pick, shows the Host's refusal in its words, and says so when an older Host cannot tell.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { flush } from './support/phone/component-kit';
import { scripted, fakeMedia, menus } from './support/phone/m3';
import { mount, has, button, chip, tap, typeIn, row } from './support/phone/newchat-kit';

const foldersMemory = '../mobile/src/remote/lastFolders';
const { forgetFolders } = await import(foldersMemory);
beforeEach(() => forgetFolders());

const SNAP = { phase: 'online', generation: 1, selectedPair: 'p', pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }], presence: {} };
const claude = (extra: any = {}) => ({ id: 'claude', label: 'Claude Code', state: 'ready', via: 'own', ...extra });
const BOTH = { using: 'key', sources: { own: true, key: true, org: false } };
const FOLDERS = (p: any) =>
  p.path
    ? { path: p.path, roots: [], entries: [], more: false }
    : { path: null, roots: ['/home/du/code'], entries: [{ name: 'code', path: '/home/du/code', git: true }], more: false };

async function onMachine(agents: any[], start?: (p: any) => unknown) {
  const { runtime, calls } = scripted((m, p) => {
    if (m === 'machine.hello') return { ...menus.hello, capabilities: { ...menus.hello.capabilities, machines: true } };
    if (m === 'machines.list')
      return {
        machines: [
          { id: 'local', name: 'Studio Mac', status: 'online', line: 'This Mac', tone: 'ok', agents: [] },
          { id: 'h1', name: 'Box', status: 'online', line: 'Online', tone: 'ok', agents },
        ],
      };
    if (m === 'machines.folders') return FOLDERS(p);
    if (m === 'chat.start') return start ? start(p) : { chatId: 'c:new' };
    return undefined;
  });
  runtime.onEvent = () => () => undefined;
  const screen = await mount(runtime, fakeMedia().media, {}, SNAP);
  await flush();
  await tap(chip(screen.host, 'Computer'));
  await row('Box');
  return { ...screen, calls };
}
const starts = (calls: any[]) => calls.filter((c) => c[0] === 'chat.start').map((c) => c[1]);
async function startIt(screen: any) {
  await typeIn('go');
  await tap(chip(screen.host, 'Folder'));
  await row('code');
  await tap(button(document.body, 'Use this folder')!);
  await tap(button(screen.host, 'Start chat')!);
}

test('Claude Code on a machine with a key and its own login: the line says what it will use, the Sign-in chip offers both, and a pick is sent', async () => {
  const s = await onMachine([claude(BOTH)]);
  has(s.host, /Your Mac's key · pay per use/);
  await tap(chip(s.host, 'Sign-in'));
  has(document.body, /Now|Automatic/);
  await row('Signed in on Box');
  assert.match(chip(s.host, 'Sign-in').textContent!, /Signed in on Box/);
  has(s.host, /Signed in on Box/, 'the line follows the pick');
  await startIt(s);
  assert.deepEqual(starts(s.calls)[0].credential, { source: 'own' });
});

test('Automatic sends no choice, and a pick belongs to one agent: another agent starts over', async () => {
  const s = await onMachine([
    claude(BOTH),
    { id: 'codex', label: 'Codex', state: 'ready', via: 'key', using: 'own', sources: { own: true, key: false, org: false } },
  ]);
  await startIt(s);
  assert.equal('credential' in starts(s.calls)[0], false);
  const t = await onMachine([claude(BOTH)]);
  await tap(chip(t.host, 'Sign-in'));
  await row("Your Mac's key · pay per use");
  assert.match(chip(t.host, 'Sign-in').textContent!, /pay per use/);
  await tap(chip(t.host, 'Sign-in'));
  await row('Automatic');
  assert.match(chip(t.host, 'Sign-in').textContent!, /Automatic/);
});

test('one source is no choice: the line names it, there is no chip; an agent with one sign-in (ACP) says what it uses and offers nothing', async () => {
  const one = await onMachine([claude({ using: 'own', sources: { own: true, key: false, org: false } })]);
  has(one.host, /Signed in on Box/);
  assert.equal(chip(one.host, 'Sign-in'), undefined);
  const acp = await onMachine([
    {
      id: 'gemini',
      label: 'Gemini',
      state: 'ready',
      via: 'own',
      using: 'own',
      sources: { own: true, key: false, org: false },
      loginsSupported: false,
    },
  ]);
  has(acp.host, /Signed in on Box/);
  assert.equal(chip(acp.host, 'Sign-in'), undefined);
});

test('the Host’s refusal of a choice reaches the person in its own words, and nothing else is claimed', async () => {
  const words =
    "This agent runs all its chats in one process on this machine, and that process is using what your Mac lent it, so one chat can't use this machine's own login yet.";
  const s = await onMachine(
    [{ id: 'codex', label: 'Codex', state: 'ready', via: 'key', using: 'key', sources: { own: true, key: true, org: false } }],
    () => Promise.reject(Object.assign(new Error(words), { code: 'credential_unavailable' })),
  );
  await tap(chip(s.host, 'Sign-in'));
  await row('Signed in on Box');
  await startIt(s);
  has(s.host, /one chat can't use this machine's own login yet/);
  assert.deepEqual(starts(s.calls)[0].credential, { source: 'own' });
});

test('an older Host that does not say what a chat uses: the line is hidden, the screen says to update it, and no choice is sent', async () => {
  const s = await onMachine([claude()]);
  has(s.host, /Update MoPilot on Box to see what this chat uses/);
  assert.equal(chip(s.host, 'Sign-in'), undefined);
  await startIt(s);
  assert.equal('credential' in starts(s.calls)[0], false);
  // an agent that is not ready on the machine says nothing of it
  const down = await onMachine([claude({ state: 'signin' })]);
  assert.doesNotMatch(down.host.textContent!, /Update MoPilot on Box/);
});

test('a pick is dropped when another agent is chosen', async () => {
  const s = await onMachine([
    claude(BOTH),
    { id: 'codex', label: 'Codex', state: 'ready', via: 'key', using: 'own', sources: { own: true, key: false, org: false } },
  ]);
  await tap(chip(s.host, 'Sign-in'));
  await row('Signed in on Box');
  await tap(chip(s.host, 'Agent'));
  await row('Codex');
  assert.equal(chip(s.host, 'Sign-in'), undefined, 'Codex here has one source');
  await startIt(s);
  assert.equal('credential' in starts(s.calls)[0], false, 'the pick belonged to Claude Code');
});
