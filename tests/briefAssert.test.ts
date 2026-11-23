// tests/support/brief-assert.ts: a failing assertion on a happy-dom node or a DOM/React event fails fast with a short message.
import { window } from './support/dom.ts'; // first: react-dom decides what the DOM supports when it loads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import looseAssert, { AssertionError } from 'node:assert';
import { strictEqual } from 'node:assert/strict';
import { inspect } from 'node:util';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { briefComparison, briefCopy, COMPARISONS, domSummary, holdsDom, installBriefAssert } from './support/brief-assert.ts';

const document = window.document as unknown as Document;

function banner() {
  const el = document.createElement('div');
  el.className = 'acct-banner';
  el.setAttribute('role', 'alert');
  document.body.append(el);
  return el;
}

/** The assertion error `run` throws, which must come quickly and be short. */
function failure(run: () => void): AssertionError {
  const started = performance.now();
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AssertionError, `expected an AssertionError, got ${String(caught)}`);
  assert.ok(caught.message.length < 2000, `message of ${caught.message.length} characters`);
  assert.ok(performance.now() - started < 1000);
  return caught;
}

test('a failing assert.equal(element, null) throws a short message naming the element (the repro)', () => {
  const error = failure(() => assert.equal(banner(), null));
  assert.match(error.message, /'<div class="acct-banner" role="alert">'/);
  assert.equal(error.actual, '<div class="acct-banner" role="alert">');
  assert.equal(error.expected, null);
  assert.equal(error.operator, 'strictEqual');
  // the stack starts at the test, not inside the wrapper
  assert.match(String(error.stack), /briefAssert\.test\.ts/);
  assert.doesNotMatch(String(error.stack).split('\n')[1] ?? '', /brief-assert\.ts/);
});

test('every comparison of node:assert and node:assert/strict is wrapped, named imports included', () => {
  for (const name of COMPARISONS) {
    assert.equal((assert as any)[name].brief, true, name);
    assert.equal((looseAssert as any)[name].brief, true, name);
  }
  assert.equal((strictEqual as any).brief, true);
  const error = failure(() => strictEqual(banner(), null, 'banner is gone'));
  assert.match(error.message, /^banner is gone/);
  // the loose operators keep their own operator names
  assert.equal(failure(() => looseAssert.equal(banner(), null)).operator, '==');
  assert.equal(failure(() => looseAssert.notEqual(document.body, document.body)).operator, '!=');
  assert.match(failure(() => looseAssert.deepEqual([banner()], [])).message, /<div class="acct-banner" role="alert">/);
});

test('deepStrictEqual between two different nodes, and the not- comparisons, stay bounded', () => {
  const error = failure(() => assert.deepStrictEqual(banner(), document.createElement('span')));
  assert.match(error.message, /<div class="acct-banner" role="alert">/);
  assert.match(error.message, /<span>/);
  const same = banner();
  assert.equal(failure(() => assert.notStrictEqual(same, same)).operator, 'notStrictEqual');
  assert.equal(failure(() => assert.notDeepStrictEqual([same], [same])).operator, 'notDeepStrictEqual');
  failure(() => assert.partialDeepStrictEqual({ el: same, n: 1 }, { n: 2 }));
});

test('passing comparisons with DOM values return as before', () => {
  const el = banner();
  const event = new window.MouseEvent('click');
  assert.equal(el, el);
  assert.notEqual(el, null);
  assert.deepStrictEqual([[event]], [[event]]);
  assert.partialDeepStrictEqual({ el, n: 1 }, { el });
});

test('a mock that recorded DOM and React click events fails a deepEqual in brief', async () => {
  const calls: unknown[][] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(createElement('button', { className: 'go', onClick: (...a: unknown[]) => calls.push(a) }, 'Go')));
  const button = host.querySelector('button.go') as HTMLElement;
  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event));
  assert.equal(calls.length, 1);
  const error = failure(() => assert.deepEqual(calls, [[{ type: 'click' }]]));
  assert.match(error.message, /SyntheticEvent\(click\)/);
  // the button's React fiber is summarized as well
  const fiberKey = Object.keys(button).find((key) => key.startsWith('__reactFiber'));
  assert.ok(fiberKey);
  assert.match(failure(() => assert.deepEqual({ fiber: (button as any)[fiberKey] }, {})).message, /FiberNode\(button\)/);
  await act(async () => root.unmount());
});

