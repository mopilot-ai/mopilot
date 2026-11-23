// The timer-window lint guard (lint/rules/timer-window.grit): a time window compared on a clock against the same named
// duration a timer in its file waits warns (#1531, CM-Z30); other windows, literals and order-based throttles do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a window compared against the duration a timer waits warns; another duration, a literal or an order-based throttle stays valid', () => {
  for (const [input, expected] of [
    // CM-Z30's throttle: the wait's timer and the window are the same connectMs
    [
      'class C { offer() { if (Date.now() - this.offered < this.connectMs) return; this.offered = Date.now(); } wait() { setTimeout(() => {}, this.connectMs); } }',
      1,
    ],
    ['const WAIT_MS = 100; let at = 0; const go = (now) => { if (now() - at >= WAIT_MS) at = now(); setTimeout(go, WAIT_MS); };', 1],
    ['class C { due() { return this.clock.now() - this.at > this.ms; } arm() { setTimeout(() => {}, this.ms); } }', 1],
    ['class C { due() { return performance.now() - this.at <= this.ms; } arm() { setTimeout(() => {}, this.ms); } }', 1],
    // injected or global timers, and a timer given arguments
    ['class C { due() { return this.now() - this.at < this.ms; } arm() { this.timers.setTimeout(() => {}, this.ms); } }', 1],
    ['const due = (at) => Date.now() - at >= WAIT_MS; globalThis.setTimeout(due, WAIT_MS, 0);', 1],
    // a window no timer waits for
    ['class C { due() { return Date.now() - this.at < this.ttlMs; } arm() { setTimeout(() => {}, this.waitMs); } }', 0],
    // equal literals are a coincidence, not one duration
    ['const due = (at) => Date.now() - at < 30 * 60_000; setTimeout(() => {}, 30 * 60_000);', 0],
    // ordered by the wait itself
    ['class C { offer(wait) { if (this.offeredBy) return; this.offeredBy = wait; } wait() { setTimeout(() => {}, this.connectMs); } }', 0],
  ] as const) {
    const report = lintFixtures({ 'electron/window.cjs': `${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[timer-window]'));
    assert.equal(hits.length, expected, input);
  }
});
