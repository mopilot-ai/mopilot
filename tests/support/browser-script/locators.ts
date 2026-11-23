// Browser-script locators unit cases with shared tab, clock and worker fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError, code, loc, ops } from './fixture';

export function registerLocatorsCases() {
  test('reserved locator actions fail before visiting a page or dispatching an inherited function', async () => {
    const { d, gates } = ops();
    for (const action of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
      await assert.rejects(d('loc.act', loc({ action })), code('bad_args', /Unknown locator action/));
    assert.deepEqual(gates, []);
  });

  test('locator actions: click waits for one visible, enabled, uncovered element, then clicks its center or a position', async () => {
    const { d, tabs, gates } = ops();
    assert.equal(await d('loc.act', loc({ action: 'click', options: { button: 'middle', clickCount: 2, modifiers: 'ctrl' } })), null);
    assert.deepEqual(tabs.called('click')[0].slice(1), [
      { x: 50, y: 40 },
      { button: 'middle', clickCount: 2, modifiers: 2, holdMs: 0 },
    ]);
    assert.deepEqual(tabs.called('locate')[0].slice(1), ['ref_1', { hit: true }]);
    await d('loc.act', loc({ action: 'click', options: { position: { x: 2, y: 3 } } }));
    assert.deepEqual(tabs.called('click')[1][1], { x: 42, y: 38 });
    await d('loc.act', loc({ action: 'click', options: { position: { x: 'a', y: 3 } } }));
    assert.deepEqual(tabs.called('click')[2][1], { x: 50, y: 40 });
    await d('loc.act', loc({ action: 'click' }));
    assert.equal(tabs.called('settle').length, 4);
    tabs.result = 'dialog';
    await d('loc.act', loc({ action: 'click' }));
    assert.equal(tabs.called('settle').length, 4, 'no settling under a dialog');
    assert.deepEqual([...new Set(gates)], ['write']);
  });

  test('locator actions wait: nothing yet, hidden, disabled, covered or replaced elements, until the timeout says why', async () => {
    const w = ops();
    let n = 0;
    const states = [{ visible: false, enabled: true }, { visible: true, enabled: false }, null, { visible: true, enabled: true }];
    w.tabs.q = () =>
      n++ === 0 ? { sessionId: 'S', refs: [], count: 0, desc: [] } : { sessionId: 'S', refs: ['ref_1'], count: 1, desc: ['x'] };
    w.tabs.impl.inspect = async () => [states.length ? states.shift() : { visible: true, enabled: true }];
    let covered = 2;
    w.tabs.impl.locate = async () => ({ ...w.tabs.loc, cover: covered-- > 0 ? '<div#overlay>' : null });
    const t0 = w.clock.now;
    await w.d('loc.act', loc({ action: 'click' }));
    assert.equal(w.tabs.called('click').length, 1);
    assert.equal(w.clock.now - t0, 6 * 200);
    // each reason, at the timeout
    const reasons: [any, any, string][] = [
      [{ sessionId: 'S', refs: [], count: 0, desc: [] }, null, 'to appear (nothing matches yet)'],
      [null, { visible: false, enabled: true }, 'to be visible'],
      [null, { visible: true, enabled: false }, 'to be enabled'],
      [null, null, 'to stay attached (the page replaced it)'],
    ];
    for (const [q, s, why] of reasons) {
      const x = ops();
      if (q) x.tabs.q = () => q;
      x.tabs.impl.inspect = async () => [s];
      await assert.rejects(
        x.d('loc.act', loc({ action: 'click', timeoutMs: 500 })),
        code('timeout', new RegExp(`^Timed out after 500 ms waiting for locator\\("button"\\) ${why.replace(/[()]/g, '\\$&')}\\.$`)),
      );
    }
    const c = ops();
    c.tabs.loc = { ...c.tabs.loc, cover: '<div#overlay>' };
    await assert.rejects(
      c.d('loc.act', loc({ action: 'click', timeoutMs: 0 })),
      code('timeout', /to receive the click \(<div#overlay> is in front of it\)/),
    );
    // force skips the checks
    await c.d('loc.act', loc({ action: 'click', options: { force: true } }));
    assert.equal(c.tabs.called('click').length, 1);
    const f = ops();
    f.tabs.st = { visible: false, enabled: false, editable: false };
    await f.d('loc.act', loc({ action: 'click', options: { force: true } }));
    assert.equal(f.tabs.called('click').length, 1);
  });

  test('locators: several matches fail at once (strict); stale refs are waited out; other failures surface', async () => {
    const w = ops();
    w.tabs.q = () => ({ sessionId: 'S', refs: ['ref_1', 'ref_2'], count: 7, desc: ['a', 'b'] });
    await assert.rejects(
      w.d('loc.act', loc({ action: 'click' })),
      code('strict', /^locator\("button"\) matched 7 elements \(a, b, …\)\. Make it match one/),
    );
    w.tabs.q = () => ({ sessionId: 'S', refs: ['ref_1', 'ref_2'], count: 2, desc: ['a', 'b'] });
    await assert.rejects(w.d('loc.act', loc({ action: 'click' })), code('strict', /matched 2 elements \(a, b\)\./));
    const s = ops();
    let stale = true;
    s.tabs.impl.locate = async () => {
      if (stale) {
        stale = false;
        throw new ToolError('ref_1 is stale', 'stale_ref');
      }
      return s.tabs.loc;
    };
    await s.d('loc.act', loc({ action: 'click' }));
    assert.equal(s.tabs.called('locate').length, 2);
    s.tabs.impl.locate = async () => {
      throw new ToolError('outside', 'outside_viewport');
    };
    await assert.rejects(s.d('loc.act', loc({ action: 'click' })), code('outside_viewport'));
    s.tabs.impl.locate = async () => {
      throw new Error('page crashed');
    };
    await assert.rejects(s.d('loc.act', loc({ action: 'click' })), /page crashed/);
    await assert.rejects(s.d('loc.act', loc({ action: 'fly' })), code('bad_args', /^Unknown locator action: fly$/));
  });

  test('locator actions: hover, fill, clear, type, press, select, focus and scroll', async () => {
    const { d, tabs, gates } = ops();
    await d('loc.act', loc({ action: 'hover' }));
    assert.equal(tabs.called('hover').length, 1);
    await d('loc.act', loc({ action: 'fill', value: 'abc' }));
    assert.deepEqual(tabs.called('formInput')[0].slice(1), ['ref_1', 'abc']);
    tabs.st = { ...tabs.st, tag: 'select' };
    await assert.rejects(d('loc.act', loc({ action: 'fill', value: 'x' })), code('bad_args', /is a <select>: use selectOption\(\)/));
    tabs.st = { ...tabs.st, tag: 'input', editable: false };
    await assert.rejects(d('loc.act', loc({ action: 'fill', value: 'x', timeoutMs: 0 })), code('timeout', /to be editable/));
    tabs.st = { ...tabs.st, editable: true };
    await d('loc.act', loc({ action: 'type', value: 'hi' }));
    await d('loc.act', loc({ action: 'press', value: 'Enter' }));
    assert.deepEqual([tabs.called('typeText')[0][1], tabs.called('keys')[0].slice(1)], ['hi', ['Enter', 1, { holdMs: 0 }]]);
    assert.equal(tabs.called('focus').length, 2);
    tabs.result = 'dialog';
    const settled = tabs.called('settle').length;
    await d('loc.act', loc({ action: 'type', value: 'x' }));
    await d('loc.act', loc({ action: 'press', value: 'Enter' }));
    assert.equal(tabs.called('settle').length, settled);
    assert.deepEqual(await d('loc.act', loc({ action: 'select', value: ['a', { index: 2 }] })), ['a', { index: 2 }]);
    assert.deepEqual(
      await d('loc.act', loc({ action: 'select', value: 'a' })),
      [],
      'not a list: nothing to select, which the host refuses',
    );
    await d('loc.act', loc({ action: 'focus' }));
    await d('loc.act', loc({ action: 'scroll' }));
    assert.equal(tabs.called('scrollTo').length, 1);
    assert.deepEqual(gates, ['read', 'write', 'write', 'write', 'write', 'write', 'write', 'write', 'write', 'write', 'read', 'read']);
    // press and focus don't need a visible element
    tabs.st = { ...tabs.st, visible: false, enabled: false };
    await d('loc.act', loc({ action: 'focus' }));
    await d('loc.act', loc({ action: 'press', value: 'Tab' }));
    const ro = ops({ deny: 'write' });
    await assert.rejects(ro.d('loc.act', loc({ action: 'click' })), code('read_only'));
    await ro.d('loc.act', loc({ action: 'hover' }));
  });

  test("locator press and click with Playwright's delay hold the key or the button down that long, within the script's time", async () => {
    const { d, tabs } = ops({ budget: 1000 });
    // a hold never outlasts the script: it ends by the deadline
    await d('cua.keys', { tab: 't1', keys: 'shift', delay: 5000 });
    assert.deepEqual(tabs.called('keys').at(-1).slice(1), ['shift', 1, { holdMs: 1000 }]);
    await d('loc.act', loc({ action: 'press', value: 'Shift', options: { delay: 900 } }));
    await d('loc.act', loc({ action: 'click', options: { delay: 800 } }));
    assert.deepEqual(tabs.called('keys').at(-1).slice(1), ['Shift', 1, { holdMs: 900 }]);
    assert.equal(tabs.called('click').at(-1)[2].holdMs, 800);
  });

  test('check, uncheck and setChecked: click when the state differs, set hidden native inputs directly, and verify', async () => {
    const w = ops();
    const checkbox = (checked: any, extra: any = {}) =>
      (w.tabs.st = { visible: true, enabled: true, editable: false, checked, tag: 'input', type: 'checkbox', ...extra });
    checkbox(true);
    await w.d('loc.act', loc({ action: 'check', value: true }));
    assert.equal(w.tabs.called('click').length, 0, 'already checked');
    let clicks = 0;
    w.tabs.impl.click = async () => {
      clicks++;
      checkbox(true);
    };
    checkbox(false);
    await w.d('loc.act', loc({ action: 'check', value: true }));
    assert.equal(clicks, 1);
    checkbox(false, { visible: false });
    w.tabs.impl.formInput = async () => checkbox(true, { visible: false });
    await w.d('loc.act', loc({ action: 'check', value: true }));
    assert.deepEqual(w.tabs.called('formInput').at(-1).slice(1), ['ref_1', true]);
    checkbox(false, { visible: false, tag: 'div' });
    await assert.rejects(w.d('loc.act', loc({ action: 'check', value: true })), code('bad_args', /is not visible, so it can't be clicked/));
    // force clicks even a hidden one
    checkbox(false, { visible: false, tag: 'div' });
    await w.d('loc.act', loc({ action: 'check', value: true, options: { force: true } }));
    assert.equal(clicks, 2);
    checkbox(null);
    await assert.rejects(w.d('loc.act', loc({ action: 'check', value: true })), code('bad_args', /is not a checkbox, radio or switch/));
    checkbox(true, { type: 'radio' });
    await assert.rejects(w.d('loc.act', loc({ action: 'check', value: false })), code('bad_args', /is a radio button/));
    // the click didn't change it
    w.tabs.impl.click = async () => {};
    checkbox('mixed');
    await assert.rejects(
      w.d('loc.act', loc({ action: 'check', value: false })),
      code('failed', /^Clicking locator\("button"\) did not uncheck it\.$/),
    );
    checkbox(false);
    await assert.rejects(w.d('loc.act', loc({ action: 'check', value: true })), code('failed', /did not check it/));
    // the element went away after the click: nothing to verify
    let gone = false;
    w.tabs.q = () => (gone ? { sessionId: 'S', refs: [], count: 0, desc: [] } : { sessionId: 'S', refs: ['ref_1'], count: 1, desc: ['x'] });
    w.tabs.impl.click = async () => {
      gone = true;
    };
    await w.d('loc.act', loc({ action: 'check', value: true }));
    // or was replaced: its state can't be read
    gone = false;
    let clicked = false;
    w.tabs.impl.click = async () => {
      clicked = true;
    };
    w.tabs.impl.inspect = async (_t: any, _s: any, refs: string[]) => (clicked ? [null] : refs.map(() => w.tabs.st));
    await w.d('loc.act', loc({ action: 'check', value: true }));
  });

  test('locator reads: count, visibility, texts, attributes, values, states and boxes', async () => {
    const { d, tabs, gates } = ops();
    tabs.values = { innerText: 'Go!', textContent: 'Go', innerHTML: '<b>Go</b>', attr: null, value: 'typed' };
    assert.equal(await d('loc.read', loc({ what: 'count' })), 1);
    assert.equal(await d('loc.read', loc({ what: 'isVisible' })), true);
    assert.equal(await d('loc.read', loc({ what: 'innerText' })), 'Go!');
    assert.equal(await d('loc.read', loc({ what: 'textContent' })), 'Go');
    assert.equal(await d('loc.read', loc({ what: 'innerHTML' })), '<b>Go</b>');
    assert.equal(await d('loc.read', loc({ what: 'attr', name: 'href' })), null);
    assert.equal(await d('loc.read', loc({ what: 'value' })), 'typed');
    assert.deepEqual(tabs.called('inspect').at(-1).slice(1), ['S', ['ref_1'], 'value', undefined]);
    assert.equal(await d('loc.read', loc({ what: 'isEnabled' })), true);
    assert.equal(await d('loc.read', loc({ what: 'isEditable' })), true);
    assert.deepEqual(await d('loc.read', loc({ what: 'boundingBox' })), { x: 40, y: 35, width: 20, height: 10 });
    assert.deepEqual(tabs.called('locate').at(-1).slice(1), ['ref_1', { scroll: false }]);
    assert.deepEqual(await d('loc.read', loc({ what: 'screenshot' })), { screenshot: 1, tab: 't1', width: 400, height: 300 });
    assert.deepEqual(tabs.called('capture').at(-1)[2], { region: [40, 35, 60, 45] });
    assert.deepEqual([...new Set(gates)], ['read']);
    tabs.st = { ...tabs.st, checked: 'mixed', visible: false };
    assert.equal(await d('loc.read', loc({ what: 'isChecked' })), false);
    assert.equal(await d('loc.read', loc({ what: 'isVisible' })), false);
    assert.equal(await d('loc.read', loc({ what: 'boundingBox' })), null);
    tabs.st = { ...tabs.st, checked: true };
    assert.equal(await d('loc.read', loc({ what: 'isChecked' })), true);
    tabs.st = { ...tabs.st, checked: null };
    await assert.rejects(d('loc.read', loc({ what: 'isChecked' })), code('bad_args', /not a checkbox/));
    tabs.values = { value: { error: 'inputValue needs an input' }, innerText: null };
    await assert.rejects(d('loc.read', loc({ what: 'value' })), code('bad_args', /^inputValue needs an input$/));
    await assert.rejects(d('loc.read', loc({ what: 'innerText' })), code('stale_ref', /went away while reading it/));
    await assert.rejects(d('loc.read', loc({ what: 'bogus' })), code('bad_args', /^Unknown locator read: bogus$/));
    // texts of every match (stale ones dropped); isVisible of nothing, of a replaced element, or of several
    tabs.q = () => ({ sessionId: 'S', refs: ['ref_1', 'ref_2'], count: 2, desc: ['a', 'b'] });
    tabs.impl.inspect = async (_t: any, _s: any, refs: string[], what: string) => refs.map((r, i) => (i ? null : `${what}:${r}`));
    assert.deepEqual(await d('loc.read', loc({ what: 'allTextContents' })), ['textContent:ref_1']);
    assert.deepEqual(await d('loc.read', loc({ what: 'allInnerTexts' })), ['innerText:ref_1']);
    await assert.rejects(d('loc.read', loc({ what: 'isVisible' })), code('strict'));
    tabs.q = () => ({ sessionId: 'S', refs: [], count: 0, desc: [] });
    assert.equal(await d('loc.read', loc({ what: 'isVisible' })), false);
    tabs.q = () => ({ sessionId: 'S', refs: ['ref_1'], count: 1, desc: ['a'] });
    tabs.impl.inspect = async () => [null];
    assert.equal(await d('loc.read', loc({ what: 'isVisible' })), false);
  });

  test('waitFor: attached, detached, visible and hidden, strict, with the reason at the timeout', async () => {
    const w = ops();
    const none = { sessionId: 'S', refs: [], count: 0, desc: [] };
    const one = { sessionId: 'S', refs: ['ref_1'], count: 1, desc: ['a'] };
    const wait = (state: any, q: any, st: any = { visible: true }, timeoutMs = 0) => {
      w.tabs.q = () => q;
      w.tabs.impl.inspect = async () => [st];
      return w.d('loc.waitFor', loc({ state, timeoutMs }));
    };
    assert.equal(await wait('attached', one), null);
    assert.equal(await wait('detached', none), null);
    assert.equal(await wait('visible', one), null);
    assert.equal(await wait(undefined, one), null);
    assert.equal(await wait('hidden', none), null);
    assert.equal(await wait('hidden', one, { visible: false }), null);
    assert.equal(await wait('hidden', one, null), null);
    await assert.rejects(wait('detached', one), code('timeout', /to go away\.$/));
    await assert.rejects(wait('attached', none), code('timeout', /to appear \(nothing matches yet\)\.$/));
    await assert.rejects(wait('bogus', none), code('timeout', /to appear/));
    await assert.rejects(wait('visible', one, { visible: false }), code('timeout', /to be visible\.$/));
    await assert.rejects(wait('hidden', one, { visible: true }), code('timeout', /to be hidden\.$/));
    await assert.rejects(wait('visible', { ...one, count: 2, desc: ['a', 'b'] }), code('strict'));
    // it keeps looking until the state comes
    let n = 0;
    w.tabs.q = () => (n++ < 3 ? none : one);
    await w.d('loc.waitFor', loc({ state: 'attached', timeoutMs: 5000 }));
    assert.equal(n, 4);
  });

  test('timeouts: a locator waits at most its timeoutMs, the default 10 s, and never past the script deadline', async () => {
    const x = ops({ budget: 3000 });
    x.tabs.q = () => ({ sessionId: 'S', refs: [], count: 0, desc: [] });
    await assert.rejects(x.d('loc.act', loc({ action: 'click' })), code('timeout', /^Timed out after 3000 ms/));
    const y = ops();
    y.tabs.q = () => ({ sessionId: 'S', refs: [], count: 0, desc: [] });
    await assert.rejects(y.d('loc.act', loc({ action: 'click', timeoutMs: 'soon' })), code('timeout', /^Timed out after 10000 ms/));
    await assert.rejects(y.d('loc.act', loc({ action: 'click', timeoutMs: 250 })), code('timeout', /^Timed out after 250 ms/));
    const z = ops({ budget: 100 });
    z.clock.now += 500;
    z.tabs.q = () => ({ sessionId: 'S', refs: [], count: 0, desc: [] });
    await assert.rejects(z.d('loc.act', loc({ action: 'click', timeoutMs: 5000 })), code('timeout', /^Timed out after 0 ms/));
  });

  // ---------------------------------------------------------------- script sessions
}
