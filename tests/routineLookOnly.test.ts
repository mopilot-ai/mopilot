// A routine's replay only looks (#3571, G4): Registry.invoke's lookOnly reaches a handler only when main passes it,
// pageExec's peekIn has V8 refuse side effects, browser_script's operations refuse everything but opening and reading when
// ctx.lookOnly is set (tab.evaluate through tabs.peek), and browser_script reports that refusal as look_only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ops, loc, tool, code, ToolError } from './support/browser-script/fixture.ts';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';
import { fakeTabs } from './support/browser-script/fixture.ts';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { peekIn } = require('../electron/capabilities/browser/pageExec.cjs');
const { LOOK_OPS, checkLookOnly, lookRefusal } = require('../electron/capabilities/browser/scriptLookOnly.cjs');
const { browserScript, createScriptOps } = require('../electron/capabilities/browser/script.cjs');

const LOOK = { origins: ['https://a.test'] };

test("Registry.invoke: lookOnly reaches the handler as ctx.lookOnly only when main passes it, never from a model's arguments", async () => {
  const r = new Registry();
  const seen: any[] = [];
  r.register({
    name: 'probe',
    policy: 'observe',
    schema: { type: 'object' },
    handler: async (_args: any, ctx: any) => (seen.push(ctx), 'ok'),
  });
  await r.invoke('c', 's', 'probe', {});
  assert.equal('lookOnly' in seen[0], false, 'absent by default');
  await r.invoke('c', 's', 'probe', { lookOnly: true }, { callId: 'a' });
  assert.equal('lookOnly' in seen[1], false, 'a model asking for it changes nothing');
  await r.invoke('c', 's', 'probe', { lookOnly: false }, { lookOnly: false, callId: 'b' });
  assert.equal('lookOnly' in seen[2], false);
  await r.invoke('c', 's', 'probe', {}, { lookOnly: LOOK, callId: 'd' });
  assert.deepEqual(seen[3].lookOnly, LOOK);
});

test('peekIn: asks V8 to refuse side effects and returns the value as text; an exception is look_only', async () => {
  const sent: any[] = [];
  const tab = (reply: any) => ({ send: async (method: string, params: any) => (sent.push([method, params]), reply) });
  assert.equal(await peekIn(tab({ result: { type: 'string', value: 'hi' } }), 'document.title'), 'hi');
  assert.deepEqual(sent[0], [
    'Runtime.evaluate',
    { expression: 'document.title', throwOnSideEffect: true, returnByValue: true, timeout: 30_000 },
  ]);
  assert.equal(await peekIn(tab({ result: { type: 'undefined' } }), 'void 0'), 'undefined');
  assert.equal(await peekIn(tab(undefined), 'x'), 'undefined');
  await assert.rejects(
    peekIn(tab({ exceptionDetails: { exception: { description: 'EvalError: Possible side-effect in debug-evaluate' } } }), 'a.click()'),
    code('look_only', /only reads, and this JavaScript would change the page: EvalError: Possible side-effect/),
  );
  await assert.rejects(peekIn(tab({ exceptionDetails: { text: 'Uncaught' } }), 'x'), code('look_only', /: Uncaught$/));
});

test('BrowserTabs.peek runs the page JavaScript through peekIn on its tab', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.handlers['Runtime.evaluate'] = () => ({ result: { type: 'string', value: 'seen' } });
  assert.equal(await drive(t, h.tabs.peek(tab, 'document.title')), 'seen');
  assert.equal(tab.wc.debugger.sent('Runtime.evaluate')[0].params.throwOnSideEffect, true);
});