test('an error holding a DOM node is copied with its message and the node in brief', () => {
  const error = failure(() => assert.deepEqual([Object.assign(new Error('boom'), { node: banner() })], []));
  assert.match(error.message, /Error \{\n.*message: 'boom',\n.*node: '<div class="acct-banner" role="alert">'/s);
});

test('large values without DOM objects keep node:assert’s own report, and big buffers compare quickly', () => {
  const rows = Array.from({ length: 6000 }, (_, i) => ({ i }));
  const changed = rows.map((row) => (row.i === 3000 ? { i: -1 } : row));
  const error = failure(() => assert.deepStrictEqual(rows, changed));
  assert.equal(error.generatedMessage, true);
  assert.match(error.message, /i: -1/);
  const started = performance.now();
  assert.deepStrictEqual(Buffer.alloc(16 * 2 ** 20, 1), Buffer.alloc(16 * 2 ** 20, 1));
  assert.ok(performance.now() - started < 1000);
});

test('values without DOM objects keep node:assert’s own message', () => {
  const error = failure(() => assert.deepStrictEqual({ a: 1 }, { a: 2 }));
  assert.equal(error.generatedMessage, true);
  assert.match(error.message, /\+ {3}a: 1\n- {3}a: 2/);
  // a missing argument and an Error message are node:assert's to handle
  assert.throws(() => (assert.equal as any)(banner()), { code: 'ERR_MISSING_ARGS' });
  const own = new Error('mine');
  assert.throws(
    () => assert.equal(banner(), null, own),
    (error) => error === own,
  );
});

test('an error other than the comparison failing is rethrown', () => {
  const trap = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('trapped');
      },
    },
  );
  assert.equal(holdsDom(trap), true);
  assert.throws(() => assert.deepStrictEqual(trap, {}), /trapped/);
  // and an object that cannot be listed is reported as such
  assert.equal(failure(() => assert.equal(trap, null)).actual, '[unreadable object]');
});

test('domSummary names windows, elements, text, comments, documents, events and fibers', () => {
  const el = document.createElement('input');
  el.setAttribute('disabled', '');
  el.setAttribute('placeholder', 'x'.repeat(80));
  for (let i = 0; i < 8; i++) el.setAttribute(`data-a${i}`, String(i));
  const summary = domSummary(el) ?? '';
  assert.match(summary, /^<input disabled placeholder="x{57}\.\.\." data-a0="0"/);
  assert.equal(summary.match(/ /g)?.length, 6);
  assert.equal(domSummary(window), 'Window(http://localhost/)');
  assert.equal(domSummary({ window: undefined }), undefined);
  const self: any = { document: {} };
  self.window = self;
  assert.equal(domSummary(self), 'Window()');
  assert.equal(domSummary(document.createTextNode('y'.repeat(70))), `#text "${'y'.repeat(57)}..."`);
  assert.equal(domSummary(document.createComment('note')), '#comment "note"');
  assert.equal(domSummary(document), '#document');
  assert.equal(domSummary({ nodeType: 1, nodeName: 'X', tagName: 'X' }), '<x>');
  assert.equal(domSummary(new window.KeyboardEvent('keydown')), 'KeyboardEvent(keydown)');
  const bare = Object.assign(Object.create(null), { type: 'drop', preventDefault() {}, bubbles: true });
  assert.equal(domSummary(bare), 'Event(drop)');
  const fiber = (type: unknown) => ({ tag: 0, stateNode: null, return: null, alternate: null, type });
  assert.equal(domSummary(fiber({ displayName: 'Shown' })), 'FiberNode(Shown)');
  assert.equal(domSummary(fiber(function Named() {})), 'FiberNode(Named)');
  assert.equal(domSummary(fiber(null)), 'FiberNode(0)');
  assert.equal(domSummary({ tag: 1 }), undefined);
  assert.equal(domSummary([1, 2]), undefined);
  const throwing = {
    get window(): unknown {
      throw new Error('no');
    },
  };
  assert.equal(domSummary(throwing), '[unreadable object]');
});

test('holdsDom finds DOM objects in Maps, Sets and symbol keys, and gives up on graphs over the budget', () => {
  const el = banner();
  assert.equal(holdsDom(null), false);
  assert.equal(holdsDom(3), false);
  assert.equal(holdsDom({ a: [1, { b: 'c' }] }), false);
  assert.equal(holdsDom(new Map([[el, 1]])), true);
  assert.equal(holdsDom(new Map([[1, el]])), true);
  assert.equal(holdsDom(new Set([el])), true);
  assert.equal(holdsDom({ [Symbol('s')]: el }), true);
  // a getter is not called, and a non-enumerable property is not formatted by assert either
  assert.equal(
    holdsDom(
      Object.defineProperties(
        {},
        {
          g: { get: () => el, enumerable: true },
          h: { value: el, enumerable: false },
        },
      ),
    ),
    false,
  );
  const cycle: any = { a: {} };
  cycle.a.back = cycle;
  assert.equal(holdsDom(cycle), false);
  // only the first `budget` objects are searched; a node past them is the RSS watchdog's to catch
  assert.equal(holdsDom([el, {}, {}], 2), false);
  assert.equal(holdsDom([{}, {}, el], 2), true);
  // bytes, times and patterns are not searched, and a long list does not overflow the stack
  for (const opaque of [new Uint8Array(4), new ArrayBuffer(4), new Date(0), /x/]) assert.equal(holdsDom(opaque), false);
  assert.equal(holdsDom(Array.from({ length: 300_000 }, (_, i) => i)), false);
});

