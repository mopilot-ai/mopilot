// Claude Design's sign-in (electron/harness/claude/designLogin.cjs): `claude design-login --json` driven as its host, with a
// fake CLI process: the page it opens, a pasted code, how a run ends (done, exit, cancel, deadline) and one run at a time.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createDesignLogin, DEADLINE_MS } = require('../electron/harness/claude/designLogin.cjs');
const { JsonReader } = require('../electron/transport/jsonReader.cjs');

/** A pipe that decodes like a real one once setEncoding was called (a StringDecoder across chunks). */
class FakePipe extends EventEmitter {
  decoder: StringDecoder | null = null;
  setEncoding(enc: BufferEncoding) {
    this.decoder = new StringDecoder(enc);
  }
  override emit(name: string, d?: any) {
    return super.emit(name, this.decoder && Buffer.isBuffer(d) ? this.decoder.write(d) : d);
  }
}

class FakeProc extends EventEmitter {
  stdout = new FakePipe();
  stderr = new FakePipe();
  written: string[] = [];
  ended = false;
  stdin = Object.assign(new EventEmitter(), {
    write: (s: string) => this.written.push(s),
    end: () => (this.ended = true),
  });
  /** the CLI prints these lines, split anywhere */
  print(...lines: (object | string)[]) {
    const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
    const cut = Math.floor(text.length / 2);
    this.stdout.emit('data', Buffer.from(text.slice(0, cut)));
    this.stdout.emit('data', Buffer.from(text.slice(cut)));
  }
}

function setup(
  o: {
    findBinary?: (b?: string | null) => Promise<string | null> | string | null;
    spawn?: (...a: any[]) => any;
    open?: (u: string) => unknown;
    deadlineMs?: number;
  } = {},
) {
  const events: any[] = [];
  const opened: string[] = [];
  const spawned: any[][] = [];
  const killed: FakeProc[] = [];
  const procs: FakeProc[] = [];
  const login = createDesignLogin({
    findBinary: o.findBinary ?? ((b?: string | null) => b ?? '/bin/claude'),
    cleanEnv: (account?: string) => ({ CLAUDE_CONFIG_DIR: `/cfg/${account ?? 'default'}` }),
    openExternal: o.open ?? ((u: string) => opened.push(u)),
    broadcast: (e: any) => events.push(e),
    spawn:
      o.spawn ??
      ((...a: any[]) => {
        spawned.push(a);
        const p = new FakeProc();
        procs.push(p);
        return p;
      }),
    spawnArgs: (file: string, args: string[], opts: any) => [file, args, opts],
    killTree: (p: FakeProc | null) => p && killed.push(p),
    deadlineMs: o.deadlineMs ?? DEADLINE_MS,
  });
  return { login, events, opened, spawned, killed, procs };
}

const pages = {
  event: 'pages',
  url: 'https://claude.ai/oauth/authorize?a=1',
  manual_url: 'https://claude.ai/oauth/authorize?m=1',
  manual_first: false,
};

test('a transport failure ends sign-in, reports its error and lets the next run start', async () => {
  const t = setup();
  await t.login.start('failed');
  // a stream the core can't frame fails the sign-in through the reader's owner callback
  const failing = mock.method(JsonReader.prototype, 'frame', () => {
    throw new Error('the core could not frame it');
  });
  try {
    t.procs[0].stdout.emit('data', Buffer.from('{}\n'));
  } finally {
    failing.mock.restore();
  }
  assert.match(t.events.at(-1).message, /sign-in connection failed: the core could not frame it/);
  assert.equal(t.events.at(-1).ok, false);
  assert.equal(t.killed.includes(t.procs[0]), true);
  await t.login.start('replacement');
  t.procs[1].print({ event: 'done', ok: true });
  assert.deepEqual(t.events.at(-1), { id: 'replacement', kind: 'done', ok: true });
});

test('a sign-in runs design-login --json on the account, opens the page and ends with done', async () => {
  const t = setup();
  await t.login.start('r1', '/my/claude', 'work');
  assert.deepEqual(t.spawned[0][0], '/my/claude');
  assert.deepEqual(t.spawned[0][1], ['design-login', '--json']);
  assert.deepEqual(t.spawned[0][2].env, { CLAUDE_CONFIG_DIR: '/cfg/work' });
  assert.deepEqual(t.spawned[0][2].stdio, ['pipe', 'pipe', 'pipe']);
  const p = t.procs[0];
  p.print('a log line', pages);
  await tick();
  assert.deepEqual(t.opened, [pages.url]);
  assert.deepEqual(t.events, [{ id: 'r1', kind: 'pages', url: pages.url, manualUrl: pages.manual_url, manualFirst: false }]);
  // stdin stays open while it waits (closing it would cancel the sign-in)
  assert.equal(p.ended, false);
  p.print({ event: 'done', ok: true });
  assert.equal(p.ended, true);
  assert.deepEqual(t.events.at(-1), { id: 'r1', kind: 'done', ok: true });
  // the exit after done says nothing more
  p.emit('close', 0);
  assert.equal(t.events.length, 2);
  // a later pages line from an ended run is not shown
  p.print(pages);
  assert.equal(t.events.length, 2);
});

