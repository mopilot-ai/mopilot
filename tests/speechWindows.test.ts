// Document leases prevent retired renderer requests and cleanup from taking ownership of replacement speech input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSpeechWindows, registerSpeechWindows } = require('../electron/platform/speechWindows.cjs');
const { buildApi, ownedInvoke } = require('../electron/bridge/spec.cjs');

function page() {
  const sender = Object.assign(new EventEmitter(), { mainFrame: { detached: false }, isDestroyed: () => false });
  return { sender, senderFrame: sender.mainFrame };
}

test('early preload registration precedes services; each bridge build gets one fresh lease shared by its calls', async () => {
  const ipc = new EventEmitter();
  const leases = registerSpeechWindows(ipc);
  const event: any = page();
  const calls: any[] = [];
  const electron = {
    ipcRenderer: {
      sendSync: (channel: string) => {
        ipc.emit(channel, event);
        return event.returnValue;
      },
      invoke: async (_channel: string, owner: string) => {
        calls.push(owner);
        return leases.owner(event, owner);
      },
    },
    webUtils: {},
  };
  const spec = { start: ownedInvoke('speech:begin', 0, 'speech:document'), end: ownedInvoke('speech:end', 0, 'speech:document') };
  const first = buildApi(spec, electron);
  const owner = await first.start();
  assert.equal(await first.end(), owner);
  const retired: string[] = [];
  assert.equal(
    registerSpeechWindows(ipc, (id: string) => retired.push(id)),
    leases,
  );
  const next = buildApi(spec, electron);
  assert.deepEqual(retired, [owner]);
  assert.notEqual(await next.start(), owner);
  await assert.rejects(first.start(), /earlier page/);
  assert.equal(ipc.listenerCount('speech:document'), 1);
  assert.equal(calls.length, 4);
});

test('navigation and crashes retire exactly the old generation; same-document and subframe moves preserve it', () => {
  for (const reason of ['navigation', 'legacy-navigation', 'crash', 'destroyed']) {
    const closed: string[] = [];
    const service = createSpeechWindows((id: string) => closed.push(id));
    const e = page();
    const old = service.open(e);
    e.sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    e.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    e.sender.emit('did-start-navigation', {}, 'url', false, false);
    assert.equal(service.owner(e, old), old);
    if (reason === 'navigation') e.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    else if (reason === 'legacy-navigation') e.sender.emit('did-start-navigation', {}, 'url', false, true);
    else e.sender.emit(reason === 'crash' ? 'render-process-gone' : 'destroyed');
    assert.throws(() => service.owner(e, old), /earlier page/);
    assert.deepEqual(closed, [old]);
    e.sender.emit('render-process-gone');
    assert.deepEqual(closed, [old], 'retirement is idempotent');
    if (reason === 'destroyed') assert.equal(service.open(e), null);
    else {
      const current = service.open(e);
      assert.notEqual(current, old);
      assert.equal(service.owner(e, current), current);
      assert.throws(() => service.owner(e, old), /earlier page/);
      assert.equal(e.sender.listenerCount('did-start-navigation'), 1);
    }
  }
});

test('a missing, detached, foreign, destroyed or unregistered frame cannot obtain or use a lease', () => {
  const service = createSpeechWindows();
  const event: any = page();
  assert.throws(() => service.owner(event, 'unknown'), /earlier page/);
  service.open(event);
  const owner = service.open(event);
  assert.throws(() => service.owner(event, null), /earlier page/);
  for (const senderFrame of [null, { detached: false }, { detached: true }]) {
    const invalid = { ...event, senderFrame };
    assert.equal(service.open(invalid), null);
    assert.throws(() => service.owner(invalid, owner), /earlier page/);
  }
  event.sender.mainFrame.detached = true;
  assert.equal(service.open(event), null);
  assert.throws(() => service.owner(event, owner), /earlier page/);
  event.sender.mainFrame.detached = false;
  event.sender.isDestroyed = () => true;
  assert.equal(service.open(event), null);
  assert.throws(() => service.owner(event, owner), /earlier page/);
});
