// Agent control must preserve a browser page's natural viewport until an explicit device resize.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drive, flush, setup, tabOf } from './support/browser-host-kit.ts';

export const GUARDS = ['electron/capabilities/'];

test('a narrow page keeps its viewport across agent reads, input, takeover, handoff and turn end', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ cssLayoutViewport: { clientWidth: 480, clientHeight: 600 } });
  const sizes = () => tab.wc.debugger.calls.filter((c: any) => /Emulation\.(set|clear)DeviceMetricsOverride/.test(c.method));
  await drive(
    t,
    h.tabs.run(tab, () => h.tabs.ready(tab, 'c')),
  );
  assert.deepEqual(sizes(), [], 'reading a narrow page must not shrink its text');
  await drive(t, h.tabs.click(tab, { x: 200, y: 100 }));
  const press = tab.wc.debugger.sent('Input.dispatchMouseEvent').find((c: any) => c.params.type === 'mousePressed');
  assert.equal(press.params.x, 200);
  assert.equal(press.params.y, 100);
  h.tabs.takeOver('c', tab.id, true);
  await flush();
  h.tabs.takeOver('c', tab.id, false);
  await drive(
    t,
    h.tabs.run(tab, () => h.tabs.ready(tab, 'c')),
  );
  h.tabs.requestSignin(tab, { reason: 'Continue in this tab' });
  await flush();
  await h.tabs.signinDone('c', tab.id);
  await drive(
    t,
    h.tabs.run(tab, () => h.tabs.ready(tab, 'c')),
  );
  await drive(t, h.tabs.turnEnded('c'));
  await drive(
    t,
    h.tabs.run(tab, () => h.tabs.ready(tab, 'c')),
  );
  assert.deepEqual(sizes(), [], 'control lifecycle must not change the viewport');
});

test('explicit device emulation survives reads and desktop restores only the native viewport', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ cssLayoutViewport: { clientWidth: 480, clientHeight: 600 } });
  await drive(t, tab.attach());
  await drive(t, h.tabs.resize(tab, { preset: 'mobile' }));
  const commands = () => tab.wc.debugger.sent('Emulation.setDeviceMetricsOverride');
  assert.equal(commands().length, 1);
  await drive(
    t,
    h.tabs.run(tab, () => h.tabs.ready(tab, 'c')),
  );
  assert.equal(commands().length, 1, 'reading must retain the explicitly chosen device');
  assert.equal(tab.emulated.preset, 'mobile');
  assert.equal(
    await drive(t, h.tabs.resize(tab, { preset: 'desktop' })),
    "Cleared the device emulation: the page has the pane's own size, pixel ratio, input and user agent again.",
  );
  assert.equal(tab.emulated, null);
  assert.equal(tab.wc.debugger.sent('Emulation.clearDeviceMetricsOverride').length, 1);
  assert.equal(commands().length, 1, 'desktop reset must not replace one override with an implicit desktop fit');
});

test('all pointer actions use unscaled page CSS coordinates in a narrow viewport', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ cssLayoutViewport: { clientWidth: 480, clientHeight: 600 } });
  await drive(
    t,
    h.tabs.run(tab, () => h.tabs.ready(tab, 'c')),
  );
  await drive(t, h.tabs.hover(tab, { x: 10, y: 20 }));
  await drive(t, h.tabs.scroll(tab, { x: 100, y: 150 }, 'down'));
  await drive(t, h.tabs.wheel(tab, { x: 200, y: 40 }, 0, 50));
  await drive(t, h.tabs.drag(tab, { x: 24, y: 12 }, { x: 264, y: 132 }));
  const mouse = tab.wc.debugger.sent('Input.dispatchMouseEvent').map((c: any) => [c.params.type, c.params.x, c.params.y]);
  assert.deepEqual(mouse.slice(0, 5), [
    ['mouseMoved', 10, 20],
    ['mouseWheel', 100, 150],
    ['mouseWheel', 200, 40],
    ['mouseMoved', 24, 12],
    ['mousePressed', 24, 12],
  ]);
  assert.deepEqual(mouse[5], ['mouseMoved', 44, 22]);
  assert.deepEqual(mouse.at(-1), ['mouseReleased', 264, 132]);
});
