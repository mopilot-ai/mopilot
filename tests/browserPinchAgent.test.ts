// What an agent call does to a page the user pinch-zoomed (#5405): reads leave the zoom alone; pointer input and the screenshot frame (ready with input) put the page back to scale 1, once, so layout coordinates land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

/** A tab whose page reports a visual-viewport `scale`, as a user's pinch leaves it. */
function zoomed(h: any, scale: number) {
  const tab = tabOf(h);
  tab.wc.ops.state = () => ({ w: 800, h: 600, dpr: 2, sx: 0, sy: 0, visibility: 'visible', quietMs: 1000 });
  const base = tab.wc.cdp.bind(tab.wc);
  tab.wc.cdp = (method: string, params: any, sessionId?: string) =>
    method === 'Runtime.evaluate' && String(params.expression).includes('visualViewport')
      ? { result: { value: scale } }
      : base(method, params, sessionId);
  return tab;
}

const resets = (tab: any) => tab.wc.debugger.sent('Emulation.setPageScaleFactor');

test('a read call (no input) leaves the user’s pinch zoom alone, without even reading it', async (t) => {
  const h = setup(t);
  const tab = zoomed(h, 3);
  await drive(t, h.tabs.ready(tab, 'c'));
  assert.equal(resets(tab).length, 0);
  assert.equal(
    tab.wc.debugger.sent('Runtime.evaluate').filter((c: any) => String(c.params.expression).includes('visualViewport')).length,
    0,
  );
});

test('pointer input on a pinch-zoomed page puts it back to scale 1 first', async (t) => {
  const h = setup(t);
  const tab = zoomed(h, 3);
  await drive(t, h.tabs.ready(tab, 'c', { input: true }));
  assert.deepEqual(
    resets(tab).map((c: any) => c.params),
    [{ pageScaleFactor: 1 }],
  );
});

test('pointer input on a page at scale 1 sends no reset', async (t) => {
  const h = setup(t);
  const tab = zoomed(h, 1);
  await drive(t, h.tabs.ready(tab, 'c', { input: true }));
  assert.equal(resets(tab).length, 0);
});