test('a remote session opens the code page first; only https pages are opened or shown', async () => {
  const t = setup();
  await t.login.start('r1', null, null);
  assert.deepEqual(t.spawned[0][2].env, { CLAUDE_CONFIG_DIR: '/cfg/default' });
  t.procs[0].print({ ...pages, manual_first: true });
  await tick();
  assert.deepEqual(t.opened, [pages.manual_url]);
  assert.equal(t.events[0].manualFirst, true);
  const u = setup();
  await u.login.start('r2', null, null);
  u.procs[0].print({ event: 'pages', url: 'file:///etc/passwd', manual_url: 7, manual_first: 'yes' });
  await tick();
  assert.deepEqual(u.opened, []);
  assert.deepEqual(u.events, [{ id: 'r2', kind: 'pages', url: null, manualUrl: null, manualFirst: false }]);
  // another event the CLI may add later is ignored
  u.procs[0].print({ event: 'progress' });
  assert.equal(u.events.length, 1);
});

test('a page that fails to open is only noted: the window still offers it', async () => {
  const t = setup({
    open: () => {
      throw new Error('no opener');
    },
  });
  await t.login.start('r1', null, null);
  t.procs[0].print(pages);
  await tick();
  assert.equal(t.events[0].kind, 'pages');
});

test('a pasted code goes to the CLI as a JSON line; codes for an ended or other run are refused', async () => {
  const t = setup();
  await t.login.start('r1', null, null);
  const p = t.procs[0];
  assert.equal(t.login.code('r1', '  abc#state  '), true);
  assert.deepEqual(p.written, ['{"code":"abc#state"}\n']);
  assert.equal(t.login.code('other', 'abc'), false);
  assert.equal(t.login.code('r1', '   '), false);
  assert.equal(t.login.code('r1', 42), false);
  // a write after the CLI went away is noted, not thrown
  p.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  p.print({ event: 'done', ok: false, message: 'The sign-in did not return a usable credential. Try again.' });
  assert.deepEqual(t.events.at(-1), {
    id: 'r1',
    kind: 'done',
    ok: false,
    message: 'The sign-in did not return a usable credential. Try again.',
  });
  assert.equal(t.login.code('r1', 'abc'), false);
});

test('a run that exits without done says why: its stderr, else the exit code', async () => {
  const t = setup();
  await t.login.start('r1', null, null);
  t.procs[0].stderr.emit('data', Buffer.from('claude design-login --json cannot run here\n'));
  t.procs[0].emit('close', 1);
  assert.deepEqual(t.events, [{ id: 'r1', kind: 'done', ok: false, message: 'claude design-login --json cannot run here' }]);
  await t.login.start('r2', null, null);
  t.procs[1].emit('close', 2);
  assert.deepEqual(t.events.at(-1), {
    id: 'r2',
    kind: 'done',
    ok: false,
    message: 'Claude Code exited (code 2) before the sign-in finished.',
  });
  // a done without a message, or with ok other than true
  await t.login.start('r3', null, null);
  t.procs[2].print({ event: 'done', ok: 'yes', message: 3 });
  assert.deepEqual(t.events.at(-1), { id: 'r3', kind: 'done', ok: false });
});

test('a CLI that cannot start ends the run at once', async () => {
  const t = setup({
    spawn: () => {
      throw new Error('spawn EACCES');
    },
  });
  await t.login.start('r1', null, null);
  assert.deepEqual(t.events, [{ id: 'r1', kind: 'done', ok: false, message: "Couldn't start Claude Code: spawn EACCES" }]);
  // nothing is left running to cancel
  t.login.cancelAll();
  const u = setup();
  await u.login.start('r2', null, null);
  u.procs[0].emit('error', new Error('spawn ENOENT'));
  assert.deepEqual(u.events, [{ id: 'r2', kind: 'done', ok: false, message: "Couldn't start Claude Code: spawn ENOENT" }]);
  const w = setup({
    spawn: () => {
      throw 'odd';
    },
  });
  await w.login.start('r3', null, null);
  assert.equal(w.events[0].message, "Couldn't start Claude Code: odd");
  const v = setup();
  await v.login.start('r4', null, null);
  v.procs[0].emit('error', 'odd');
  assert.equal(v.events[0].message, "Couldn't start Claude Code: odd");
});

test('a missing CLI or id is refused before anything runs', async () => {
  const t = setup({ findBinary: () => null });
  await assert.rejects(t.login.start('r1', null, null), /not installed/);
  await assert.rejects(t.login.start('', null, null), /needs an id/);
  await assert.rejects(t.login.start(undefined, null, null), /needs an id/);
  assert.equal(t.spawned.length, 0);
});

test('cancel stops only the run it names; the exit then says it was cancelled', async () => {
  const t = setup();
  await t.login.start('r1', null, null);
  t.login.cancel('other');
  assert.deepEqual(t.killed, []);
  t.login.cancel('r1');
  assert.deepEqual(t.killed, [t.procs[0]]);
  t.procs[0].emit('close', null);
  assert.deepEqual(t.events, [{ id: 'r1', kind: 'done', ok: false, message: 'The sign-in was cancelled.' }]);
  // an ended run is left alone
  t.login.cancel('r1');
  assert.equal(t.killed.length, 1);
});

