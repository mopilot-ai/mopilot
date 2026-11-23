// The control matrix (docs/control-plane/matrix.md), stream Z: TargetLeases at a chat's end for its tab group in the user's Chrome.
// A chat keeps its Chrome tabs (and its tab group) across its turns and harness switches. Once it stayed idle after
// its last turn, or when it is archived or cleared, it lets go of them: the debuggers go and the tabs leave the
// group, the user's again, so finished chats leave no groups behind. Main's channel, the browser host over Chrome and
// the extension's background logic are real; Chrome is the chrome.* fake (tests/support/chrome-extension-kit.ts).
// The host is keyed by MoPilot's chat id, so this holds for every harness and segment the chat runs on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { until, tick } from './support/chrome-relay-kit.ts';
import { extensionWorld } from './support/chrome-extension-kit.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const require = createRequire(import.meta.url);
const { chromeBrowserTabs, CHAT_IDLE_MS } = require('../electron/capabilities/browser/chromeHost.cjs');
const { createAppState } = require('../electron/app/appState.cjs');
const { register: registerSessionIpc } = require('../electron/app/ipc/sessions.cjs');

const worlds: any[] = [];
after(() => {
  for (const w of worlds) w.stop();
});
const images = { fromBuffer: (b: Buffer) => ({ b, isEmpty: () => false, toBitmap: () => Buffer.from([255, 255, 255, 255]) }) };

/** A chat with two unmarked tabs in its group: one result tab alone can hide a premature turn-end close. */
async function grouped(o: { idleMs?: number; busy?: (chatId: string) => boolean } = {}) {
  const w = await extensionWorld();
  worlds.push(w);
  const tabs = chromeBrowserTabs({ relay: w.channel, images, ...o });
  const tab = await tabs.create('c');
  const second = await tabs.create('c');
  const chromeId = tab.wc.tabId;
  const chromeIds = [chromeId, second.wc.tabId];
  assert.ok(w.chrome.tabsById.get(chromeId).groupId > 0, 'the tab is in the chat’s group');
  // let go: the session gone, each tab out of the group or closed (its agent opened it and nobody keeps it, #1699)
  const released = () =>
    !w.sessions.chats.has('c') && chromeIds.every((id) => !w.chrome.tabsById.has(id) || w.chrome.tabsById.get(id).groupId === -1);
  return { w, tabs, tab, second, chromeId, chromeIds, released };
}

test('CM-Z24: every unmarked Chrome tab survives repeated turn ends with fresh control and the same group', async () => {
  const { w, tabs, tab, second, chromeIds } = await grouped({ idleMs: 60_000 });
  const group = w.chrome.tabsById.get(chromeIds[0]).groupId;
  const userTab = w.chrome.addTab();
  const old = w.channel.token('c');
  await tabs.ready(tab, 'c');
  await tabs.ready(second, 'c');
  assert.ok(chromeIds.every((id) => w.chrome.attached.has(id)));
  const out = await tabs.turnEnded('c');
  assert.deepEqual(out.closed, []);
  assert.deepEqual(out.kept.sort(), [tab.id, second.id].sort());
  assert.equal(w.channel.token('c').turn, old.turn + 1);
  await assert.rejects(w.channel.cdp(old, { tabId: chromeIds[0] }, 'Runtime.evaluate', { expression: '1' }), { code: 'stale_turn' });
  assert.ok([tab, second].every((t) => !t.wc.debugger.isAttached() && !t.result));
  await until(() => chromeIds.every((id) => !w.chrome.attached.has(id)));
  assert.ok(chromeIds.every((id) => w.chrome.tabsById.get(id)?.groupId === group));
  assert.equal(w.chrome.tabsById.get(userTab.id), userTab);
  assert.equal(userTab.groupId, -1);
  assert.deepEqual(
    tabs
      .leases('c')
      .map((l: any) => l.id)
      .sort(),
    chromeIds.map(String).sort(),
    'a harness handoff keeps both tabs',
  );
  await tabs.ready(second, 'c');
  assert.equal(second.wc.debugger.isAttached(), true, 'the next turn can use either retained tab');
  await tabs.turnEnded('c');
  assert.equal(tabs.list('c').length, 2);
  await tabs.close('c', second.id);
  await until(() => !w.chrome.tabsById.has(second.wc.tabId));
  assert.equal(w.chrome.tabsById.get(tab.wc.tabId)?.groupId, group, 'explicit close removes only its tab');
  tabs.dispose();
});

