// Main's RelayDebugger serializes retired release before replacement acquisition and guards each continuation with the exact attach attempt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { RelayDebugger } = require('../electron/capabilities/browser/chromeTab.cjs');
const { ChromeLink } = require('../electron/capabilities/browser/chromeLink.cjs');
const observe = (promise: Promise<any>) =>
  promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );

for (const fails of [false, true]) {
  test(`real main release after pending native ${fails ? 'failure' : 'success'} cannot cancel the next turn's extension attachment`, async () => {
    const chrome = fakeChromeApi();
    const sessions = new Sessions({ chrome, send: () => undefined, log: () => undefined });
    await sessions.open('a', {});
    const tab = await sessions.command('a', 'chrome.tabs.create', [{}], 0);
    const wait = deferred();
    const entered = deferred();
    const nativeAttach = chrome.debugger.attach;
    let count = 0;
    let turn = 0;
    chrome.debugger.attach = async (...args) => {
      if (count++ === 0) {
        entered.resolve(undefined);
        await wait.promise;
        if (fails) throw new Error('old native refusal');
      }
      return nativeAttach(...args);
    };
    const effects: string[] = [];
    const contents = {
      chatId: 'a',
      tabId: tab.id,
      created: Promise.resolve(),
      resume: async () => undefined,
      refresh: async () => undefined,
      relay: {
        link: () => 'same-test-link',
        token: (chatId: string) => ({ chatId, turn }),
        attach: (tok: any, tabId: number) => {
          effects.push(`attach:${tok.turn}`);
          return sessions.command(tok.chatId, 'chrome.debugger.attach', [{ tabId }], tok.turn);
        },
        detach: (tok: any, tabId: number) => {
          effects.push(`detach:${tok.turn}`);
          return sessions.command(tok.chatId, 'chrome.debugger.detach', [{ tabId }], tok.turn);
        },
      },
    };
    const debugger_ = new RelayDebugger(contents);
    debugger_.attach();
    const old = observe(debugger_.ready);
    await entered.promise;
    debugger_.detach();
    sessions.advance('a', ++turn);
    debugger_.attach();
    const next = observe(debugger_.ready);
    wait.resolve(undefined);
    await old;
    assert.deepEqual(await next, { value: undefined });
    assert.deepEqual(effects, ['attach:0', 'detach:0', 'attach:1']);
    assert.equal(chrome.attached.has(tab.id), true);
    assert.equal(sessions.chats.get('a')!.attached.has(tab.id), true);
    assert.equal(debugger_.isAttached(), true);
  });
}

for (const boundary of ['created', 'resume', 'attach', 'refresh']) {
  for (const fails of [false, true]) {
    test(`detach at ${boundary} ${fails ? 'rejection' : 'success'} retires old continuations while replacement survives`, async () => {
      const wait = deferred();
      const entered = deferred();
      const events: string[] = [];
      let turn = 0;
      let paused = false;
      const step = async (name: string) => {
        events.push(name);
        if (name !== boundary || paused) return;
        paused = true;
        entered.resolve(undefined);
        await wait.promise;
        if (fails) throw new Error(`old ${boundary} failure`);
      };
      const contents: any = {
        chatId: 'a',
        tabId: 500,
        created: step('created'),
        resume: () => step('resume'),
        refresh: () => step('refresh'),
        relay: {
          link: () => 'same-test-link',
          token: (chatId: string) => ({ chatId, turn }),
          attach: async (tok: any) => {
            events.push(`attach:${tok.turn}`);
            await step('attach');
          },
          detach: async (tok: any) => {
            events.push(`detach:${tok.turn}`);
          },
        },
      };
      const debugger_ = new RelayDebugger(contents);
      debugger_.attach();
      const old = observe(debugger_.ready);
      await entered.promise;
      debugger_.detach();
      turn++;
      // A failed creation may be replaced by a successful retry of the target-opening boundary.
      if (boundary === 'created') contents.created = Promise.resolve();
      debugger_.attach();
      const next = observe(debugger_.ready);
      wait.resolve(undefined);
      assert.ok('error' in (await old));
      assert.deepEqual(await next, { value: undefined });
      assert.ok(events.indexOf('detach:0') < events.indexOf('attach:1'));
      assert.equal(debugger_.isAttached(), true);
      assert.equal(events.filter((event) => event === 'refresh').length, boundary === 'refresh' ? 2 : 1);
    });
  }
}