test('script operations in a replay (ctx.lookOnly): an action is refused with look_only, a read is allowed, evaluate only peeks', async () => {
  const o = ops();
  o.ctx.lookOnly = { origins: ['https://a.test'] };
  for (const [op, args] of [
    ['loc.act', { ...loc(), action: 'click' }],
    ['cua.click', { tab: 't1', x: 1, y: 2 }],
  ] as const) {
    await assert.rejects(
      o.d(op, args),
      code('look_only', new RegExp(`A replay only reads, so it stopped before ${op.replace('.', '\\.')}\\.`)),
    );
  }
  assert.deepEqual(o.tabs.called('click'), [], 'nothing was clicked');
  // a read still works
  assert.equal(await o.d('loc.read', loc({ what: 'count' })), 1);
  // evaluate peeks: the page JavaScript runs where V8 refuses side effects, and never through exec
  o.tabs.impl.peek = async () => '{"v":{"a":1}}';
  assert.deepEqual(await o.d('tab.evaluate', { tab: 't1', expression: 'document.title' }), { a: 1 });
  o.tabs.impl.peek = async () => '{}';
  assert.equal(await o.d('tab.evaluate', { tab: 't1', expression: 'void 0' }), null);
  o.tabs.impl.peek = async () => 'undefined';
  assert.equal(await o.d('tab.evaluate', { tab: 't1', expression: 'x' }), null);
  assert.equal(o.tabs.called('exec').length, 0);
  assert.equal(o.tabs.called('peek').length, 3);
  assert.match(o.tabs.called('peek')[0][1], /^JSON\.stringify\(\{ v: \(document\.title\n\) \}\)$/);
  // the same ops without lookOnly act and exec as before
  const plain = ops();
  assert.deepEqual(await plain.d('tab.evaluate', { tab: 't1', expression: 'document.title' }), { a: 1 });
  assert.equal(plain.tabs.called('exec').length, 1);
  assert.equal(plain.tabs.called('peek').length, 0);
});

test('browser_script reports a refusal in a replay as look_only, not as a failed script', async () => {
  const t = tool((w) =>
    w.send({ t: 'done', ok: false, error: { message: 'A replay only reads', code: 'look_only', name: 'Error', stack: '' } }),
  );
  await assert.rejects(t.call({ code: 'await loc.click()' }), code('look_only', /^browser_script failed/));
});

/** Every key of the ops table in script.cjs, read from its source: the table is private to createScriptOps. */
function opNames(): string[] {
  const src = fs.readFileSync(new URL('../electron/capabilities/browser/script.cjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  const OPS = {\n'), src.indexOf('\n  };\n', src.indexOf('  const OPS = {\n')));
  return [...body.matchAll(/^    '?([A-Za-z.]+)'?: /gm)].map((m) => m[1]);
}

// A new operation is refused in a replay until it is listed in LOOK_OPS: add it below only when it cannot change anything.
const KNOWN_OPS = [
  'sleep',
  'tab.resolve',
  'tabs.new',
  'tabs.list',
  'tabs.selected',
  'tabs.get',
  'tab.goto',
  'tab.back',
  'tab.forward',
  'tab.reload',
  'tab.close',
  'tab.title',
  'tab.url',
  'tab.select',
  'tab.mark',
  'tab.screenshot',
  'tab.dialog',
  'tab.dialog.answer',
  'tab.waitForLoadState',
  'tab.domSnapshot',
  'tab.evaluate',
  'tab.logs',
  'cua.click',
  'cua.move',
  'cua.scroll',
  'cua.type',
  'cua.keys',
  'cua.drag',
  'loc.act',
  'loc.read',
  'loc.waitFor',
];

test('every operation of the ops table is listed here, so a new one is looked at before a replay may call it', () => {
  const names = opNames();
  assert.ok(names.length > 10, 'the table was found');
  const known = new Set(KNOWN_OPS);
  assert.deepEqual(
    names.filter((n) => !known.has(n)),
    [],
    'an operation not listed in KNOWN_OPS: decide whether a replay may call it (LOOK_OPS)',
  );
  assert.deepEqual(
    [...LOOK_OPS].filter((n) => !names.includes(n)),
    [],
    'LOOK_OPS names an operation the table does not have',
  );
});

test('under ctx.lookOnly every operation outside LOOK_OPS is refused with look_only before it runs, and the listed ones are not', async () => {
  const names = opNames();
  const refused = names.filter((n) => !LOOK_OPS.has(n));
  assert.ok(refused.length > 0);
  for (const op of refused) {
    const o = ops();
    o.ctx.lookOnly = { origins: ['https://a.test'] };
    await assert.rejects(o.d(op, { tab: 't1' }), code('look_only', /^A replay only reads, so it stopped before /), op);
    assert.match(o.ctx.lookRefused, /A replay only reads/, op);
    assert.deepEqual(o.tabs.calls, [], `${op} reached the tabs`);
  }
  for (const op of LOOK_OPS) {
    const ctx: any = { lookOnly: { origins: ['https://a.test'] } };
    checkLookOnly(ctx, op, { url: 'https://a.test/' });
    assert.equal(ctx.lookRefused, undefined, op);
  }
});

