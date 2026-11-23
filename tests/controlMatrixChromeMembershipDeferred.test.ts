// Exact membership fences deferred closes, debugger cleanup and create publication across one-event native transfers.
import { waitFor } from './support/waitFor.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { world } from './support/chrome-membership-kit.mjs';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];
const require = createRequire(import.meta.url);
const { ChromeTabContents } = require('../electron/capabilities/browser/chromeTab.cjs');

async function setup(t) {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  const b = await w.tabs.create('b');
  const id = a.wc.tabId;
  const groupA = w.chrome.tabsById.get(id).groupId;
  const groupB = w.chrome.tabsById.get(b.wc.tabId).groupId;
  return { ...w, a, b, id, groupA, groupB };
}

test('old A deferred detach cannot detach a fresh A attachment after A to B to A', async (t) => {
  const w = await setup(t);
  let finishOld;
  let started = false;
  let first = true;
  w.chrome.cdp['Target.getTargetInfo'] = () => {
    if (!first) return {};
    first = false;
    started = true;
    return new Promise((resolve) => {
      finishOld = resolve;
    });
  };
  w.a.wc.debugger.attach();
  w.a.wc.debugger.ready.catch(() => {});
  await waitFor(() => started, 'the old attach to reach the held refresh');
  assert.equal(started, true, 'old attach reached the held refresh');
  w.a.wc.debugger.detach();
  w.move(w.id, w.groupB);
  w.move(w.id, w.groupA);
  const fresh = new ChromeTabContents({ relay: w.relay, chatId: 'a', tab: w.relay.link('a').tabs.get(w.id) });
  fresh.debugger.attach();
  await fresh.debugger.ready;
  assert.equal(w.chrome.attached.has(w.id), true);
  finishOld({});
  await w.a.wc.debugger.releasing;
  assert.equal(w.chrome.attached.has(w.id), true, 'obsolete cleanup must not remove the new native attachment');
  assert.equal(w.sessions.chats.get('a')!.attached.has(w.id), true);
  assert.equal(fresh.debugger.isAttached(), true);
});

test('close queued during disconnect cannot close a returned A membership', async (t) => {
  const w = await setup(t);
  const old = w.relay.link('a');
  old.resumable = true;
  old.close('simulated transport drop');
  assert.equal(w.a.wc.resuming, true);
  await w.tabs.close('a', w.a.id);
  w.move(w.id, w.groupB);
  w.move(w.id, w.groupA);
  assert.equal(w.chrome.tabsById.has(w.id), true);
  assert.equal(w.sessions.owner.get(w.id), 'a');
  await w.relay.connect('a');
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(w.chrome.tabsById.has(w.id), true, 'stale close must not delete the rehomed physical tab');
  assert.equal(w.sessions.owner.get(w.id), 'a');
  assert.equal(w.chrome.log.filter(([name]) => name === 'tabs.remove').length, 0);
});

test('create reply followed by transfer before await continuation cannot republish source ownership', async (t) => {
  const w = await setup(t);
  const link = w.relay.link('a');
  const emit = link.ws.emit.bind(link.ws);
  let moved = null;
  // WsConnection drains frames synchronously. This models a create reply and following
  // native events delivered together before the awaiting create continuation resumes.
  link.ws.emit = (event, ...args) => {
    const result = emit(event, ...args);
    if (event === 'message') {
      const message = JSON.parse(args[0]);
      if (message.result?.id != null && moved === null) {
        moved = message.result.id;
        w.move(moved, w.groupB);
      }
    }
    return result;
  };
  const pending = await w.tabs.create('a').then(
    (tab) => ({ tab }),
    (error) => ({ error }),
  );
  assert.notEqual(moved, null);
  assert.equal(w.sessions.owner.get(moved), 'b');
  assert.equal(w.relay.link('a').tabs.has(moved), false, 'late create must not undo source revocation');
  assert.equal(w.ids('a').includes(moved), false, 'pending source wrapper must not become a ghost');
  assert.ok('error' in pending || pending.tab.wc.isDestroyed());
});
