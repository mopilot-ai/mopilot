// The agent's cursor on a Host's desktop for the pane (electron/capabilities/hostDesktopCursor.cjs): it plays the shared observed plan, is driven by the action (approach, input at the lead before the press, press when the Host answers), is placed by the layout the agent last looked at, and belongs to one machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHostCursor, cursorAround, INPUT_LEAD_MS } = require('../electron/capabilities/hostDesktopCursor.cjs');
const { planApproach } = await import('../shared/cursorApproach.mjs');

const SHOT = { display: { id: 1, x: 0, y: 0, width: 1000, height: 500 }, pixelsPerPoint: 2, width: 2000, height: 1000 };

function rig(reduced = false) {
  const sent: [string, any][] = [];
  const cursor = createHostCursor({ emit: (chat: string, m: any) => sent.push([chat, m]), reducedMotion: () => reduced });
  return { cursor, sent };
}

test('an approach plays the shared plan from where the last action landed, placed by the layout the agent looked at; a click waits until the lead before its press', () => {
  const { cursor, sent } = rig();
  assert.equal(cursor.versionOf('h1', 'c1'), 0);
  assert.equal(cursor.agentSaw('h1', 'c1', SHOT), 1);
  assert.equal(
    cursor.agentSaw('h1', 'c1', { ...SHOT, pixelsPerPoint: 1, width: 1000, height: 500 }),
    1,
    'a scaled picture of the same layout keeps it',
  );
  const first = cursor.approach('h1', 'c1', { x: 400, y: 300 }, true);
  const want = planApproach({ from: null, to: { x: 400, y: 300 } });
  assert.equal(first.waitMs, Math.max(0, want.pressAtMs - INPUT_LEAD_MS));
  assert.deepEqual(sent[0][1].plan.samples, want.samples, 'the same timings as the cursor on this Mac');
  assert.equal(sent[0][1].version, 1);
  assert.equal(sent[0][1].hostId, 'h1');
  cursor.dispatched('c1', first.id);
  // the next starts where the last landed
  const second = cursor.approach('h1', 'c1', { x: 100, y: 100 }, true);
  assert.deepEqual(sent.at(-1)![1].plan.samples, planApproach({ from: { x: 400, y: 300 }, to: { x: 100, y: 100 } }).samples);
  cursor.dispatched('c1', second.id);
  // a move does not press: it waits for the glide
  const move = cursor.approach('h1', 'c1', { x: 120, y: 100 }, false);
  assert.equal(move.waitMs, planApproach({ from: { x: 100, y: 100 }, to: { x: 120, y: 100 } }).durationMs);
  // a layout the agent looked at later is a new version, and a cursor placed after it carries it
  assert.equal(cursor.agentSaw('h1', 'c1', { ...SHOT, display: { ...SHOT.display, width: 1200 } }), 2);
  cursor.approach('h1', 'c1', { x: 5, y: 5 }, true);
  assert.equal(sent.at(-1)![1].version, 2);
  assert.equal(cursor.approach('h1', 'c1', { x: Number.NaN, y: 1 }, true), null, 'no usable point: nothing is shown');
  assert.equal(cursor.approach('h1', 'c1', null as any, true), null);
});

test('a pane’s frame of another layout has its own version and never changes what the agent placed its action by', () => {
  const { cursor, sent } = rig();
  cursor.agentSaw('h1', 'c1', SHOT);
  const other = cursor.frameVersion('h1', 'c1', { ...SHOT, display: { ...SHOT.display, width: 1200 } });
  assert.equal(other, 2);
  assert.equal(cursor.frameVersion('h1', 'c1', SHOT), 1);
  assert.equal(cursor.versionOf('h1', 'c1'), 1, 'the agent still places by the layout it looked at');
  cursor.approach('h1', 'c1', { x: 5, y: 5 }, true);
  assert.equal(sent.at(-1)![1].version, 1, 'drawn on a frame of version 1 only');
});

