// The phone app shell on the real stack (#4619): MobileApp with the real runtime, over the real relay, to the dev host with a real Host in a machine and the Mac stand-in asleep; every assertion is read from the rendered tree, not from the data layer.
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { act, click, createElement, createRoot, flush, inputText } from './support/phone/component-kit';
import { startPhone, until } from './support/mobileStack.ts';
import { fakeKit } from './support/fakeRealHostKit.ts';
import { startRealHost } from '../scripts/mobile-dev-host/realHost.mjs';
import { createPhoneEnroll } from '../scripts/mobile-dev-host/realHostKit.mjs';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';

const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);
const scratch = mkdtempSync(path.join(tmpdir(), 'app-real-host-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const relayOf = (host: any) =>
  ({
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  }) as any;

const mounted: { el: Element; root: any }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.el.remove();
  }
});

async function world() {
  const dir = path.join(scratch, `w${Math.random().toString(36).slice(2)}`);
  const real = await startRealHost({
    vm: 'mopilot-bench',
    dir,
    log: () => undefined,
    kit: fakeKit().k,
    createPhoneEnroll,
    relayPort: 8787,
    now: () => 1000,
  });
  const host = await startHost({
    dir,
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
    sleep: async () => undefined,
    realHost: real,
  });
  after(() => host.stop());
  const flag = { load: async () => undefined, on: () => true, why: () => 'build', told: () => undefined, subscribe: () => () => undefined };
  const phone = await startPhone(relayOf(host), { userId: 'dev-user', relayUrl: host.relayUrl, hostChat: flag });
  await phone.pair((await host.pair()).qr, 'Test iPhone');
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await host.scenarios.run('direct', ['on']);
  await phone.runtime.direct!.phones.setUp('ssh:mopilot-bench');
  const mount = async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ el, root });
    await act(async () => root.render(createElement(MobileApp, { runtime: phone.runtime })));
    return { el, root };
  };
  return { host, phone, mount };
}

const NEEDS_HOST = 'the stack has no Host process on the relay yet: the phone’s session to the Host never answers';

/** Home with one of the Mac's chats owned by the real Host's machine, the machine page open on it. */
async function ownedChat(w: Awaited<ReturnType<typeof world>>) {
  const recent = await w.phone.ask('chats.recent', { limit: 5 });
  const chatId: string = recent.chats[0].id;
  await w.phone.ask('chat.move', { chatId, hostId: 'ssh:mopilot-bench', folder: '/Users/dev/mopilot', carry: 'none' });
  return chatId;
}
const text = (el: Element) => el.textContent ?? '';
const screen = () => document.querySelector('[data-screen="settings"]');
async function openMachinePage(el: Element) {
  await click('Settings');
  await flush();
  const row = [...screen()!.querySelectorAll('button')].find((b) =>
    /mopilot-bench/.test(b.getAttribute('aria-label') ?? ''),
  ) as HTMLElement;
  await act(async () => row.click());
  await flush();
}

test('Home shows the machine as Direct and the chat that runs on it, and the machine page lists that chat, with the Mac up and with it asleep', async () => {
  const w = await world();
  await ownedChat(w);
  const { el } = await w.mount();
  await until(() => /Clean up the generated files/.test(text(el)), 'the chat on Home');
  assert.match(text(el), /mopilot-bench[^▭]*Direct/);
  await openMachinePage(el);
  assert.match(text(screen()!), /Reach.*Direct.*ChatsClean up the generated files/s, 'the page lists the chat the Mac says runs there');
  await click('Back');
  await click('Close');
  void w.host.scenarios.run('sleep', ['600']);
  await until(() => w.phone.snap().phase !== 'online', 'the Mac away', 15000);
  await flush();
  await until(
    () => /Asleep/.test(text(el)) && /Running on mopilot-bench · Your Mac is offline/.test(text(el)),
    'the Mac asleep on Home',
    15000,
  );
  await openMachinePage(el);
  assert.match(text(screen()!), /ChatsClean up the generated files/, 'and it still does with the Mac asleep');
});

test('Settings › About says whether chats on machines are on, and why', async () => {
  const w = await world();
  const { el } = await w.mount();
  await until(() => /Connected/.test(text(el)), 'the Mac connected');
  await click('Settings');
  const about = [...screen()!.querySelectorAll('button')].find((b) =>
    /About/.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  ) as HTMLElement;
  assert.ok(about, [...screen()!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).join('|'));
  await act(async () => about.click());
  await flush();
  assert.match(text(screen()!), /Chats on machinesOn · this build/);
  void el;
});

// What is still out of reach through the rendered tree: each needs a Host that answers the phone over the relay.
test('a chat that runs on the Host opens with its history while the Mac is asleep, a message starts a turn, Stop cancels it', {
  todo: NEEDS_HOST,
}, async () => {
  const w = await world();
  const chatId = await ownedChat(w);
  const { el } = await w.mount();
  void w.host.scenarios.run('sleep', ['600']);
  await until(() => w.phone.snap().phase !== 'online', 'the Mac away', 15000);
  await flush();
  const row = [...el.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') ?? '').includes('Clean up the generated files'),
  ) as HTMLElement;
  await act(async () => row.click());
  await until(() => !/Waiting for your computer/.test(text(el)) && /\bhi\b/i.test(text(el)), 'the history from the Host', 3000);
  assert.ok(chatId);
});

for (const macAway of [false, true]) {
  test(`New chat on the machine with the Mac ${macAway ? 'asleep' : 'awake'}: the chat opens with the prompt and the reply streams in the same chat (a chat only the machine knows is the machine's)`, {
    todo: NEEDS_HOST,
  }, async () => {
    const w = await world();
    const { el } = await w.mount();
    if (macAway) {
      void w.host.scenarios.run('sleep', ['600']);
      await until(() => w.phone.snap().phase !== 'online', 'the Mac away', 15000);
    }
    await flush();
    await openMachinePage(el);
    await click('New chat');
    await inputText('What should it do?', 'reply with only the word OK');
    await click('Start');
    await until(() => /reply with only the word OK/.test(text(el)), 'the prompt in the chat', 3000);
    await until(
      () => !/That chat isn't in MoPilot/.test(text(el)) && /\bOK\b/.test(text(el.querySelector('[data-stack]') ?? el)),
      'the reply in the same chat',
      3000,
    );
  });
}

test('a card the Host raises is answered from the machine page and leaves the Waiting list', { todo: NEEDS_HOST }, async () => {
  const w = await world();
  await w.host.scenarios.run('host-card');
  const { el } = await w.mount();
  await openMachinePage(el);
  await until(() => /Waiting/.test(text(screen()!)), 'the card', 3000);
  await click('Allow');
  await until(() => !/Waiting/.test(text(screen()!)), 'the card to leave the list', 3000);
});
