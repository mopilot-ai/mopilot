// The segment-owner lint guard (lint/rules/segment-owner.grit): a tool call's owner checked by hand against a segment's
// id warns, in either order and either sense; the shared ownerOf, and comparisons of other ids, stay valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a hand-made owner check against a segment id warns; the shared helper and other ids stay valid', () => {
  for (const [input, expected] of [
    // the copies the shared helper replaced
    [
      'const o = (ctx) => (records.get(ctx.chatId)?.segments.some((seg) => toRendererSegment(seg).nativeId === ctx.segmentId) ? ctx.chatId : null);',
      1,
    ],
    ['function f(seg, ctx) { if (!seg || toRendererSegment(seg).nativeId !== ctx.segmentId) throw new Error("x"); }', 1],
    // the bare native id, either order
    ['const own = (s, ctx) => ctx.segmentId === s.nativeId;', 1],
    ['const own = (s, ctx) => rendererNative(s.kind, s.nativeId) !== ctx.segmentId;', 1],
    // the shared helper, and a segment id compared with another call's
    ['const owner = (ctx) => ownerOf(records, ctx);', 0],
    ['const same = (turn, ctx) => turn.segmentId !== ctx.segmentId;', 0],
    ['const same = (a, b) => a.nativeId === b.nativeId;', 0],
  ] as const) {
    const report = lintFixtures({ 'electron/owner.cjs': `${input}\n` });
    const hits = report.diagnostics.filter((d: any) => d.message.includes('[segment-owner]'));
    assert.equal(hits.length, expected, input);
  }
});