test('a delayed release acknowledgement is awaited before reattach and a release failure leaves retry usable', async () => {
  for (const fails of [false, true]) {
    const wait = deferred();
    const entered = deferred();
    let attaches = 0;
    const debugger_ = new RelayDebugger({
      chatId: 'a',
      tabId: 500,
      created: Promise.resolve(),
      resume: async () => undefined,
      refresh: async () => undefined,
      relay: {
        link: () => 'same-test-link',
        token: () => ({ chatId: 'a', turn: 0 }),
        attach: async () => {
          attaches++;
        },
        detach: async () => {
          entered.resolve(undefined);
          await wait.promise;
          if (fails) throw new Error('transient release failure');
        },
      },
    });
    debugger_.attach();
    await debugger_.ready;
    debugger_.detach();
    await entered.promise;
    debugger_.attach();
    const next = debugger_.ready;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attaches, 1);
    wait.resolve(undefined);
    await next;
    assert.equal(attaches, 2);
  }
});

test('lost attempts cannot dispatch after resume, and a failed target creation releases no missing tab', async () => {
  const wait = deferred();
  const entered = deferred();
  let calls = 0;
  const contents: any = {
    chatId: 'a',
    tabId: 500,
    created: Promise.resolve(),
    resume: async () => {
      entered.resolve(undefined);
      await wait.promise;
    },
    refresh: async () => undefined,
    relay: {
      link: () => 'same-test-link',
      token: () => ({ chatId: 'a', turn: 0 }),
      attach: async () => {
        calls++;
      },
    },
  };
  const debugger_ = new RelayDebugger(contents);
  debugger_.attach();
  const old = observe(debugger_.ready);
  await entered.promise;
  debugger_.lost('disconnected');
  wait.resolve(undefined);
  assert.ok('error' in (await old));
  assert.equal(calls, 0);

  contents.tabId = null;
  const creation = deferred();
  contents.created = creation.promise;
  debugger_.attach();
  const failed = observe(debugger_.ready);
  debugger_.detach();
  creation.reject(new Error('no tab'));
  await failed;
  await debugger_.releasing;
  assert.equal(calls, 0);
});

test('a queued CDP dispatch cannot use an attachment retired after its ready promise resolved', async () => {
  let commands = 0;
  const debugger_ = new RelayDebugger({
    chatId: 'a',
    tabId: 500,
    created: Promise.resolve(),
    resume: async () => undefined,
    refresh: async () => undefined,
    relay: {
      link: () => 'same-test-link',
      token: () => ({ chatId: 'a', turn: 0 }),
      attach: async () => undefined,
      detach: async () => undefined,
      cdp: async () => {
        commands++;
      },
    },
  });
  debugger_.attach();
  await debugger_.ready;
  const queued = observe(debugger_.sendCommand('Page.enable'));
  debugger_.detach();
  assert.ok('error' in (await queued));
  await debugger_.releasing;
  assert.equal(commands, 0);
});

