// What the app sets up on a new connection to a machine (electron/host/machineWire.cjs): the hook's undo is kept, no hook is nothing, and a hook that throws leaves the connection as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createWireHost } = require('../electron/host/machineWire.cjs');

test('the hook is told the machine and its connection, and what it returns is kept', () => {
  const told: unknown[][] = [];
  const undo = () => undefined;
  const wire = createWireHost((id: string, host: unknown) => (told.push([id, host]), undo));
  assert.equal(wire('box', 'host'), undo);
  assert.deepEqual(told, [['box', 'host']]);
});

test('no hook sets up nothing, and a hook that throws is logged and leaves the connection as it is', () => {
  assert.equal(createWireHost(undefined)('box', 'host'), undefined);
  const wire = createWireHost(() => {
    throw new Error('the hook failed');
  });
  assert.equal(wire('box', 'host'), undefined);
});

test('the connection is followed first, and the watch ends with the connection, also when the hook failed or set up nothing', () => {
  const order: string[] = [];
  const follow = (id: string) => (order.push(`follow ${id}`), () => void order.push('unfollow'));
  const withHook = createWireHost(() => (order.push('hook'), () => void order.push('undo')), follow);
  withHook('box', 'host')!();
  assert.deepEqual(order, ['follow box', 'hook', 'unfollow', 'undo']);
  order.length = 0;
  const failing = createWireHost(() => {
    throw new Error('the hook failed');
  }, follow);
  failing('box', 'host')!();
  assert.deepEqual(order, ['follow box', 'unfollow'], 'a failed hook does not leave the watch running');
  order.length = 0;
  createWireHost(undefined, follow)('box', 'host')!();
  assert.deepEqual(order, ['follow box', 'unfollow']);
});