test('tab.reload, tab.back and tab.forward are refused in a replay (they can send a form again); sleep is allowed', async () => {
  for (const op of ['tab.reload', 'tab.back', 'tab.forward']) {
    const o = ops();
    o.ctx.lookOnly = { origins: ['https://a.test'] };
    await assert.rejects(o.d(op, { tab: 't1' }), code('look_only'));
    assert.deepEqual(o.navs, []);
    const plain = ops();
    await plain.d(op, { tab: 't1' });
    assert.equal(plain.navs.length, 1, `${op} still works outside a replay`);
  }
  const o = ops();
  o.ctx.lookOnly = { origins: ['https://a.test'] };
  await o.d('sleep', { ms: 5 });
  assert.equal(o.ctx.lookRefused, undefined);
  assert.equal(o.clock.now, 1_000_005);
});

test('lookRefusal does nothing without a refusal', () => {
  assert.doesNotThrow(() => lookRefusal({}));
  assert.doesNotThrow(() => lookRefusal({ lookOnly: LOOK }));
  assert.throws(() => lookRefusal({ lookRefused: 'no' }), code('look_only', /^no$/));
});

/** browser_script over a session whose script `body` gets the op dispatcher, as the worker's script would. */
function scriptRun(body: (d: (op: string, args: any) => Promise<any>) => Promise<any>, ctx: any) {
  const tabs = fakeTabs();
  tabs.impl.current = () => tabs.tab;
  tabs.impl.state = () => '<browser_state/>';
  tabs.impl.peek = async () => {
    throw new ToolError('A replay only reads, and this JavaScript would change the page: EvalError', 'look_only');
  };
  const sessions = {
    get: () => ({
      run: async ({ dispatch }: any) => {
        const value = await body(dispatch);
        return { ok: true, value, logs: [], ms: 1 };
      },
    }),
  };
  const deps = { tabs, sessions, gate: () => {}, navigate: async () => '', confirmed: async () => {}, act: undefined };
  return browserScript({ code: 'x' }, { chatId: 'c1', segmentId: 's1', ...ctx }, deps);
}

test('browser_script: a script that catches a refused action, or a refused page JavaScript, and returns still fails with look_only', async () => {
  const swallow = (op: string, args: any) => async (d: any) => {
    try {
      await d(op, args);
    } catch {
      // the script goes on as if nothing happened
    }
    return 'done';
  };
  await assert.rejects(
    scriptRun(swallow('loc.act', { ...loc(), action: 'click' }), { lookOnly: LOOK }),
    code('look_only', /^A replay only reads, so it stopped before loc\.act\.$/),
  );
  await assert.rejects(
    scriptRun(swallow('tab.evaluate', { tab: 't1', expression: 'document.body.remove()' }), { lookOnly: LOOK }),
    code('look_only', /this JavaScript would change the page/),
  );
  // outside a replay the same script finishes; a replay's script that only reads does too
  const outside = await scriptRun(swallow('tab.title', { tab: 't1' }), {});
  assert.match(outside[0].text, /Result: done/);
  const reads = await scriptRun(swallow('tab.title', { tab: 't1' }), { lookOnly: LOOK });
  assert.match(reads[0].text, /Result: done/);
});

test('in a replay page JavaScript is a read: the read gate, no card saying it cannot be undone; otherwise a write and a card', async () => {
  const seen: any[] = [];
  const tab = { id: 't1', url: 'https://a.test/' };
  const run = async (lookOnly: boolean) => {
    seen.length = 0;
    const dispatch = createScriptOps({
      tabs: {
        current: () => tab,
        resolve: async () => tab,
        run: (_t: any, f: any) => f(),
        ready: async () => {},
        peek: async () => '{"v":1}',
        exec: async () => '{"v":2}',
      },
      ctx: { chatId: 'c', signal: new AbortController().signal, ...(lookOnly ? { lookOnly: LOOK } : {}) },
      gate: async (_t: any, need: string) => void seen.push(['gate', need]),
      navigate: async () => '',
      confirmed: async () => void seen.push(['card']),
      images: [],
      deadline: Date.now() + 5000,
    });
    return dispatch('tab.evaluate', { tab: 't1', expression: '1' });
  };
  assert.equal(await run(true), 1);
  assert.deepEqual(seen, [['gate', 'read']]);
  assert.equal(await run(false), 2);
  assert.deepEqual(seen, [['gate', 'write'], ['card']]);
});
