// An agent acts on a page at its layout scale (#5405): a page the user pinch-zoomed is put back to 1 before the call; a page at 1 is only read; a page that can't be read is acted on as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { levelPinch } = require('../electron/capabilities/browser/pinchLevel.cjs');

function fakeTab(scale: unknown, fail?: string) {
  const sent: string[] = [];
  return {
    sent,
    send: async (method: string) => {
      sent.push(method);
      if (method === fail) throw new Error('no such method');
      return method === 'Runtime.evaluate' ? { result: { value: scale } } : {};
    },
  };
}

test('a pinch-zoomed page is reset to scale 1', async () => {
  const tab = fakeTab(2.5);
  assert.equal(await levelPinch(tab), true);
  assert.deepEqual(tab.sent, ['Runtime.evaluate', 'Emulation.setPageScaleFactor']);
});

test('a page at scale 1, or one that reports none, is only read', async () => {
  for (const scale of [1, undefined]) {
    const tab = fakeTab(scale);
    assert.equal(await levelPinch(tab), false);
    assert.deepEqual(tab.sent, ['Runtime.evaluate']);
  }
});

test('a page that cannot be read, or levelled, does not fail the action', async () => {
  assert.equal(await levelPinch(fakeTab(2, 'Runtime.evaluate')), false);
  assert.equal(await levelPinch(fakeTab(2, 'Emulation.setPageScaleFactor')), false);
});
