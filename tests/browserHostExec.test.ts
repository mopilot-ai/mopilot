// Running model-written JavaScript in a page (electron/capabilities/browser/pageExec.cjs): the last expression's value as text,
// a Promise's value, an object's value, JavaScript errors as js_error, and the handles let go. #3571: REPL mode answered a
// Promise with {}, so every tab.evaluate returned null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

const { BrowserTabs } = createRequire(import.meta.url)('../electron/capabilities/browser/host.cjs');

test("exec: the last expression's value as text, JavaScript errors as js_error", async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const replies: any[] = [
    { result: { type: 'undefined' } },
    { result: { type: 'string', value: 'hi' } },
    { result: { type: 'object', objectId: 'o1' } },
    { result: { type: 'symbol', value: undefined } },
    { result: { type: 'number', unserializableValue: '-Infinity' } },
    { result: { type: 'function', description: 'function f() {}' } },
    { result: { type: 'bigint' } },
    { result: {} },
    undefined,
    { exceptionDetails: { exception: { description: 'ReferenceError: nope is not defined' } } },
    { exceptionDetails: { text: 'SyntaxError' } },
  ];
  tab.wc.handlers['Runtime.evaluate'] = () => replies.shift();
  // an object's value is read from its handle, by value
  tab.wc.handlers['Runtime.callFunctionOn'] = () => ({ result: { type: 'object', value: { a: [1] } } });
  const out = [];
  for (let i = 0; i < 9; i++) out.push(await drive(t, h.tabs.exec(tab, 'x')));
  assert.deepEqual(out, ['undefined', 'hi', '{\n  "a": [\n    1\n  ]\n}', 'undefined', '-Infinity', 'function f() {}', 'bigint', '', '']);
  await assert.rejects(drive(t, h.tabs.exec(tab, 'nope')), {
    code: 'js_error',
    message: 'JavaScript error: ReferenceError: nope is not defined',
  });
  await assert.rejects(drive(t, h.tabs.exec(tab, '(')), { code: 'js_error', message: 'JavaScript error: SyntaxError' });
  const sent = tab.wc.debugger.sent('Runtime.evaluate')[0].params;
  // REPL mode for top-level await and redeclared names; the Promise is awaited by exec, not by REPL mode (#3571)
  assert.deepEqual(sent, {
    expression: 'x',
    replMode: true,
    returnByValue: false,
    objectGroup: sent.objectGroup,
    userGesture: true,
    timeout: 30000,
  });
  assert.deepEqual(tab.wc.debugger.sent('Runtime.callFunctionOn')[0].params, {
    objectId: 'o1',
    functionDeclaration: 'function () { return this; }',
    returnByValue: true,
  });
  // every call, failed or not, lets go of the handles it was given, in a group of its own: overlapping calls never release each other's
  assert.match(sent.objectGroup, /^mopilot-exec-\d+$/);
  const released = tab.wc.debugger.sent('Runtime.releaseObjectGroup').map((c: any) => c.params.objectGroup);
  assert.equal(released.length, 11);
  assert.equal(new Set(released).size, 11);
  assert.deepEqual(
    released,
    tab.wc.debugger.sent('Runtime.evaluate').map((c: any) => c.params.objectGroup),
  );
});

test("exec: a Promise's value comes back, not REPL mode's empty object; a rejection and a failing read are js_error (#3571)", async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.handlers['Runtime.evaluate'] = () => ({ result: { type: 'object', subtype: 'promise', objectId: 'p1' } });
  tab.wc.handlers['Runtime.awaitPromise'] = () => ({ result: { type: 'object', value: [{ href: '/m/1' }, 2] } });
  assert.equal(await drive(t, h.tabs.exec(tab, '(async () => [])()')), '[\n  {\n    "href": "/m/1"\n  },\n  2\n]');
  assert.deepEqual(tab.wc.debugger.sent('Runtime.awaitPromise')[0].params, { promiseObjectId: 'p1', returnByValue: true });
  tab.wc.handlers['Runtime.awaitPromise'] = () => ({ result: { type: 'string', value: '{"v":[1]}' } });
  assert.equal(await drive(t, h.tabs.exec(tab, 'p')), '{"v":[1]}');
  tab.wc.handlers['Runtime.awaitPromise'] = () => ({ exceptionDetails: { exception: { description: 'Error: boom' } } });
  await assert.rejects(drive(t, h.tabs.exec(tab, 'p')), { code: 'js_error', message: 'JavaScript error: Error: boom' });
  // an object whose value cannot be read
  tab.wc.handlers['Runtime.evaluate'] = () => ({ result: { type: 'object', objectId: 'o2' } });
  tab.wc.handlers['Runtime.callFunctionOn'] = () => ({ exceptionDetails: { text: 'Uncaught' } });
  await assert.rejects(drive(t, h.tabs.exec(tab, 'document.body')), { code: 'js_error', message: 'JavaScript error: Uncaught' });
  // releasing the handles is housekeeping: a page that cannot do it still answers
  tab.wc.handlers['Runtime.evaluate'] = () => ({ result: { type: 'number', value: 7 } });
  tab.wc.handlers['Runtime.releaseObjectGroup'] = () => {
    throw new Error('Cannot find context');
  };
  assert.equal(await drive(t, h.tabs.exec(tab, '7')), '7');
});

test("exec against V8's own inspector: a Promise, an array, top-level await and a redeclared name all come back as their values (#3571)", async () => {
  // a mock cannot tell what REPL mode does with a Promise (it answered `{}`): the engine can
  const { Session } = await import('node:inspector');
  const session = new Session();
  session.connect();
  const tab = {
    send: (method: string, params: any) =>
      new Promise((resolve, reject) =>
        session.post(method, params, (error: any, result: any) => (error ? reject(error) : resolve(result))),
      ),
  };
  const exec = (text: string) => BrowserTabs.prototype.exec.call({}, tab, text);
  try {
    assert.equal(await exec('1 + 1'), '2');
    assert.equal(await exec('({ a: [1, { b: 2 }] })'), JSON.stringify({ a: [1, { b: 2 }] }, null, 2));
    assert.equal(await exec('(async () => [1, 2])()'), JSON.stringify([1, 2], null, 2));
    assert.equal(await exec('Promise.resolve("text")'), 'text');
    assert.equal(await exec('(async () => JSON.stringify({ v: await (Promise.resolve([3])\n) }))()'), '{"v":[3]}');
    assert.equal(await exec('await Promise.resolve(5)'), '5');
    assert.equal(await exec('const dup = await Promise.resolve({ x: 1 }); dup'), JSON.stringify({ x: 1 }, null, 2));
    assert.equal(await exec('const dup = 2; dup'), '2');
    assert.equal(await exec('undefined'), 'undefined');
    await assert.rejects(exec('Promise.reject(new Error("boom"))'), { code: 'js_error', message: /JavaScript error: Error: boom/ });
    await assert.rejects(exec('nope.x'), { code: 'js_error', message: /ReferenceError: nope is not defined/ });
  } finally {
    session.disconnect();
  }
});
