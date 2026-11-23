// A remote Host's browser service as the remote tabs' transport (electron/host/remoteBrowser.cjs, package 2.6): browser.* requests over the Host connection, tab events back, and the resume after the connection returned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createRemoteBrowserTransport } = require('../electron/host/remoteBrowser.cjs');

function world(answer: (method: string, params: any) => any = () => ({})) {
  const requests: [string, any][] = [];
  let state = 'online';
  const eventFns = new Set<(e: any) => void>();
  const stateFns = new Set<(s: string) => void>();
  const host = {
    browser: {
      request: async (method: string, params: any) => (requests.push([method, params]), answer(method, params)),
      onEvent: (fn: (e: any) => void) => (eventFns.add(fn), () => void eventFns.delete(fn)),
    },
    state: () => state,
    onState: (fn: (s: string) => void) => (stateFns.add(fn), () => void stateFns.delete(fn)),
  };
  const transport = createRemoteBrowserTransport({ host });
  return {
    transport,
    requests,
    hear: (chatId: string, payload: any) => eventFns.forEach((f) => f({ chatId, payload })),
    setState: (s: string) => ((state = s), stateFns.forEach((f) => f(s))),
    eventFns,
    stateFns,
  };
}

test('every call is a browser.* request for the chat; the tab ids come back to the caller', async () => {
  const w = world((method) => (method === 'browser.open' ? { targetId: 'T1' } : {}));
  assert.deepEqual(await w.transport.open('c'), { targetId: 'T1' });
  await w.transport.attach('c', 'T1');
  await w.transport.command('c', { targetId: 'T1', sessionId: '', method: 'Page.enable', params: {} });
  await w.transport.detach('c', 'T1');
  await w.transport.close('c', 'T1');
  await w.transport.abort('c');
  await w.transport.release('c');
  assert.deepEqual(
    w.requests.map(([m, p]) => [m, p.chatId, p.targetId]),
    [
      ['browser.open', 'c', undefined],
      ['browser.attach', 'c', 'T1'],
      ['browser.command', 'c', 'T1'],
      ['browser.detach', 'c', 'T1'],
      ['browser.close', 'c', 'T1'],
      ['browser.abort', 'c', undefined],
      ['browser.release', 'c', undefined],
    ],
  );
  assert.equal(w.requests[2][1].method, 'Page.enable');
});

test('a failing request fails the call as the connection said, and a tab that did not open is not remembered', async () => {
  const w = world((method) => {
    throw Object.assign(new Error('no room'), { code: method === 'browser.open' ? 'invalid' : 'host_unreachable' });
  });
  await assert.rejects(w.transport.open('c'), /no room/);
  await assert.rejects(w.transport.close('c', 'T9'), (e: any) => e.code === 'host_unreachable');
});

test("events reach the chat's listeners only; a stopped listener hears no more", async () => {
  const w = world();
  const heard: any[] = [];
  const other: any[] = [];
  const off = w.transport.subscribe('c', (e: any) => heard.push(e));
  w.transport.subscribe('d', (e: any) => other.push(e));
  w.transport.subscribe('c', (e: any) => heard.push(e));
  w.hear('c', { type: 'cdp', targetId: 'T1' });
  assert.equal(heard.length, 2);
  assert.equal(other.length, 0);
  off();
  w.hear('c', { type: 'cdp', targetId: 'T1' });
  assert.equal(heard.length, 3);
  // a chat nobody listens to
  w.hear('nobody', { type: 'cdp' });
  // an event with no payload is nothing
  w.hear('c', undefined);
  assert.equal(heard.length, 4);
});

test("A5: when the connection returns the Host is asked for the chat's tabs and the ones it lost are closed here", async () => {
  const w = world((method) => (method === 'browser.tabs' ? { tabs: [{ targetId: 'T1' }] } : { targetId: 'T1' }));
  const heard: any[] = [];
  w.transport.subscribe('c', (e: any) => heard.push(e));
  await w.transport.open('c');
  w.hear('c', { type: 'opened', targetId: 'T2', openerId: 'T1', url: '' });
  w.hear('c', { type: 'opened', targetId: 'T3', openerId: 'T1', url: '' });
  w.hear('c', { type: 'closed', targetId: 'T3' });
  heard.length = 0;
  // offline then online: T2 is gone on the Host, T1 is still there
  w.setState('offline');
  assert.equal(w.requests.filter(([m]) => m === 'browser.tabs').length, 0);
  w.setState('online');
  await tick();
  assert.deepEqual(w.requests.at(-1), ['browser.tabs', { chatId: 'c' }]);
  assert.deepEqual(heard, [{ type: 'closed', targetId: 'T2' }]);
  // closing a tab here forgets it; a released chat has nothing to resume
  await w.transport.close('c', 'T1');
  heard.length = 0;
  w.setState('online');
  await tick();
  assert.deepEqual(heard, []);
  await w.transport.release('c');
  w.setState('online');
  await tick();
  assert.deepEqual(heard, []);
});

test("the Host dropping the chat's browser forgets its tabs; a resume that fails is tried at the next return", async () => {
  let fail = true;
  const w = world((method) => {
    if (method === 'browser.tabs' && fail) throw new Error('down');
    return method === 'browser.tabs' ? { tabs: [] } : { targetId: 'T1' };
  });
  const heard: any[] = [];
  w.transport.subscribe('c', (e: any) => heard.push(e));
  await w.transport.open('c');
  w.setState('online');
  await tick();
  assert.deepEqual(heard, []);
  fail = false;
  w.setState('online');
  await tick();
  assert.deepEqual(heard, [{ type: 'closed', targetId: 'T1' }]);
  // an exit or a release by the Host forgets every tab of the chat
  await w.transport.open('c');
  w.hear('c', { type: 'exit' });
  w.hear('c', { type: 'closed', targetId: '' });
  heard.length = 0;
  w.setState('online');
  await tick();
  assert.deepEqual(heard, []);
});

test('alive follows the connection; dispose stops following the Host', async () => {
  const w = world();
  assert.equal(w.transport.alive(), true);
  w.setState('connecting');
  assert.equal(w.transport.alive(), false);
  const heard: any[] = [];
  w.transport.subscribe('c', (e: any) => heard.push(e));
  w.transport.dispose();
  assert.equal(w.eventFns.size, 0);
  assert.equal(w.stateFns.size, 0);
  w.hear('c', { type: 'cdp' });
  assert.deepEqual(heard, []);
});

test("a listener that stops twice does not stop the chat's newer listeners", () => {
  const w = world();
  const heard: any[] = [];
  const first = w.transport.subscribe('c', () => undefined);
  first();
  w.transport.subscribe('c', (e: any) => heard.push(e));
  first();
  w.hear('c', { type: 'cdp' });
  assert.equal(heard.length, 1);
});
