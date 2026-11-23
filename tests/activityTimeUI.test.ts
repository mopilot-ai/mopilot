import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityTime } from '../src/components/thread/ActivityTime.tsx';

test('activity clocks show elapsed duration and keep second-by-second changes quiet for screen readers', () => {
  for (const [elapsedMs, expected] of [
    [null, '0s'],
    [Infinity, '0s'],
    [-100, '0s'],
    [18000, '18s'],
    [72000, '1m 12s'],
  ] as const) {
    const html = renderToStaticMarkup(createElement(ActivityTime, { elapsedMs }));
    assert.ok(html.includes(`>${expected}</span>`));
    assert.match(html, /role="timer"/);
    assert.match(html, /aria-live="off"/);
  }
});