test('a cursor belongs to one machine: another Host starts from nothing, and a lost machine takes its cursors', () => {
  const { cursor, sent } = rig();
  const a = cursor.approach('hA', 'c1', { x: 400, y: 300 }, true);
  cursor.dispatched('c1', a.id);
  cursor.agentSaw('hA', 'c1', SHOT);
  // the chat moved to B: A's last point and layouts are not B's
  cursor.approach('hB', 'c1', { x: 10, y: 10 }, true);
  assert.deepEqual(sent.at(-1)![1].plan.samples, planApproach({ from: null, to: { x: 10, y: 10 } }).samples);
  assert.equal(sent.at(-1)![1].hostId, 'hB');
  assert.equal(sent.at(-1)![1].version, 0);
  cursor.hideHost('hA');
  assert.equal(sent.at(-1)![1].kind, 'approach', 'A has nothing showing');
  cursor.hideHost('hB');
  assert.deepEqual(sent.at(-1)![1], { kind: 'hide', id: 0, hostId: 'hB' });
  cursor.forget('c1');
  assert.equal(cursor.versionOf('hA', 'c1'), 0);
});

test('the press, a failure and a hide only touch the action showing; a failed action leaves the next glide where the last one landed; reduced motion jumps', () => {
  const { cursor, sent } = rig();
  const a = cursor.approach('h1', 'c1', { x: 10, y: 10 }, true);
  const b = cursor.approach('h1', 'c1', { x: 50, y: 50 }, true);
  assert.equal(cursor.isCurrent('c1', a.id), false, 'a newer action replaced it');
  cursor.dispatched('c1', a.id);
  cursor.failed('c1', a.id);
  assert.equal(sent.length, 2, 'a replaced action says nothing more');
  cursor.failed('c1', b.id);
  assert.deepEqual(sent.at(-1)![1], { kind: 'hide', id: b.id, hostId: 'h1' });
  cursor.approach('h1', 'c1', { x: 90, y: 90 }, true);
  assert.deepEqual(sent.at(-1)![1].plan.samples, planApproach({ from: null, to: { x: 90, y: 90 } }).samples, 'nothing landed yet');
  cursor.hide('c1');
  const n = sent.length;
  cursor.hide('c1');
  assert.equal(sent.length, n, 'nothing showing, nothing to hide');
  const jump = rig(true);
  jump.cursor.approach('h1', 'c1', { x: 300, y: 200 }, true);
  assert.deepEqual(jump.sent[0][1].plan.samples[0], { ...jump.sent[0][1].plan.samples[0], x: 300, y: 200 }, 'it starts on the target');
});

test('cursorAround: a click approaches, goes when the cursor has arrived, presses on the Host’s answer; other calls pass through', async () => {
  const { cursor, sent } = rig();
  const order: string[] = [];
  const around = cursorAround(
    cursor,
    'h1',
    async (ms: number) => void order.push(`wait ${ms > 0}`),
    () => false,
  );
  assert.equal(await around('c1', 'screenshot', {}, async () => 'shot'), 'shot');
  assert.equal(sent.length, 0);
  const out = await around('c1', 'input.click', { x: 10, y: 20 }, async () => (order.push('click'), 'ok'));
  assert.equal(out, 'ok');
  assert.deepEqual(order, ['wait true', 'click']);
  assert.deepEqual(
    sent.map(([, m]) => m.kind),
    ['approach', 'dispatched'],
  );
  await around('c1', 'input.move', { x: 11, y: 21 }, async () => 'ok');
  assert.equal(sent.at(-1)![1].kind, 'dispatched');
  assert.equal(sent.at(-2)![1].press, false);
});

