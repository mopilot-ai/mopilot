// The control pill's fence (electron/capabilities/controlPill.cjs, #1579) over the real helper client
// (electron/capabilities/computer.cjs) and a scripted helper socket: every pointer request (click, drag, move, scroll,
// button) goes out inside the pill's suspendPointer, so an agent's click lands on the app the hit test approved and
// never on the pill; keys, typing and reads go out directly. indicatorWithPill wires it, Stop and Esc's sender.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { scriptedHelper } from './helpers/scriptedHelper.ts';

const require = createRequire(import.meta.url);
const { ComputerHelper } = require('../electron/capabilities/computer.cjs');
const { fencePointer, indicatorWithPill, ControlPills, POINTER } = require('../electron/capabilities/controlPill.cjs');

test('pointer requests go out inside suspendPointer; keys and reads do not', async () => {
  const fake = await scriptedHelper(() => ({ result: { ok: true } }));
  const helper = new ComputerHelper({ connectTo: fake.socket });
  const fenced: string[] = [];
  let inside = false;
  fencePointer(helper, {
    suspendPointer: async (send: () => Promise<unknown>) => {
      inside = true;
      try {
        const r = await send();
        fenced.push(fake.log.at(-1)!.method);
        return r;
      } finally {
        inside = false;
      }
    },
  });
  try {
    assert.deepEqual([...POINTER].sort(), ['input.button', 'input.click', 'input.drag', 'input.move', 'input.scroll']);
    assert.deepEqual(await helper.click(10, 20), { ok: true });
    await helper.drag(1, 2, 3, 4);
    await helper.move(5, 6);
    await helper.scroll(5, 6, 0, -3);
    await helper.call('input.button', { button: 'left', down: true });
    await helper.key('cmd+s');
    await helper.call('input.cursor');
    assert.deepEqual(fenced, ['input.click', 'input.drag', 'input.move', 'input.scroll', 'input.button']);
    assert.equal(inside, false);
    assert.deepEqual(
      fake.log.map((l) => l.method).filter((m) => m.startsWith('input.')),
      ['input.click', 'input.drag', 'input.move', 'input.scroll', 'input.button', 'input.key', 'input.cursor'],
    );
  } finally {
    helper.stop();
    await fake.close();
  }
});

test('indicatorWithPill: the pill rides on the indicator, Esc asks the helper who sent it, and the helper is fenced', async () => {
  const sent: string[] = [];
  const helper = {
    call: async (method: string) => sent.push(method),
    escapeSender: async () => 'agent',
  };
  const indicator = indicatorWithPill(helper, { electron: null, onEscape: () => undefined });
  assert.ok(indicator.pills instanceof ControlPills);
  assert.equal(await indicator.escapeSender(), 'agent');
  await helper.call('input.click');
  assert.equal(indicator.pills.suspended, 1, 'the click holds the pill click-through until it settles');
  // an explicit sender wins
  const own = async () => 'person';
  assert.equal(indicatorWithPill({ ...helper }, { electron: null, onEscape: () => undefined, escapeSender: own }).escapeSender, own);
  assert.deepEqual(sent, ['input.click']);
});