test('one sign-in at a time: a new one stops the one still waiting, whose end keeps its own id', async () => {
  const t = setup();
  await t.login.start('r1', null, null);
  await t.login.start('r2', null, null);
  assert.deepEqual(t.killed, [t.procs[0]]);
  t.procs[0].emit('close', null);
  assert.deepEqual(t.events, [{ id: 'r1', kind: 'done', ok: false, message: 'The sign-in was cancelled.' }]);
  // the new run is still current: its code goes through
  assert.equal(t.login.code('r2', 'abc'), true);
  assert.equal(t.login.code('r1', 'abc'), false);
  t.login.cancelAll();
  assert.deepEqual(t.killed, [t.procs[0], t.procs[1]]);
});

test('a run that never says done is stopped at the deadline', async () => {
  const t = setup({ deadlineMs: 5 });
  await t.login.start('r1', null, null);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(t.killed, [t.procs[0]]);
  assert.deepEqual(t.events, [{ id: 'r1', kind: 'done', ok: false, message: 'The sign-in timed out. Try again.' }]);
  t.procs[0].emit('close', null);
  assert.equal(t.events.length, 1);
});

test('a character split across two chunks reaches the window whole', async () => {
  const t = setup();
  await t.login.start('r1', null, null);
  const line = Buffer.from(`${JSON.stringify({ event: 'done', ok: false, message: 'Sign-in failed — retry' })}\n`);
  const at = line.indexOf(Buffer.from('—')) + 1;
  t.procs[0].stdout.emit('data', line.subarray(0, at));
  t.procs[0].stdout.emit('data', line.subarray(at));
  assert.deepEqual(t.events, [{ id: 'r1', kind: 'done', ok: false, message: 'Sign-in failed — retry' }]);
});

test('a sign-in cancelled or replaced while its CLI is found never starts, and its window hears it ended', async () => {
  const found: ((file: string | null) => void)[] = [];
  const t = setup({ findBinary: () => new Promise((r) => found.push(r)) });
  const cancelled = (id: string) => ({ id, kind: 'done', ok: false, message: 'The sign-in was cancelled.' });
  // the window closes its sign-in first
  const a = t.login.start('r1', null, null);
  t.login.cancel('r1');
  found[0]('/bin/claude');
  await a;
  assert.equal(t.spawned.length, 0);
  assert.deepEqual(t.events, [cancelled('r1')]);
  // another window's start takes the place of one still looking
  const b = t.login.start('r2', null, null);
  const c = t.login.start('r3', null, null);
  assert.deepEqual(t.events.at(-1), cancelled('r2'));
  found[2]('/bin/claude');
  found[1]('/bin/claude');
  await Promise.all([b, c]);
  assert.equal(t.spawned.length, 1);
  assert.equal(t.spawned[0][0], '/bin/claude');
  // the same window starting again hears nothing about the start it replaced
  const events = t.events.length;
  const d = t.login.start('r3', null, null);
  const e = t.login.start('r3', '/other/claude', null);
  found[3]('/bin/claude');
  found[4]('/other/claude');
  await Promise.all([d, e]);
  assert.equal(t.spawned.length, 2);
  assert.equal(t.spawned[1][0], '/other/claude');
  assert.deepEqual(t.events.slice(events), []);
  // the run it had going is stopped as before (its exit says it ended)
  assert.deepEqual(t.killed, [t.procs[0]]);
  // quitting while one looks
  const f = t.login.start('r4', null, null);
  t.login.cancelAll();
  found[5]('/bin/claude');
  await f;
  assert.equal(t.spawned.length, 2);
  // a cancel for another window leaves it looking
  const g = t.login.start('r5', null, null);
  t.login.cancel('r6');
  found[6](null);
  await assert.rejects(g, /not installed/);
});

test('a CLI lookup that fails reaches the caller and leaves nothing waiting', async () => {
  const t = setup({ findBinary: () => Promise.reject(new Error('probe failed')) });
  await assert.rejects(t.login.start('r1', null, null), /probe failed/);
  t.login.cancel('r1');
  assert.deepEqual(t.events, []);
});

test('a lookup that fails after its start was replaced tells its window nothing more', async () => {
  const found: { resolve: (f: string) => void; reject: (e: Error) => void }[] = [];
  const t = setup({ findBinary: () => new Promise((resolve, reject) => found.push({ resolve, reject })) });
  const a = t.login.start('r1', null, null);
  const b = t.login.start('r2', null, null);
  found[0].reject(new Error('probe failed'));
  assert.equal(await a, undefined);
  found[1].resolve('/bin/claude');
  await b;
  assert.deepEqual(
    t.events.map((e: any) => [e.id, e.kind, e.message]),
    [['r1', 'done', 'The sign-in was cancelled.']],
  );
  assert.equal(t.spawned.length, 1);
});
