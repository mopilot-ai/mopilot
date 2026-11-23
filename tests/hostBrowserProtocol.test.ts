// The browser requests as the Host serves them (host/src/browserProtocol.mjs, package 2.6): the chat's epoch is checked first, a connection hears the events of the chats it opened tabs for, and a reply too large for a frame is refused.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createBrowserProtocol, BrowserReplyTooLarge } from '../host/src/browserProtocol.mjs';
// @ts-ignore: plain ESM without declarations
import { createEpochStore } from '../host/src/epochs.mjs';
import { tick } from './support/async-scenarios.ts';
import { world, code } from './support/browser-service-kit.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-protocol-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup() {
  const w = world();
  const epochs = createEpochStore(path.join(fs.mkdtempSync(path.join(dir, 'e-')), 'epochs.json'), { report: () => undefined });
  const protocol = createBrowserProtocol({ browser: w.host, epochs });
  const connect = () => {
    const sent: any[] = [];
    const conn = protocol.connection((m: object) => sent.push(m));
    const ask = (method: string, p: any, epoch = 1) => conn.call(method, { chatId: 'c', epoch, ...p });
    return { sent, conn, ask };
  };
  return { w, epochs, connect };
}

test('A2: a request of a stale owner is refused before it reaches the browser; a newer epoch is recorded', async () => {
  const { w, connect } = setup();
  const a = connect();
  await a.ask('browser.open', {}, 3);
  await assert.rejects(a.ask('browser.open', {}, 2), (e: any) => e.code === 'stale_epoch' && e.current === 3);
  assert.equal(w.chromium.sent('Target.createTarget').length, 1);
  await a.ask('browser.tabs', {}, 4);
  await assert.rejects(a.ask('browser.abort', {}, 3), (e: any) => e.code === 'stale_epoch');
});

test('a tab, a command and its events: open, attach, command, detach, close, release', async () => {
  const { w, connect } = setup();
  const a = connect();
  const { targetId } = await a.ask('browser.open', {});
  await a.ask('browser.attach', { targetId });
  const out = await a.ask('browser.command', { targetId, sessionId: '', method: 'Page.navigate', params: { url: 'https://x.test/' } });
  assert.match(out.loaderId, /^L/);
  await tick();
  // the chat's events reach the connection that opened its tab
  assert.deepEqual(
    a.sent.filter((m) => m.payload.method === 'Page.frameNavigated').map((m) => [m.event, m.chatId, m.payload.type, m.payload.targetId]),
    [['browser', 'c', 'cdp', targetId]],
  );
  // a command with no params
  await a.ask('browser.command', { targetId, sessionId: '', method: 'Page.enable', params: {} });
  await a.ask('browser.detach', { targetId });
  await a.ask('browser.close', { targetId });
  assert.equal(w.chromium.targets.has(targetId), false);
  await a.ask('browser.release', {});
  const heard = a.sent.length;
  w.chromium.emit('Page.frameNavigated', {}, 'nobody');
  assert.equal(a.sent.length, heard);
  // releasing a chat that has no browser is nothing
  await a.ask('browser.release', {});
});

test("I2: a chat cannot reach another chat's tab through this connection, and a command to a gone tab is refused", async () => {
  const { w, connect } = setup();
  const a = connect();
  const { targetId } = await a.ask('browser.open', {});
  await a.ask('browser.attach', { targetId });
  const b = connect();
  const other = (method: string, p: any) => b.conn.call(method, { chatId: 'd', epoch: 1, ...p });
  await other('browser.open', {});
  await assert.rejects(other('browser.command', { targetId, sessionId: '', method: 'Page.enable', params: {} }), code('not_owned'));
  await assert.rejects(other('browser.attach', { targetId }), code('not_owned'));
  assert.equal(w.chromium.sent('Page.enable').length, 0);
});

test('B5: a reply too large for a frame is refused with its own code instead of cutting the connection', async () => {
  const { w, connect } = setup();
  const a = connect();
  const { targetId } = await a.ask('browser.open', {});
  await a.ask('browser.attach', { targetId });
  w.chromium.results.set('Page.captureScreenshot', { data: 'x'.repeat(9 * 1024 * 1024) });
  await assert.rejects(
    a.ask('browser.command', { targetId, sessionId: '', method: 'Page.captureScreenshot', params: {} }),
    (e: any) => e instanceof BrowserReplyTooLarge && e.code === 'too_large',
  );
  // the limit is the frame's, in bytes: 3 million 3-byte characters are 3 million characters but 9 MB
  w.chromium.results.set('Page.captureScreenshot', { data: '界'.repeat(3 * 1024 * 1024) });
  await assert.rejects(
    a.ask('browser.command', { targetId, sessionId: '', method: 'Page.captureScreenshot', params: {} }),
    (e: any) => e instanceof BrowserReplyTooLarge,
  );
  w.chromium.results.set('Page.captureScreenshot', { data: 'small' });
  assert.deepEqual(await a.ask('browser.command', { targetId, sessionId: '', method: 'Page.captureScreenshot', params: {} }), {
    data: 'small',
  });
});

test('A5: a client that went away stops hearing; one that came back asks for its tabs and hears them again', async () => {
  const { w, connect } = setup();
  const first = connect();
  const { targetId } = await first.ask('browser.open', {});
  await first.ask('browser.attach', { targetId });
  const session = w.chromium.sessionOf(targetId)!;
  first.conn.close();
  w.chromium.emit('Page.frameStartedLoading', { frameId: targetId }, session);
  assert.equal(first.sent.filter((m) => m.payload.method === 'Page.frameStartedLoading').length, 0);
  // the tabs are still the chat's
  const second = connect();
  assert.deepEqual((await second.ask('browser.tabs', {})).tabs, [{ targetId }]);
  w.chromium.emit('Page.frameStartedLoading', { frameId: targetId }, session);
  assert.equal(second.sent.filter((m) => m.payload.method === 'Page.frameStartedLoading').length, 1);
  // asking again replaces its own listener, it does not double it
  await second.ask('browser.tabs', {});
  w.chromium.emit('Page.frameStoppedLoading', { frameId: targetId }, session);
  assert.equal(second.sent.filter((m) => m.payload.method === 'Page.frameStoppedLoading').length, 1);
  // a chat with no browser has no tabs and nothing to hear
  const third = connect();
  assert.deepEqual((await third.conn.call('browser.tabs', { chatId: 'nobody', epoch: 1 })).tabs, []);
});

test("Stop through the wire: abort lets go of the chat's sessions on the Host", async () => {
  const { w, connect } = setup();
  const a = connect();
  const { targetId } = await a.ask('browser.open', {});
  await a.ask('browser.attach', { targetId });
  await a.ask('browser.abort', {});
  assert.equal(w.chromium.sent('Input.cancelDragging').length, 1);
  await assert.rejects(a.ask('browser.command', { targetId, sessionId: '', method: 'Page.enable', params: {} }), code('not_owned'));
});