test('CM-Z24: a chat idle since its last turn end lets go of its Chrome tabs: its agent tabs close unless kept, a kept one stays open, the user’s; a new turn end restarts the wait and a running turn holds them', async () => {
  assert.equal(CHAT_IDLE_MS, 10 * 60_000, 'as long as a Your Chrome instance waits');
  let running = false;
  const { w, tabs, chromeId, second, released } = await grouped({ idleMs: 80, busy: () => running });
  // the agent marked one deliverable: it stays open past the let-go (#1699)
  tabs.mark('c', second.id, 'deliverable');
  await tabs.turnEnded('c');
  await tick(30);
  // a second turn ended within the wait: the wait starts again
  await tabs.turnEnded('c');
  await tick(60);
  assert.equal(released(), false, 'kept across turn ends within the wait');
  // a turn that runs when the wait is over holds them (its end starts the wait again)
  running = true;
  await tick(60);
  assert.equal(released(), false, 'a running turn keeps its tabs');
  running = false;
  await tabs.turnEnded('c');
  await until(released);
  assert.equal(w.chrome.tabsById.has(chromeId), false, 'an agent tab nobody keeps closes at the let-go (#1699)');
  assert.equal(w.chrome.tabsById.get(second.wc.tabId)?.groupId, -1, 'a kept tab is released, open and ungrouped');
  assert.equal(w.chrome.attached.has(chromeId), false, 'its debugger went');
  assert.deepEqual(tabs.leases('c'), [], 'nothing left for a handoff to name');
  // the next browser call opens a new group
  const again = await tabs.create('c');
  assert.ok(w.chrome.tabsById.get(again.wc.tabId).groupId > 0);
  assert.notEqual(w.chrome.tabsById.get(again.wc.tabId).groupId, -1);
});

test('CM-Z24: a turn end of a chat without Chrome tabs starts no wait, and stopping the host drops every wait', async () => {
  const { tabs, released } = await grouped({ idleMs: 50 });
  await tabs.turnEnded('other');
  assert.equal(tabs.idle.has('other'), false);
  await tabs.turnEnded('c');
  assert.equal(tabs.idle.has('c'), true);
  tabs.dispose();
  assert.equal(tabs.idle.size, 0);
  await tick(80);
  assert.equal(released(), false, 'a disposed host lets go of nothing on its own');
});

test('CM-Z25: an archived or cleared chat lets go of its Chrome tabs: at once when no turn runs, at the end of the turn that runs', async () => {
  {
    const { tabs, released } = await grouped({ idleMs: 60_000 });
    tabs.release('c');
    await until(released);
    assert.equal(tabs.idle.has('c'), false);
  }
  {
    let running = true;
    const { tabs, released } = await grouped({ idleMs: 60_000, busy: () => running });
    tabs.release('c');
    await tick(20);
    assert.equal(released(), false, 'its running turn keeps its tabs');
    running = false;
    await tabs.turnEnded('c');
    await until(released);
    assert.equal(tabs.releasing.has('c'), false);
  }
  {
    // cleared while a turn ran that had no Chrome tabs: the release is done at that turn's end, and a later group
    // of the same chat is kept across its turn ends
    let running = true;
    const { w, tabs } = await grouped({ idleMs: 60_000, busy: () => running });
    tabs.forget('c');
    await until(() => !w.sessions.chats.has('c'));
    tabs.release('c');
    running = false;
    await tabs.turnEnded('c');
    assert.equal(tabs.releasing.has('c'), false);
    const later = await tabs.create('c');
    await tabs.turnEnded('c');
    await tick(20);
    assert.ok(w.chrome.tabsById.get(later.wc.tabId).groupId > 0, 'kept for the idle wait');
  }
});

test('session IPC registration installs its guard and preserves archive/clear release handlers', async () => {
  // main: archiving and clearing (/new, session:release) a chat both release its Chrome tabs
  const release: string[] = [];
  const chromeRelay = { tabs: { release: (id: string) => release.push(id) } };
  const live: any = {
    chromeRelay,
    chromeChannel: { release: () => true },
    acpHost: { retireChat: () => 0 },
    controller: { invalidate: () => undefined },
    peerRuntime: { registerIpc: () => undefined },
    capabilities: { forgetSurface: (id: string) => void forgotten.push(id) },
    chromePanel: { forgetChat: (id: string) => void left.push(id) },
  };
  const left: string[] = [];
  const forgotten: string[] = [];
  const claude = { retireChat: () => 0, setChatNames: () => {} };
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-z25-'));
  const st = createAppState({ app: { getPath: () => dir, getVersion: () => '0.0.0' }, live, claude, isFlagEnabled: () => false });
  st.openChats();
  st.chats.onChange('a', { meta: { archived: 1 } });
  st.chats.onChange('b', { meta: { archived: null } });
  assert.deepEqual(release, ['a']);
  // an archived or deleted chat's last tool surface (a phone's surface.current) goes with it; a live chat keeps it
  st.chats.onChange('c', null);
  assert.deepEqual(forgotten, ['a', 'c']);
  // the phones' feed lets go of a deleted chat only: an archived chat's turn goes on to its end
  assert.deepEqual(left, ['c']);
  // a paired phone's chat list changes with any chat's record (once its panel's service exists)
  const told: string[] = [];
  live.chromePanel.service = { onChatsChanged: () => void told.push('list') };
  st.chats.onChange('d', { meta: {} });
  st.chats.onChange('d', null);
  assert.deepEqual(told, ['list', 'list']);
  const handlers = new Map<string, Function>();
  registerSessionIpc({ handle: (n: string, f: Function) => handlers.set(n, f), on: () => undefined }, { live, claude });
  assert.equal(typeof live.controller.chromeContinuationCheck, 'function', 'release registration retains the handoff guard');
  await (handlers.get('session:release') as Function)({}, 'c1');
  assert.deepEqual(release, ['a', 'c1']);
  fs.rmSync(dir, { recursive: true, force: true });
});
