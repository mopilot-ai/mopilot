// What the audit keeps of the requests a kind of client was refused (host/src/refusalAudit.mjs): a line per method per window with a count, a bound on different methods, the rest told as one line, and a window that no refusal follows still settles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createRefusalAudit, MAX_LINES, OTHERS, WINDOW_MS } from '../host/src/refusalAudit.mjs';

const by = (n: number) => ({ fingerprint: `fp${n}`, name: `Mac ${n}`, kind: 'controller' });
const refused = (b: any, tool: string) => ({ kind: 'client.refused', by: b, what: { tool } });
const world = () => {
  let clock = 0;
  const lines: any[] = [];
  const timers: (() => void)[] = [];
  const audit = createRefusalAudit({
    write: (e: any) => lines.push(e),
    now: () => clock,
    setTimer: (fn: () => void) => (timers.push(fn), { unref: () => undefined }),
  });
  return { audit, lines, timers, tick: (ms: number) => void (clock += ms) };
};

test('one line per method per window, the repeats counted and told when the window ends', () => {
  const w = world();
  for (let i = 0; i < 500; i++) w.audit.note(refused(by(1), 'host.modelKey'));
  w.audit.note(refused(by(1), 'host.policy'));
  assert.deepEqual(
    w.lines.map((l) => l.what),
    [{ tool: 'host.modelKey' }, { tool: 'host.policy' }],
  );
  w.tick(WINDOW_MS);
  w.audit.note(refused(by(1), 'host.modelKey'));
  assert.deepEqual(
    w.lines.map((l) => l.what),
    [{ tool: 'host.modelKey' }, { tool: 'host.policy' }, { tool: 'host.modelKey', count: 499 }, { tool: 'host.modelKey' }],
  );
});

test('different methods are bounded per client, and the ones without a line are one line of counts; another client has its own window', () => {
  const w = world();
  for (let i = 0; i < 100; i++) w.audit.note(refused(by(1), `made.up.${i}`));
  assert.equal(w.lines.length, MAX_LINES);
  w.audit.note(refused(by(2), 'host.modelKey'));
  assert.equal(w.lines.length, MAX_LINES + 1);
  w.tick(WINDOW_MS + 1);
  w.audit.note(refused(by(1), 'host.modelKey'));
  const told = w.lines.slice(MAX_LINES + 1);
  assert.deepEqual(
    told.map((l) => l.what),
    [{ tool: OTHERS, count: 100 - MAX_LINES }, { tool: 'host.modelKey' }],
  );
});

test('a window that no refusal follows settles by its timer, once; a method name is cut', () => {
  const w = world();
  w.audit.note(refused(by(1), 'x'.repeat(200)));
  w.audit.note(refused(by(1), 'x'.repeat(200)));
  assert.equal(w.lines[0].what.tool.length, 64);
  assert.equal(w.timers.length, 1);
  w.timers[0]();
  assert.deepEqual(w.lines.at(-1).what, { tool: 'x'.repeat(64), count: 1 });
  const n = w.lines.length;
  w.timers[0]();
  assert.equal(w.lines.length, n, 'a window already settled does not tell twice');
  // a new refusal after the settle starts a new window with a new timer
  w.audit.note(refused(by(1), 'y'));
  assert.equal(w.timers.length, 2);
  w.tick(WINDOW_MS);
  w.audit.note(refused(by(1), 'z'));
  w.timers[1]();
  assert.equal(w.lines.filter((l) => l.what.tool === 'y').length, 1, 'the stale timer of a window that was replaced tells nothing more');
});

test('the oldest window is settled and dropped when many clients are refused at once', () => {
  const w = world();
  for (let n = 0; n < 70; n++) {
    w.audit.note(refused(by(n), 'a'));
    w.audit.note(refused(by(n), 'a'));
  }
  // the first clients were settled as the table filled: their repeats are told
  assert.ok(w.lines.some((l) => l.what.count === 1));
});

test('a refusal with no method name is a line of its own empty name, never a crash', () => {
  const w = world();
  w.audit.note({ kind: 'client.refused', by: by(1) } as any);
  assert.equal(w.lines.length, 1);
  assert.equal(w.lines[0].what.tool, '');
});

test('what a window holds is bounded whatever names a client makes up: 300,000 different methods keep eight names and one number', () => {
  const w = world();
  for (let i = 0; i < 300_000; i++) w.audit.note(refused(by(1), `made.up.${i}`));
  assert.equal(w.lines.length, MAX_LINES);
  w.tick(WINDOW_MS + 1);
  w.audit.note(refused(by(1), 'host.modelKey'));
  assert.deepEqual(
    w.lines.slice(MAX_LINES).map((l) => l.what),
    [{ tool: OTHERS, count: 300_000 - MAX_LINES }, { tool: 'host.modelKey' }],
  );
});
