// The core's stream as main's code reaches it (electron/platform/core.cjs), over a fake addon: one subscription shared by
// every listener, a listener's failure kept to itself, and nothing needed of a core that is missing or older. tests/coreBindingStream.test.ts runs the real addon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { coreEvents } = require('../electron/platform/core.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

/** An addon with a stream: `say` is what the core emits. */
function fakeAddon() {
  let said: (event: Buffer) => void = () => assert.fail('nobody subscribed');
  const addon = {
    subscriptions: 0,
    subscribe(listener: (event: Buffer) => void) {
      addon.subscriptions++;
      said = listener;
    },
    dispatch: async () => Buffer.alloc(0),
    routes: () => [],
    say: (text: string) => said(Buffer.from(text)),
  };
  return addon;
}

test('every listener shares one subscription, and one that stopped hears no more', () => {
  const addon = fakeAddon();
  const heard: string[] = [];
  const first = coreEvents((event: Buffer) => heard.push(`a ${event}`), addon);
  coreEvents((event: Buffer) => heard.push(`b ${event}`), addon);
  assert.equal(addon.subscriptions, 1);
  addon.say('one');
  first();
  addon.say('two');
  assert.deepEqual(heard, ['a one', 'b one', 'b two']);
});

test('a listener that throws is noted and costs the others nothing', () => {
  clearIgnored();
  const addon = fakeAddon();
  const heard: string[] = [];
  coreEvents(() => {
    throw new Error('a listener bug');
  }, addon);
  coreEvents((event: Buffer) => heard.push(String(event)), addon);
  addon.say('one');
  assert.deepEqual(heard, ['one']);
  assert.match(JSON.stringify(recentIgnored()), /a listener bug/);
});

test('a listener that stops another during an event still lets that event finish', () => {
  const addon = fakeAddon();
  const heard: string[] = [];
  let second = () => {};
  coreEvents(() => second(), addon);
  second = coreEvents((event: Buffer) => heard.push(String(event)), addon);
  addon.say('one');
  addon.say('two');
  assert.deepEqual(heard, ['one']);
});

test('a failed subscribe is noted and tried again by the next listener, so nobody is left deaf', () => {
  clearIgnored();
  const addon = fakeAddon();
  const subscribe = addon.subscribe;
  addon.subscribe = () => {
    addon.subscribe = subscribe;
    throw new Error('no stream today');
  };
  const heard: string[] = [];
  coreEvents(() => assert.fail('this listener was told it failed'), addon)();
  assert.match(JSON.stringify(recentIgnored()), /no stream today/);
  coreEvents((event: Buffer) => heard.push(String(event)), addon);
  addon.say('one');
  assert.deepEqual(heard, ['one']);
});

test('a listener runs outside the async context of whoever started the stream', () => {
  const guard = new AsyncLocalStorage<string>();
  const addon = fakeAddon();
  const heard: (string | undefined)[] = [];
  guard.run('a turn', () => {
    coreEvents(() => heard.push(guard.getStore()), addon);
    addon.say('one');
  });
  assert.deepEqual(heard, [undefined]);
});

test('with no core, listening throws why: nothing is heard in its place', () => {
  assert.throws(() => coreEvents(() => {}, null), { message: 'The Rust core is missing.' });
});

test('the process’s own core is the default, and tests run without one', () => {
  coreEvents(() => {})();
});
