// Browser-script raw-input unit cases with shared tab, clock and worker fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { code, ops } from './fixture';

export function registerRawInputCases() {
  test('raw input: clicks, moves, wheel, typing, keys and drags at viewport points, gated like the browser tools', async () => {
    const { d, tabs, gates } = ops();
    assert.equal(await d('cua.click', { tab: 't1', x: 1, y: 2, button: 'right', clickCount: 2.6, modifiers: 'shift' }), null);
    await d('cua.click', { tab: 't1', x: 1, y: 2, button: 'nope', clickCount: 9 });
    assert.deepEqual(
      tabs.called('click').map((c) => c.slice(1)),
      [
        [
          { x: 1, y: 2 },
          { button: 'right', clickCount: 3, modifiers: 8, holdMs: 0 },
        ],
        [
          { x: 1, y: 2 },
          { button: 'left', clickCount: 3, modifiers: 0, holdMs: 0 },
        ],
      ],
    );
    await d('cua.move', { tab: 't1', x: 3, y: 4 });
    await d('cua.scroll', { tab: 't1', x: null, y: null, dx: 0, dy: 100 });
    await d('cua.scroll', { tab: 't1', x: 5, y: 6, dx: 1, dy: 2 });
    assert.deepEqual(
      tabs.called('wheel').map((c) => c.slice(1)),
      [
        [{ x: 400, y: 300 }, 0, 100],
        [{ x: 5, y: 6 }, 1, 2],
      ],
    );
    await d('cua.type', { tab: 't1', text: 'hi' });
    await d('cua.keys', { tab: 't1', keys: 'ctrl+a' });
    // press and hold: a delay of ms between down and up, at most 30 s
    await d('cua.click', { tab: 't1', x: 1, y: 2, delay: 2500 });
    await d('cua.keys', { tab: 't1', keys: 'ctrl+shift', delay: 90_000 });
    assert.equal(tabs.called('click').at(-1)[2].holdMs, 2500);
    assert.deepEqual(
      tabs.called('keys').map((c) => c.slice(1)),
      [
        ['ctrl+a', 1, { holdMs: 0 }],
        ['ctrl+shift', 1, { holdMs: 30_000 }],
      ],
    );
    await d('cua.drag', {
      tab: 't1',
      path: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 9, y: 9 },
      ],
    });
    assert.deepEqual(tabs.called('drag')[0].slice(1), [
      { x: 0, y: 0 },
      { x: 9, y: 9 },
    ]);
    assert.equal(tabs.called('settle').length, 10);
    // a dialog opening under the input ends it without waiting for the page
    tabs.result = 'dialog';
    for (const [op, a] of [
      ['cua.click', { x: 1, y: 1 }],
      ['cua.type', { text: 'x' }],
      ['cua.keys', { keys: 'Enter' }],
      [
        'cua.drag',
        {
          path: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      ],
    ] as const)
      await d(op, { tab: 't1', ...a });
    assert.equal(tabs.called('settle').length, 10);
    await assert.rejects(d('cua.drag', { tab: 't1', path: [{ x: 0, y: 0 }] }), code('bad_args', /at least two points/));
    await assert.rejects(d('cua.drag', { tab: 't1' }), code('bad_args'));
    await assert.rejects(d('cua.click', { tab: 't1', x: 1, y: 1, modifiers: 'hyper' }), code('bad_args', /Unknown modifier/));
    assert.deepEqual([...new Set(gates)], ['write', 'read']);
    assert.deepEqual(gates.slice(0, 5), ['write', 'write', 'read', 'read', 'read']);
  });

  test('unknown operations and non-tool errors; sleep is capped by the time left', async () => {
    const { d, tabs, clock } = ops({ budget: 1000 });
    await assert.rejects(d('nope', {}), code('bad_args', /^Unknown browser operation: nope$/));
    await assert.rejects(d('toString', {}), code('bad_args'));
    tabs.impl.list = () => {
      throw new Error('boom');
    };
    await assert.rejects(d('tabs.list', {}), /boom/);
    const t0 = clock.now;
    assert.equal(await d('sleep', { ms: 300 }), null);
    await d('sleep', { ms: 'x' });
    await d('sleep', { ms: 99_999 });
    assert.equal(clock.now - t0, 1000);
    await d('sleep', { ms: -5 });
    assert.equal(clock.now - t0, 1000);
  });

  // ---------------------------------------------------------------- locators
}
