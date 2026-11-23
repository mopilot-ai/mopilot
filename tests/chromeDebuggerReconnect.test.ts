// Native debugger cleanup and command responses retain separate attachment and authenticated-connection owners across restart/reconnect.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
import { Client } from '../electron/chrome-extension/src/client.mjs';
import { startBackground, RECONNECT_ALARM } from '../electron/chrome-extension/src/background.mjs';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { ChromeLink } = require('../electron/capabilities/browser/chromeLink.cjs');
const observe = (promise: Promise<any>) =>
  promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );

for (const reconnect of ['reset', 'closed']) {
  for (const currentFails of [false, true]) {
    for (const method of ['chrome.debugger.attach', 'chrome.debugger.sendCommand']) {
      for (const rejects of [false, true]) {
        test(`${reconnect}: old ${method} ${rejects ? 'failure' : 'success'} cannot settle reused ID before current ${currentFails ? 'failure' : 'success'}`, async (t) => {
          const chrome = fakeChromeApi();
          let client: Client;
          const sessions = new Sessions({ chrome, send: (m: any) => client.send(m), log: () => undefined });
          const sockets: FakeWs[] = [];
          class FakeWs {
            readyState = 1;
            onmessage: any;
            onclose: any;
            frames: any[] = [];
            incoming: Promise<unknown>[] = [];
            main: any = new EventEmitter();
            constructor() {
              sockets.push(this);
              this.main.open = true;
              this.main.send = (text: string) => {
                const frame = { ...JSON.parse(text), chat: 'a' };
                this.incoming.push(this.onmessage({ data: JSON.stringify(frame) }));
              };
              this.main.close = () => this.close();
            }
            send(text: string) {
              this.frames.push(JSON.parse(text));
              this.main.emit('message', text);
            }
            close() {
              this.readyState = 3;
              this.main.open = false;
              this.main.emit('close', 1001, 'peer disconnected');
            }
          }
          // The completed authentication boundary is mocked; request IDs and reply consumption are the real ChromeLink.
          client = new Client({
            WebSocket: FakeWs,
            crypto: {},
            pairing: async () => ({ port: 1, secret: 'test-only' }),
            sessions,
            version: 'test',
          });
          t.after(() => {
            client.dispose();
            sockets.forEach((ws) => ws.close());
          });
          await client.connect();
          client.authed = true;
          await sessions.open('a', {});
          const tab = await sessions.command('a', 'chrome.tabs.create', [{}], 0);
          const oldEntered = deferred();
          const oldDone = deferred();
          const oldBoundary = async () => {
            oldEntered.resolve(undefined);
            await oldDone.promise;
            if (rejects) throw new Error('old native failure');
            return { sentinel: 'old' };
          };
          chrome.cdp['Runtime.old'] = oldBoundary;
          const nativeAttach = chrome.debugger.attach;
          chrome.debugger.attach = async (...args) => {
            await oldBoundary();
            return nativeAttach(...args);
          };
          const oldWs = sockets[0];
          const oldLink = new ChromeLink('a', oldWs.main, 10_000);
          const old = observe(
            oldLink.send(method, [{ tabId: tab.id }, ...(method === 'chrome.debugger.attach' ? [] : ['Runtime.old', {}])], { turn: 0 }),
          );
          await oldEntered.promise;
          assert.equal(oldLink.nextId, 2, 'real request ID producer chose 1');
          if (reconnect === 'reset') await client.reset();
          else {
            oldWs.close();
            oldWs.onclose();
            await client.connect();
          }
          await old;
          client.authed = true;
          const newWs = sockets[1];
          const newLink = new ChromeLink('a', newWs.main, 10_000);
          const currentDone = deferred();
          const currentEntered = deferred();
          chrome.cdp['Runtime.current'] = () => {
            currentEntered.resolve(undefined);
            return currentDone.promise;
          };
          let currentOutcome: unknown;
          const current = observe(
            newLink.send('chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Runtime.current', {}], { turn: 0 }),
          ).then((out) => {
            currentOutcome = out;
            return out;
          });
          await currentEntered.promise;
          assert.equal(newLink.nextId, 2, 'replacement link reused request ID 1');
          oldDone.resolve(undefined);
          await Promise.all(oldWs.incoming);
          assert.equal(currentOutcome, undefined, 'old response cannot complete the current request');
          assert.deepEqual(
            newWs.frames.filter((m) => m.id === 1),
            [],
          );
          if (currentFails) currentDone.reject(new Error('current native failure'));
          else currentDone.resolve({ sentinel: 'current' });
          await Promise.all(newWs.incoming);
          const outcome = await current;
          if (currentFails) {
            assert.ok('error' in outcome);
            assert.match(outcome.error.message, /current native failure/);
          } else assert.deepEqual(outcome, { value: { sentinel: 'current' } });
        });
      }
    }
  }
}

for (const failFirst of [false, true]) {
  test(`restored debugger cleanup ${failFirst ? 'retries failure' : 'serializes a late native effect'} before new attach`, async () => {
    const chrome = fakeChromeApi();
    const tab = chrome.addTab();
    chrome.attached.add(tab.id);
    chrome.store.session.sessions = { a: { tabs: [tab.id], attached: [tab.id], groupId: 1 } };
    const sessions = new Sessions({ chrome, storage: chrome.storage.session, send: () => undefined, log: () => undefined });
    const wait = deferred();
    const entered = deferred();
    const nativeDetach = chrome.debugger.detach;
    let calls = 0;
    chrome.debugger.detach = async (...args) => {
      if (++calls === 1) {
        entered.resolve(undefined);
        await wait.promise;
        if (failFirst) throw new Error('temporary restore failure');
      }
      return nativeDetach(...args);
    };
    const restoring = sessions.restore();
    await entered.promise;
    const attaching = sessions.command('a', 'chrome.debugger.attach', [{ tabId: tab.id }], 0);
    assert.equal(
      chrome.log.some((c) => c[0] === 'debugger.attach'),
      false,
    );
    wait.resolve(undefined);
    await restoring;
    await attaching;
    assert.equal(chrome.attached.has(tab.id), true);
    assert.equal(sessions.chats.get('a')!.attached.has(tab.id), true);
    assert.equal(calls, failFirst ? 2 : 1);
  });
}

test('every worker reconnect path waits for session restore before it can create a command socket', async (t) => {
  const chrome = fakeChromeApi();
  const wait = deferred();
  chrome.storage.session.get = () => wait.promise;
  chrome.store.local.pairing = `mopilot-chrome:1:47615:${'s'.repeat(43)}`;
  const sockets: any[] = [];
  class FakeWs {
    readyState = 1;
    constructor() {
      sockets.push(this);
    }
    close() {}
  }
  const bg = startBackground({ chrome, WebSocket: FakeWs, crypto: {}, setTimeout, clearTimeout, setInterval, clearInterval });
  t.after(() => bg.client.dispose());
  chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
  chrome.runtime.onStartup.fire();
  const reset = bg.client.reset();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 0, 'initial connection, alarm, startup and reset all wait');
  wait.resolve({});
  await Promise.all([bg.ready, reset]);
  assert.equal(sockets.length, 1);
});
