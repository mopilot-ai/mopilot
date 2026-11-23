// The quadratic-lines lint guard (lint/rules/quadratic-lines.grit): a stream split by appending each chunk to one buffer
// and searching all of it for a newline warns, in a function, a method or an arrow; other searches and appends do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('appending chunks to a buffer searched for newlines warns; JsonReader and other searches stay valid', () => {
  for (const [input, expected] of [
    ["let buf = ''; s.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\\n')) >= 0) buf = buf.slice(i + 1); });", 1],
    ['class A { on(c) { this.buf += c; return this.buf.indexOf("\\n"); } }', 1],
    ["function f(d) { ctx.buf += String(d); return ctx.buf.indexOf('\\n'); }", 1],
    ["const o = { on(d) { this.b += d; return this.b.indexOf('\\n'); } };", 1],
    ['const reader = new JsonReader({ stream: s, onValue: handle, onError: fail });', 0],
    ["function g(text) { let out = ''; out += text; return text.indexOf('\\n'); }", 0],
    ["function h(s) { let x = ''; x += s; return x.indexOf(','); }", 0],
    ["function k(s) { let x = s; x = x + 'a'; return x.indexOf('\\n'); }", 0],
  ] as const) {
    // an invocation-owned Biome project, so no other test's fixture cleanup races this scan (scripts/biome-fixtures.mjs)
    const report = lintFixtures({ 'electron/lines.cjs': `${input}\n` });
    const hits = report.diagnostics.filter((d: { message: string }) => d.message.includes('[quadratic-lines]'));
    assert.equal(hits.length, expected, input);
  }
});
