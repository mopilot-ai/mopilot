// electron/session/turnCheckpoints.cjs when git fails at a step (fake git): every failure says why and writes nothing it can't undo; and its IPC (electron/app/ipc/checkpoints.cjs) checks its arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTurnCheckpoints } = require('../electron/session/turnCheckpoints.cjs');
const part = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 24);

/** A real folder to run in; git itself is faked in each test. */
function repo(t: any) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-fake-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir };
}

test('git failing says why: an unreadable folder, a diff, the undo ref, a restore with nothing to put back', async (t) => {
  const r = repo(t);
  const tree = { ok: true, stdout: `${'a'.repeat(40)}\n` };
  const listed = { ok: true, stdout: `refs/mopilot/checkpoints/x/t-000000000000001-${part('t')}\n` };
  const fake = (answer: (args: string[]) => { ok: boolean; stdout?: string } | null) =>
    createTurnCheckpoints({
      git: async (args: string[]) => ({ stdout: '', stderr: '', ...(answer(args) ?? { ok: true }) }),
      capture: async () => 'b'.repeat(40),
      busy: () => false,
    });
  const base = (a: string[]) =>
    a[0] === 'for-each-ref'
      ? listed
      : a[0] === 'rev-parse'
        ? a[1] === '--verify'
          ? tree
          : { ok: true, stdout: `${r.dir}\n` }
        : a[0] === 'diff-tree'
          ? { ok: true, stdout: ':100644 100644 a b M\0a.txt\0:000000 100644 0 b A\0new.txt\0' }
          : a[0] === 'write-tree'
            ? tree
            : null;
  const noRoot = fake((a) => (a[0] === 'rev-parse' && a[1] === '--show-toplevel' ? { ok: false } : base(a)));
  assert.deepEqual(await noRoot.plan('c', 't', r.dir), { ok: false, error: 'This folder’s files couldn’t be read.' });
  assert.deepEqual(await noRoot.restore('c', 't', r.dir, null), { ok: false, error: 'This folder’s files couldn’t be read.' });
  const undoId = 'u-000000000000001-aaaaaaaaaaaaaaaaaaaaaaaa';
  // a record that names no trees has nothing to undo
  assert.deepEqual(await noRoot.undo('c', r.dir, undoId), { ok: false, error: 'There is nothing to undo.' });
  const noDiff = fake((a) => (a[0] === 'diff-tree' ? { ok: false } : base(a)));
  assert.equal((await noDiff.plan('c', 't', r.dir)).ok, false);
  const noUndo = fake((a) => (a[0] === 'update-ref' ? { ok: false } : base(a)));
  assert.deepEqual(await noUndo.restore('c', 't', r.dir, null), { ok: false, error: 'The files couldn’t be kept for undo.' });
  // restore fails, and putting the files back fails too: the undo is handed back for the user
  const stuck = fake((a) => (a[0] === 'restore' ? { ok: false } : base(a)));
  const left = await stuck.restore('c', 't', r.dir, null);
  assert.equal(left.error, 'Some files couldn’t be restored.');
  assert.match(left.undo, /^u-\d{15}-/);
  // the undo record can't be made at any of its steps: nothing is written
  for (const step of ['hash-object', 'read-tree', 'write-tree'])
    assert.deepEqual(await fake((a) => (a[0] === step ? { ok: false } : base(a))).restore('c', 't', r.dir, null), {
      ok: false,
      error: 'The files couldn’t be kept for undo.',
    });
  assert.equal(
    (await fake((a) => (a[0] === 'write-tree' ? { ok: true, stdout: 'nope' } : base(a))).restore('c', 't', r.dir, null)).ok,
    false,
  );
  // a checkpoint ref listed but not resolving is no checkpoint
  assert.deepEqual(await fake((a) => (a[0] === 'rev-parse' && a[1] === '--verify' ? { ok: false } : base(a))).plan('c', 't', r.dir), {
    ok: true,
    none: 'checkpoint',
  });
  const blank = fake((a) => (a[0] === 'diff-tree' ? { ok: true, stdout: ':x\0\0' } : base(a)));
  assert.deepEqual(await blank.plan('c', 't', r.dir), { ok: true, files: [] });
});