test('cursorAround: Stop, an abort or a turn’s end while the cursor travels sends nothing to the Host; a takeover refuses the input', async () => {
  const { cursor } = rig();
  let ran = 0;
  // Stop arrives during the approach
  const stopping = cursorAround(
    cursor,
    'h1',
    async () => cursor.hide('c1'),
    () => false,
  );
  await assert.rejects(
    stopping('c1', 'input.click', { x: 1, y: 1 }, async () => void ran++),
    (e: any) => e.code === 'aborted',
  );
  assert.equal(ran, 0, 'nothing went to the Host');
  // a newer action replaced it: the old one does not go
  const replaced = cursorAround(
    cursor,
    'h1',
    async () => void cursor.approach('h1', 'c1', { x: 9, y: 9 }, true),
    () => false,
  );
  await assert.rejects(
    replaced('c1', 'input.click', { x: 1, y: 1 }, async () => void ran++),
    (e: any) => e.code === 'aborted',
  );
  assert.equal(ran, 0);
  // the user took over
  let taken = false;
  const driven = cursorAround(
    cursor,
    'h1',
    async () => void (taken = true),
    () => taken,
  );
  await assert.rejects(
    driven('c1', 'input.click', { x: 1, y: 1 }, async () => void ran++),
    (e: any) => e.code === 'user_took_over',
  );
  assert.equal(ran, 0);
});

test('cursorAround: a failing call takes the cursor away and rethrows; a cursor that breaks never stops the call', async () => {
  const { cursor, sent } = rig();
  const around = cursorAround(
    cursor,
    'h1',
    async () => undefined,
    () => false,
  );
  await assert.rejects(
    around('c1', 'input.click', { x: 1, y: 1 }, async () => Promise.reject(Object.assign(new Error('no'), { code: 'busy' }))),
    (e: any) => e.code === 'busy',
  );
  assert.equal(sent.at(-1)![1].kind, 'hide');
  // a point that is not one: no cursor, the call runs
  assert.equal(await around('c1', 'input.click', {}, async () => 'ran'), 'ran');
  const broken = cursorAround(
    {
      ...cursor,
      approach: () => {
        throw new Error('boom');
      },
    },
    'h1',
    async () => undefined,
    () => false,
  );
  assert.equal(await broken('c1', 'input.click', { x: 1, y: 1 }, async () => 'ran'), 'ran');
});

test('drawing failures after dispatch preserve successful input and never mask the Host failure', async () => {
  const cursor = createHostCursor({ emit: () => undefined });
  cursor.dispatched = () => {
    throw new Error('drawing disconnected');
  };
  cursor.failed = () => {
    throw new Error('drawing disconnected during cleanup');
  };
  const around = cursorAround(
    cursor,
    'h1',
    async () => undefined,
    () => false,
  );
  const result = { ok: true };
  let inputs = 0;
  assert.equal(
    await around('c1', 'input.click', { x: 2, y: 3 }, async () => {
      inputs++;
      return result;
    }),
    result,
  );
  assert.equal(inputs, 1);
  const failure = new Error('the Host refused input');
  await assert.rejects(
    around('c1', 'input.click', { x: 4, y: 5 }, async () => {
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
});

test('a pane that cannot receive hide notifications never prevents retiring every action on a lost Host', () => {
  const cursor = createHostCursor({
    emit: (_chat: string, message: any) => {
      if (message.kind === 'hide') throw new Error('pane gone');
    },
  });
  const a = cursor.approach('h1', 'a', { x: 1, y: 1 }, true)!;
  const b = cursor.approach('h1', 'b', { x: 2, y: 2 }, true)!;
  const other = cursor.approach('h2', 'c', { x: 3, y: 3 }, true)!;
  assert.doesNotThrow(() => cursor.hideHost('h1'));
  assert.equal(cursor.isCurrent('a', a.id), false);
  assert.equal(cursor.isCurrent('b', b.id), false);
  assert.equal(cursor.isCurrent('c', other.id), true);
  assert.doesNotThrow(() => cursor.hide('c'));
  assert.equal(cursor.isCurrent('c', other.id), false);
});