test('briefCopy keeps the shape and class names, summarizes DOM objects, and stops at the budget', () => {
  class Box {
    item: unknown;
    constructor(item: unknown) {
      this.item = item;
    }
  }
  const el = banner();
  const cycle: any = { name: 'loop' };
  cycle.self = cycle;
  const date = new Date(0);
  const bytes = new Uint8Array([1]);
  const copy: any = briefCopy({
    boxes: [new Box(el), new Box(2)],
    map: new Map([[el, el]]),
    set: new Set([el]),
    date,
    regexp: /x/,
    bytes,
    cycle,
    nothing: Object.assign(Object.create(null), { el }),
    get lazy() {
      return el;
    },
    long: Array.from({ length: 60 }, (_, i) => i),
    wide: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])),
    buffer: new ArrayBuffer(2),
    bigMap: new Map(Array.from({ length: 60 }, (_, i) => [i, i])),
    bigSet: new Set(Array.from({ length: 60 }, (_, i) => i)),
    nested: { twice: el, again: el },
  });
  const text = '<div class="acct-banner" role="alert">';
  assert.equal(inspect(copy.boxes[0], { depth: 0 }), `Box { item: '${text}' }`);
  assert.equal(copy.boxes[1].constructor, copy.boxes[0].constructor);
  assert.deepEqual([...copy.map], [[text, text]]);
  assert.deepEqual([...copy.set], [text]);
  assert.equal(copy.date, date);
  assert.equal(copy.bytes, bytes);
  assert.equal(copy.cycle.self, copy.cycle);
  assert.equal(Object.getPrototypeOf(copy.nothing), null);
  assert.equal(copy.nothing.el, text);
  assert.equal(copy.lazy, '[Getter]');
  assert.equal(copy.long.length, 51);
  assert.equal(copy.long[50], '... 10 more items');
  assert.equal(copy.bigMap.size, 51);
  assert.equal(copy.bigMap.get('...'), '10 more entries');
  assert.equal(copy.bigSet.size, 51);
  assert.ok(copy.bigSet.has('... 10 more entries'));
  assert.equal(Object.keys(copy.wide).length, 51);
  assert.equal(copy.wide['...'], '10 more properties');
  assert.ok(copy.buffer instanceof ArrayBuffer);
  assert.equal(copy.nested.again, text);
  assert.deepEqual(briefCopy([[1], [2], [3]], 2), [[1], '[...]', '[...]']);
  assert.equal(briefCopy('plain'), 'plain');
  // an object whose class has no name inspects as a plain object
  assert.equal(inspect(briefCopy(Object.assign(Object.create(Object.create(null)), { a: 1 }))), '{ a: 1 }');
  const throwing = {
    get window(): unknown {
      throw new Error('no');
    },
  };
  assert.equal(briefCopy(throwing), '[unreadable object]');
});

test('t.assert from node:test reports DOM values in brief too', (t) => {
  const error = failure(() => t.assert.equal(banner(), null));
  assert.equal(error.actual, '<div class="acct-banner" role="alert">');
  assert.equal(error.operator, '==');
});

test('installBriefAssert wraps each comparison once, skips what a target lacks, and registers the loose ones with t.assert', () => {
  const calls: string[] = [];
  const registered: string[] = [];
  const strict = { strictEqual: (a: unknown, b: unknown) => calls.push(`${a}${b}`) };
  const target: Record<string, any> = { equal: strict.strictEqual, strict };
  installBriefAssert(target, (name) => registered.push(name));
  const wrapped = target.equal;
  installBriefAssert(target, () => {});
  assert.equal(target.equal, wrapped);
  assert.equal(target.strict.strictEqual.brief, true);
  assert.deepEqual(registered, ['equal']);
  target.equal(1, 2);
  assert.deepEqual(calls, ['12']);
  // the wrapper is named after the comparison, for stacks
  assert.equal(briefComparison(function deepEqual() {}).name, 'deepEqual');
});
