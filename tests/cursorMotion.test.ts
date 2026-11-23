// The two agent cursors, now on different models (#3810): the desktop phantom cursor (electron/capabilities/phantomCursor.cjs) plays the observed Sky approach from shared/cursorMotionPlan.mjs; the browser agent cursor (electron/capabilities/browser/agentCursorOverlay.cjs, whose overlay is serialized into the page and keeps its own copy) still glides on the older position spring until a follow-up moves it to the shared planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { OBSERVED, planApproach } from '../shared/cursorApproach.mjs';

const require = createRequire(import.meta.url);
const { approachHtml } = require('../electron/capabilities/phantomCursor.cjs');
const browser = readFileSync(new URL('../electron/capabilities/browser/agentCursorOverlay.cjs', import.meta.url), 'utf8');

test('the browser agent cursor keeps its own critically damped position spring (to be moved onto the shared planner)', () => {
  const glide = /'transform (\d+)ms (linear\(([^)]*)\)), opacity 200ms'/.exec(browser);
  assert.ok(glide, 'agentCursorOverlay.cjs GLIDE is a transform glide on a linear() spring');
  const stops = glide![3].split(',').map(Number);
  assert.equal(stops[0], 0);
  assert.equal(stops.at(-1), 1);
  assert.ok(
    stops.every((v, i) => i === 0 || v >= stops[i - 1]),
    'critically damped: it never overshoots or turns back',
  );
});

test('the phantom cursor no longer plays that spring: it plays the observed Sky approach from the shared planner', () => {
  const browserStops = /'transform \d+ms linear\(([^)]*)\), opacity 200ms'/.exec(browser)![1];
  const plan = planApproach({ from: { x: 600, y: 300 }, to: { x: 100, y: 100 } });
  const html = approachHtml({ plan, press: true });
  assert.ok(!html.includes(browserStops), 'not the 175 ms browser spring');
  assert.ok(plan.durationMs >= 250 && plan.durationMs <= 350, 'the observed 250-350 ms glide');
  assert.equal(OBSERVED.response, 0.25);
  assert.ok(html.includes(`glide ${plan.durationMs}ms linear(`));
});