for (const lateFailure of [false, true]) {
  for (const retryFirst of [false, true]) {
    test(`actual command timeout releases late native ${lateFailure ? 'failure' : 'success'} with retry ${retryFirst ? 'before' : 'after'} acknowledgement`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const chrome = fakeChromeApi();
      const ws: any = new EventEmitter();
      ws.open = true;
      const commands: string[] = [];
      const sessions = new Sessions({ chrome, send: (m: any) => ws.emit('message', JSON.stringify(m)), log: () => undefined });
      await sessions.open('a', {});
      const tab = await sessions.command('a', 'chrome.tabs.create', [{}], 0);
      ws.send = (text: string) => {
        const message = JSON.parse(text);
        commands.push(message.method);
        void sessions.handle({ ...message, chat: 'a' });
      };
      const link = new ChromeLink('a', ws, 20);
      const gate = deferred();
      const entered = deferred();
      let attempts = 0;
      chrome.debugger.attach = async ({ tabId }) => {
        if (++attempts === 1) {
          entered.resolve(undefined);
          await gate.promise;
          if (lateFailure) throw new Error('late native refusal');
        }
        if (chrome.attached.has(tabId)) throw new Error('Another debugger is already attached');
        chrome.attached.add(tabId);
      };
      const debugger_ = new RelayDebugger({
        chatId: 'a',
        tabId: tab.id,
        created: Promise.resolve(),
        resume: async () => undefined,
        refresh: async () => undefined,
        relay: {
          link: () => 'same-test-link',
          token: (chatId: string) => ({ chatId, turn: 0 }),
          attach: (tok: any, tabId: number) => link.send('chrome.debugger.attach', [{ tabId }], { turn: tok.turn }),
          detach: (tok: any, tabId: number) => link.send('chrome.debugger.detach', [{ tabId }], { turn: tok.turn }),
        },
      });
      debugger_.attach();
      const first = observe(debugger_.ready);
      await entered.promise;
      t.mock.timers.tick(20);
      const result = await first;
      assert.equal('error' in result && (result.error as any).code, 'timeout');
      await debugger_.releasing;
      assert.equal(debugger_.isAttached(), false);
      if (!retryFirst) {
        gate.resolve(undefined);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(chrome.attached.has(tab.id), false, 'the abandoned native effect was cleaned up');
      }
      debugger_.attach();
      const next = observe(debugger_.ready);
      if (retryFirst) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(attempts, 1, 'replacement cannot overtake the abandoned native acquisition');
        gate.resolve(undefined);
      }
      assert.deepEqual(await next, { value: undefined });
      assert.deepEqual(commands, ['chrome.debugger.attach', 'chrome.debugger.detach', 'chrome.debugger.attach']);
      assert.equal(debugger_.isAttached(), true);
      assert.equal(chrome.attached.has(tab.id), true);
      assert.equal(sessions.chats.get('a')!.attached.has(tab.id), true);
      debugger_.detach();
      await debugger_.releasing;
      assert.equal(chrome.attached.has(tab.id), false);
      assert.equal(link.pending.size, 0);
    });
  }
}

for (const boundary of ['resume', 'attach', 'refresh']) {
  test(`current ${boundary} failure releases only an acquired or uncertain native effect`, async () => {
    let detaches = 0;
    const failure = Object.assign(new Error(boundary === 'attach' ? 'duplicate attach rejection' : 'timeout'), {
      code: boundary === 'attach' ? 'failed' : 'timeout',
    });
    const fail = async (name: string) => {
      if (name === boundary) throw failure;
    };
    const debugger_ = new RelayDebugger({
      chatId: 'a',
      tabId: 500,
      created: Promise.resolve(),
      resume: () => fail('resume'),
      refresh: () => fail('refresh'),
      relay: {
        link: () => 'same-test-link',
        token: () => ({ chatId: 'a', turn: 0 }),
        attach: () => fail('attach'),
        detach: async () => {
          detaches++;
        },
      },
    });
    debugger_.attach();
    assert.deepEqual(await observe(debugger_.ready), { error: failure });
    await debugger_.releasing;
    assert.equal(detaches, boundary === 'refresh' ? 1 : 0);
    assert.equal(debugger_.isAttached(), false);
    await assert.rejects(debugger_.sendCommand('Page.enable'), failure);
  });
}

test('an empty native rejection owns no attachment and does not schedule cleanup', async () => {
  let detaches = 0;
  const debugger_ = new RelayDebugger({
    chatId: 'a',
    tabId: 500,
    created: Promise.resolve(),
    resume: async () => undefined,
    refresh: async () => undefined,
    relay: {
      link: () => 'same-test-link',
      token: () => ({ chatId: 'a', turn: 0 }),
      attach: () => Promise.reject(null),
      detach: async () => {
        detaches++;
      },
    },
  });
  debugger_.attach();
  assert.deepEqual(await observe(debugger_.ready), { error: null });
  await debugger_.releasing;
  assert.equal(detaches, 0);
  assert.equal(debugger_.isAttached(), false);
});
