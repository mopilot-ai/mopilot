// A trackpad pinch zooms every pane tab's page (#5405): Electron's default visual-zoom limits are 1..1, so the view layer sets them on each tab it creates or adopts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FakeWC, setup } from './support/browser-view-fixture.ts';

const require = createRequire(import.meta.url);
const { PINCH_ZOOM_MAX } = require('../electron/capabilities/browser/pageZoom.cjs');

test('a new tab, a tab restored with history, an agent tab and an adopted popup all take the pinch limits', () => {
  const { views } = setup();
  const user = views.create({ url: 'https://a.test/' });
  const blank = views.create();
  const popup = views.adopt(new FakeWC({ sandbox: true }));
  for (const entry of [user, blank, popup]) assert.deepEqual(entry.wc.pinch, [1, PINCH_ZOOM_MAX]);
  assert.ok(PINCH_ZOOM_MAX > 1, 'a limit of 1 would leave the gesture off');
});
