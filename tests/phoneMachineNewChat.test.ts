// New chat on a machine the phone reaches itself (#4603): from the machine page, and from Home's New session while the Mac is away.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, click, flush, inputText } from './support/phone/component-kit';
import { away, local, open, path, studio, tapRow } from './support/phone/machine-page-kit';

const agents = [
  { id: 'claude', label: 'Claude Code', state: 'ready', via: 'own' },
  { id: 'codex', label: 'Codex', state: 'signin', via: null },
  { id: 'acp:made-up', label: 'acp:made-up', state: 'ready', via: 'own' },
];
const machine = { ...studio, agents };

/** The chat kit of the phone's paths, recording what the page asks of it. */
function kit() {
  const calls: any[] = [];
  let began = 0;
  return {
    calls,
    chat: {
      enabled: () => true,
      told: () => undefined,
      begin: (harness: string) => (calls.push(['begin', harness]), { chatId: `chat-${harness}-${++began}`, startId: `s${began}`, harness }),
      launch: (m: string, begun: any, input: any) => (calls.push(['launch', m, begun.chatId, input]), begun.chatId),
      titleOf: (id: string) => (id.startsWith('chat-') ? 'Fix the build please' : undefined),
      // the Mac's route is what these page tests draw; the machine route of a started chat is tested with a real kit (phoneHostThread)
      hostOf: () => undefined,
      items: () => [],
      cards: { list: () => [] },
      startedOn: () => [
        { chatId: 'chat-new', machineId: 'h1', title: 'Started here', at: 50 },
        { chatId: 'chat-listed', machineId: 'h1', title: 'Started and listed', at: 40 },
      ],
    },
  };
}

async function pageOf(k: ReturnType<typeof kit>, extra: { direct?: any } = {}) {
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  (p.direct as any).chat = k.chat;
  const host = await open({ direct: { ...p.direct, ...extra.direct }, machines: [local, machine] });
  await tapRow(/^Studio/);
  return { p, host };
}

test('the machine page offers New chat, which lists the agents the Host says are ready and starts the chat on the machine', async () => {
  const k = kit();
  const { host } = await pageOf(k);
  const page = () => document.querySelector('[data-screen="settings"]')!.textContent!;
  assert.match(page(), /New chat/);
  await click('New chat');
  await click('Back');
  assert.match(page(), /ReachDirect|Reach/, 'Back returns to the machine page');
  await click('New chat');
  assert.match(page(), /Agent on StudioClaude Code✓CodexSign in on your Macacp:made-up/, 'each agent, with why one cannot run');
  // nothing to start without a message
  const start = () => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Start') as HTMLButtonElement;
  assert.equal(start().disabled, true);
  await click('acp:made-up');
  await inputText('Folder on Studio (optional)', ' /srv/app ');
  await inputText('What should it do?', ' fix the build ');
  assert.equal(start().disabled, false);
  await click('Start');
  await flush();
  assert.deepEqual(k.calls, [
    ['begin', 'acp:made-up'],
    ['launch', 'h1', 'chat-acp:made-up-1', { text: 'fix the build', cwd: '/srv/app' }],
  ]);
  assert.equal(document.querySelector('[data-screen="settings"]'), null, 'the page closes');
  assert.match(document.querySelector('[data-stack]')!.getAttribute('data-stack')!, /chat/, 'and the chat is open');
  assert.match(document.body.textContent!, /Fix the build please/, 'called what it was asked until the machine names it');
  void host;
});

test('the machine page lists the chats this phone started there, with the Mac’s own row for one it has listed too', async () => {
  const k = kit();
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  (p.direct as any).chat = k.chat;
  await open({
    direct: p.direct,
    machines: [local, machine],
    chats: [{ id: 'chat-listed', title: 'Listed by the Mac', state: 'idle', hostId: 'h1', at: 60 }],
  });
  await tapRow(/^Studio/);
  const page = document.querySelector('[data-screen="settings"]')!.textContent!;
  assert.match(page, /ChatsListed by the Mac›Started here›/, 'newest first, the Mac’s title for the chat it lists, no copy of it');
  assert.doesNotMatch(page, /Started and listed/);
});

test('with the Mac away Home offers New session when a machine is reachable and has an agent ready; with the flag off or no machine it does not', async () => {
  const k = kit();
  const p = path({ enrolled: true });
  await p.direct.phones.load();
  (p.direct as any).chat = k.chat;
  (p.direct.phones as any).reachable = () => true;
  (p.direct.phones as any).agents = () => agents;
  const host = await open({ direct: p.direct, machines: null, snap: away, home: true });
  assert.match(host.textContent!, /New session/);
  await click('New session');
  await flush();
  assert.match(
    document.querySelector('[data-screen="settings"]')!.textContent!,
    /New chat.*Agent on Studio/s,
    'it opens New chat on that machine',
  );
  // two machines reachable: New session opens the list of machines
  const records = p.direct.phones.records;
  (p.direct.phones as any).records = () => [...records(), { machineId: 'h2', name: 'Other' }];
  await open({ direct: p.direct, machines: null, snap: away, home: true });
  await click('New session');
  await flush();
  assert.doesNotMatch(document.querySelector('[data-screen="settings"]')!.textContent!, /Agent on/);
  (p.direct.phones as any).records = records;
  // the machine is down
  (p.direct.phones as any).reachable = () => false;
  assert.doesNotMatch((await open({ direct: p.direct, machines: null, snap: away, home: true })).textContent!, /New session/);
  // no agent of its Host is ready
  (p.direct.phones as any).reachable = () => true;
  (p.direct.phones as any).agents = () => [agents[1]];
  assert.doesNotMatch((await open({ direct: p.direct, machines: null, snap: away, home: true })).textContent!, /New session/);
  // the flag is off
  (p.direct.phones as any).agents = () => agents;
  (p.direct as any).chat = { ...k.chat, enabled: () => false };
  assert.doesNotMatch((await open({ direct: p.direct, machines: null, snap: away, home: true })).textContent!, /New session/);
  void act;
});

test('the page with no agent ready starts nothing, a runtime without paths ignores Start, and the folder last used there is offered', async () => {
  const pagePath = '../mobile/src/screens/SettingsNewChat';
  const { SettingsNewChat } = await import(pagePath);
  const { rememberFolder } = await import('../mobile/src/remote/lastFolders');
  const { createRoot, createElement } = await import('./support/phone/component-kit');
  const mountPage = async (m: any, runtime: any) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(createElement(SettingsNewChat, { machine: m, runtime, back: () => undefined, opened: () => undefined })),
    );
    return { host, root };
  };
  const none = await mountPage({ ...studio, agents: [agents[1]] }, {});
  await inputText('What should it do?', 'hi');
  const start = () => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Start') as HTMLButtonElement;
  assert.equal(start().disabled, true, 'no agent is ready: nothing to start');
  await act(async () => none.root.unmount());
  rememberFolder(null, 'h1', '/srv/last');
  const ready = await mountPage(machine, {});
  assert.equal((document.querySelector('input[placeholder="Folder on Studio (optional)"]') as HTMLInputElement).value, '/srv/last');
  await inputText('What should it do?', 'hi');
  await click('Start');
  await flush();
  assert.doesNotMatch(document.body.textContent!, /Couldn/, 'a runtime with no paths of its own has nothing to start on, and says nothing');
  await act(async () => ready.root.unmount());
});
