// The audit hash chain (shared/host/audit.mjs, host/src/audit.mjs, plan W3): a removed or edited line is detected, a corrupt day file keeps its earlier lines and starts a marked segment, and `audit export --verify` says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAudit } from '../host/src/audit.mjs';
// @ts-ignore: plain ESM without declarations
import { auditCommand } from '../host/src/auditExport.mjs';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
// @ts-ignore: plain ESM without declarations
import { verifyChain } from '../shared/host/audit.mjs';

const T0 = Date.parse('2026-11-10T12:00:00Z');
const world = (t: any, n = 4) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-chain-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'audit');
  const audit = createAudit({ dir, now: () => T0 });
  for (let i = 0; i < n; i++) audit.note({ kind: 'chat.message', chat: `c${i}` });
  const file = path.join(dir, '2026-11-10.jsonl');
  return {
    base,
    dir,
    file,
    audit,
    lines: () => fs.readFileSync(file, 'utf8').trim().split('\n'),
  };
};

test('an untouched record verifies', (t) => {
  assert.deepEqual(verifyChain(world(t).lines()), { ok: true, brokenAt: null });
  assert.deepEqual(verifyChain([]), { ok: true, brokenAt: null });
});

test('a removed line breaks the chain at the line after it', (t) => {
  const w = world(t);
  const l = w.lines();
  assert.deepEqual(verifyChain([l[0], l[2], l[3]]), { ok: false, brokenAt: 1 });
});

test('an edited line breaks the chain at its successor, and an unreadable line breaks it there', (t) => {
  const w = world(t);
  const l = w.lines();
  const edited = JSON.stringify({ ...JSON.parse(l[1]), chat: 'someone else' });
  assert.deepEqual(verifyChain([l[0], edited, l[2]]), {
    ok: false,
    brokenAt: 2,
  });
  assert.deepEqual(verifyChain([l[0], 'not json']), { ok: false, brokenAt: 1 });
});

test('a corrupt last line keeps the earlier lines and the next line starts a marked segment', (t) => {
  const w = world(t);
  fs.appendFileSync(w.file, '{"seq":5,"kind"');
  const again = createAudit({ dir: w.dir, now: () => T0 });
  again.note({ kind: 'chat.message' });
  const lines = w.lines();
  assert.equal(JSON.parse(lines.at(-1)!).segment, 'recovered');
  assert.equal(JSON.parse(lines.at(-1)!).prev, null);
  assert.equal(JSON.parse(lines.at(-1)!).seq, 5);
  assert.equal(again.read().lines.length, 5);
  assert.equal(verifyChain(lines).ok, false, 'the gap is visible, never hidden');
  assert.equal(verifyChain(lines.slice(-1)).ok, true);
});

test('a corrupt line among others does not reset the sequence', (t) => {
  const w = world(t, 2);
  fs.appendFileSync(w.file, 'x\n{"seq":9');
  const again = createAudit({ dir: w.dir, now: () => T0 });
  again.note({ kind: 'chat.message' });
  assert.equal(again.read().lines.at(-1).seq, 3);
});

test('a day file with no lines is skipped when the chain resumes', (t) => {
  const w = world(t, 2);
  fs.writeFileSync(path.join(w.dir, '2026-11-11.jsonl'), '');
  const again = createAudit({ dir: w.dir, now: () => T0 });
  again.note({ kind: 'chat.message' });
  assert.equal(again.read().lines.at(-1).seq, 3);
});

test('audit export prints the lines; --since and --verify; bad usage is refused', (t) => {
  const w = world(t);
  const out: string[] = [];
  const err: string[] = [];
  const run = (argv: string[]) =>
    auditCommand({
      dataDir: w.base,
      argv,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
    });
  assert.equal(run(['audit', 'export']), 0);
  assert.equal(out.length, 4);
  out.length = 0;
  assert.equal(run(['audit', 'export', '--since', '2026-11-11']), 0);
  assert.equal(out.length, 0);
  assert.equal(run(['audit', 'export', '--verify']), 0);
  assert.match(out[0], /chain holds for 4/);
  const l = w.lines();
  fs.writeFileSync(w.file, `${[l[0], l[2], l[3]].join('\n')}\n`);
  assert.equal(run(['audit', 'export', '--verify']), 2);
  assert.match(out.at(-1)!, /breaks at line 1/);
  assert.equal(run(['audit']), 1);
  assert.match(err.at(-1)!, /Usage/);
  assert.equal(run(['audit', 'export', '--since', 'someday']), 1);
  assert.equal(run(['audit', 'export', '--since']), 1);
});

test('mopilot-host audit export reaches the audit command from the CLI entry and prints the record', async (t) => {
  const w = world(t, 2);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(['audit', 'export', '--data-dir', w.base], {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    env: {},
  });
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(out.join('\n').split('\n'), w.lines());
});