test('the IPC checks its arguments and asks main’s checkpoints, or says they are not ready yet', async () => {
  const { register } = require('../electron/app/ipc/checkpoints.cjs');
  const handlers = new Map<string, (...a: any[]) => any>();
  const live: any = {};
  register({ handle: (name: string, fn: (...a: any[]) => any) => handlers.set(name, fn) }, { live });
  const call = (name: string, ...a: unknown[]) => handlers.get(name)!({}, ...a);
  const invalid = { ok: false, error: 'Invalid rewind request.' };
  for (const bad of [
    [1, 't', '/w'],
    ['c', '', '/w'],
    ['c', 't', 'rel'],
    ['c', 'x'.repeat(600), '/w'],
  ]) {
    assert.deepEqual(await call('checkpoints:plan', ...bad), invalid);
    assert.deepEqual(await call('checkpoints:restore', ...bad, []), invalid);
  }
  for (const files of [null, ['/abs'], [''], 'a']) assert.deepEqual(await call('checkpoints:restore', 'c', 't', '/w', files), invalid);
  assert.deepEqual(await call('checkpoints:undo', 'c', 'rel', 'u'), invalid);
  assert.deepEqual(await call('checkpoints:undo', 'c', '/w', ''), invalid);
  const notReady = { ok: false, error: 'Checkpoints are not ready yet. Try again in a moment.' };
  assert.deepEqual(await call('checkpoints:plan', 'c', 't', '/w'), notReady);
  assert.deepEqual(await call('checkpoints:restore', 'c', 't', '/w', ['a']), notReady);
  assert.deepEqual(await call('checkpoints:undo', 'c', '/w', 'u'), notReady);
  live.codex = {
    turnChanges: {
      checkpoints: {
        plan: async (...a: unknown[]) => ['plan', ...a],
        restore: async (...a: unknown[]) => ['restore', ...a],
        undo: async (...a: unknown[]) => ['undo', ...a],
      },
    },
  };
  assert.deepEqual(await call('checkpoints:plan', 'c', 't', '/w'), ['plan', 'c', 't', '/w']);
  assert.deepEqual(await call('checkpoints:restore', 'c', 't', '/w', ['a']), ['restore', 'c', 't', '/w', ['a']]);
  assert.deepEqual(await call('checkpoints:undo', 'c', '/w', 'u'), ['undo', 'c', '/w', 'u']);
});

test('an undo whose record is bad, whose folder can’t be read, with many edits since, or whose files can’t be written says why', async (t) => {
  const r = repo(t);
  const sha = 'a'.repeat(40);
  const id = 'u-000000000000001-aaaaaaaaaaaaaaaaaaaaaaaa';
  const many = Array.from({ length: 7 }, (_, i) => `:100644 100644 a b M\0f${i}\0`).join('');
  const paths = `${Array.from({ length: 7 }, (_, i) => `f${i}`).join('\0')}\0x\0`;
  const fake = (o: { paths?: string | null; diffs?: (string | null)[]; restore?: boolean }) => {
    let diff = 0;
    return createTurnCheckpoints({
      git: async (a: string[]) => {
        const out = (x: object) => ({ stdout: '', stderr: '', ...x });
        if (a[0] === 'rev-parse') return out(a[1] === '--verify' ? { ok: true, stdout: `${sha}\n` } : { ok: true, stdout: `${r.dir}\n` });
        if (a[0] === 'cat-file')
          return out(
            o.paths === null
              ? { ok: false }
              : { ok: true, stdout: a[2].endsWith(':record') ? `before ${sha}\ntarget ${sha}\n` : (o.paths ?? paths) },
          );
        if (a[0] === 'diff-tree') {
          const d = o.diffs?.[diff++];
          return out(d === null ? { ok: false } : { ok: true, stdout: d ?? '' });
        }
        if (a[0] === 'restore') return out({ ok: o.restore !== false });
        return out({ ok: true });
      },
      capture: async () => 'b'.repeat(40),
      busy: () => false,
    });
  };
  const warn = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await fake({ paths: null }).undo('c', r.dir, id), { ok: false, error: 'There is nothing to undo.' });
  assert.deepEqual(await fake({ diffs: [null, ''] }).undo('c', r.dir, id), { ok: false, error: 'This folder’s files couldn’t be read.' });
  assert.deepEqual(await fake({ diffs: ['', null] }).undo('c', r.dir, id), { ok: false, error: 'This folder’s files couldn’t be read.' });
  // differs from what the restore wrote and from what was there before: edited since
  assert.deepEqual(await fake({ diffs: [many, many] }).undo('c', r.dir, id), {
    ok: false,
    error: 'Changed since the restore, so not undone: f0, f1, f2, f3, f4….',
  });
  // differs from what it wrote but is as it was before (a part-way restore never wrote it): undone already, not refused
  assert.deepEqual(await fake({ diffs: [many, ''] }).undo('c', r.dir, id), { ok: true, restored: 0 });
  assert.deepEqual(await fake({ diffs: ['', ':100644 100644 a b M\0x\0'], restore: false }).undo('c', r.dir, id), {
    ok: false,
    error: 'Some files couldn’t be put back.',
  });
  assert.deepEqual(await fake({ diffs: ['', ':100644 100644 a b M\0x\0'] }).undo('c', r.dir, id), { ok: true, restored: 1 });
  // a folder that is gone, outside any repository, queues under its own name
  const gone = createTurnCheckpoints({
    git: async () => ({ ok: false, stdout: '', stderr: '' }),
    capture: async () => '',
    busy: () => false,
  });
  assert.deepEqual(await gone.undo('c', path.join(r.dir, 'gone-folder'), id), { ok: false, error: 'There is nothing to undo.' });
  // a snapshot that throws fails that restore only: the next one in the queue still runs
  const listed = { ok: true, stdout: `refs/mopilot/checkpoints/x/t-000000000000001-${part('t')}\n`, stderr: '' };
  const throwing = createTurnCheckpoints({
    git: async (a: string[]) =>
      a[0] === 'for-each-ref' ? listed : { ok: true, stdout: a[1] === '--verify' ? `${sha}\n` : `${r.dir}\n`, stderr: '' },
    capture: () => Promise.reject(new Error('snapshot timed out')),
    busy: () => false,
  });
  await assert.rejects(throwing.restore('c', 't', r.dir, null), /snapshot timed out/);
  await assert.rejects(throwing.restore('c', 't', r.dir, null), /snapshot timed out/);
  void warn;
});
