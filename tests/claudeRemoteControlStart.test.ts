// Remote Control across processes (electron/harness/claude/remoteControl.cjs): a started process reconnects what the user had
// on, the Settings switch, the end of a process, and the remembered choices file.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clearIgnored, dir, fileOf, later, link, recentIgnored, setup, tick } from './support/remote-control-kit.ts';

test('a started process reconnects what the user had on, reattaching to its bridge; a refused reattach starts a new link', async () => {
  const f = fileOf();
  const first = setup({ file: f });
  const a = first.session();
  await first.rc.set(a, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).choices, { x: { on: true, bridge: 'cse_a' } });

  // a new app run: a new process of the same session
  const next = setup({ file: f });
  const b = next.session();
  next.rc.onStart(b, { fresh: false });
  await until(() => b.rc?.phase === 'on');
  assert.deepEqual(b.q.calls, [[true, 'project', { keepSessionOnExit: true, reattachSessionId: 'cse_a' }]]);

  const c = next.session();
  let refused = true;
  c.q.answer = (_on: boolean, _t: string, o: any) => (o.reattachSessionId && refused ? Promise.reject(new Error('gone')) : link('new'));
  next.rc.onStart(c, { fresh: false });
  await until(() => c.rc?.phase === 'on');
  assert.deepEqual(
    c.q.calls.map((x: any[]) => Boolean(x[2].reattachSessionId)),
    [true, false],
  );
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).choices.x.bridge, 'cse_new');
  refused = false;
});

test('a started process links a new session only when the setting is on; an explicit off and old chats stay off', async () => {
  const f = fileOf();
  const { rc, session } = setup({ file: f });
  const a = session({ sessionId: 'a' });
  rc.onStart(a, { fresh: true });
  await tick();
  assert.deepEqual(a.q.calls, []);
  const ipc = new Map<string, (...x: any[]) => any>();
  rc.registerIpc({ handle: (n: string, fn: any) => ipc.set(n, fn) });
  assert.equal(await ipc.get('claude:remoteControlDefault')!(), false);
  assert.equal(await ipc.get('claude:setRemoteControlDefault')!({}, true), true);
  assert.equal(await ipc.get('claude:setRemoteControlDefault')!({}, 'yes'), false);
  assert.equal(await ipc.get('claude:setRemoteControlDefault')!({}, true), true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).connectNew, true);

  const fresh = session({ sessionId: 'fresh' });
  rc.onStart(fresh, { fresh: true });
  await until(() => fresh.rc?.phase === 'on');
  assert.deepEqual(fresh.q.calls, [[true, 'project', { keepSessionOnExit: true }]]);
  // the process's own init arrives once; a second one is not a start
  rc.onStart(fresh, { fresh: true });
  assert.equal(fresh.q.calls.length, 1);
  // a chat that is resumed was not new; one the user turned off stays off
  const old = session({ sessionId: 'old' });
  rc.onStart(old, { fresh: false });
  await tick();
  assert.deepEqual(old.q.calls, []);
  const off = session({ sessionId: 'off' });
  await rc.set(off, false).catch(() => {});
  off.rc.started = false;
  rc.onStart(off, { fresh: true });
  await tick();
  assert.equal(off.q.calls.filter((c: any[]) => c[0] === true).length, 0);
  // side chats, temporary chats and a chat kept apart are never linked or remembered
  for (const extra of [{ keep: true }, { unpersisted: true }, { isolated: true }, { sessionId: null }]) {
    const x = session({ sessionId: 'z', ...extra });
    rc.onStart(x, { fresh: true });
    await rc.set(x, true);
    assert.equal(x.q.calls.length, 1);
  }
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).choices.z, undefined);
  // a failing reconnect is only noted
  clearIgnored();
  const boom = session({ sessionId: 'boom' });
  boom.q.enableRemoteControl = () => {
    throw new Error('sync boom');
  };
  rc.onStart(boom, { fresh: true });
  await until(() => boom.rc?.phase === 'error');
});

test('the end of a process clears its link and says so; one that was off says nothing', async () => {
  const { rc, events, session } = setup();
  const idle = session();
  rc.onEnd(idle);
  assert.deepEqual(events, []);
  const s = session();
  await rc.set(s, true);
  events.length = 0;
  rc.onEnd(s);
  assert.deepEqual(events, [{ key: 'claude:x', kind: 'remoteControl', state: 'off', url: null, error: null, wanted: true }]);
  assert.equal(rc.view(s).state, 'off');
  rc.onEnd(s);
  assert.equal(events.length, 1);
});

test('the file is created on demand, a corrupt one starts empty, and a missing folder only costs the memory', async () => {
  const f = fileOf();
  fs.writeFileSync(f, '[1,2]');
  clearIgnored();
  const { rc, session } = setup({ file: f });
  const s = session();
  await rc.set(s, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { connectNew: false, choices: { x: { on: true, bridge: 'cse_a' } } });
  assert.ok(recentIgnored().some((e: any) => e.context.includes('Remote Control choices')));

  // no file at all: nothing is read or written
  const mem = setup({ file: null });
  const m = mem.session();
  assert.equal((await mem.rc.set(m, true)).state, 'on');
  // the file is resolved on first use, and a folder that is not there is noted
  clearIgnored();
  const lazy = setup({ file: () => path.join(dir, 'nope', 'deeper', 'rc.json') });
  const l = lazy.session();
  assert.equal((await lazy.rc.set(l, true)).state, 'on');
  assert.ok(recentIgnored().some((e: any) => e.context === 'save the Remote Control choices'));
});

test('only the newest choices are kept', async () => {
  const f = fileOf();
  const many: Record<string, any> = {};
  for (let i = 0; i < 205; i++) many[`s${i}`] = { on: false };
  fs.writeFileSync(f, JSON.stringify({ connectNew: false, choices: many }));
  const { rc, session } = setup({ file: f });
  await rc.set(session({ sessionId: 'fresh' }), true);
  const choices = JSON.parse(fs.readFileSync(f, 'utf8')).choices;
  assert.equal(Object.keys(choices).length, 200);
  assert.ok(choices.fresh);
  assert.equal(choices.s0, undefined);
});

async function until(ok: () => boolean) {
  await waitFor(ok, 'the condition').catch(() => {});
  if (!ok()) throw new Error('timed out');
}

test('releasing a chat forgets its choice and takes a live link down; with no link there is nothing to wait for', async () => {
  const f = fileOf();
  const { rc, events, live, session } = setup({ file: f });
  const a = session({ sessionId: 'a' });
  await rc.set(a, true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).choices.a.on, true);
  // no session, or one that never had a link, or a process that ended: nothing to drop
  assert.equal(rc.release(null, undefined), null);
  assert.equal(rc.release('nobody', session({ sessionId: 'nobody' })), null);
  const gone = session({ sessionId: 'gone' });
  await rc.set(gone, true);
  live.delete(gone);
  assert.equal(rc.release('gone', gone), null);
  // a link under way comes down too, and its late answer is the stale one
  const c = session({ sessionId: 'c' });
  const answer = later();
  c.q.answer = (on: boolean) => (on ? answer.promise : undefined);
  const connecting = rc.set(c, true);
  await tick();
  await tick();
  await rc.release('c', c);
  answer.resolve(link('late'));
  await connecting;
  assert.equal(rc.view(c).state, 'off');
  // the live one: down first, then off is published, and the choice is gone
  const done = rc.release('a', a);
  assert.ok(done);
  await done;
  assert.equal(a.q.calls.at(-1)[0], false);
  assert.equal(rc.view(a).state, 'off');
  assert.equal(events.at(-1).state, 'off');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).choices.a, undefined);
  // a bridge that will not drop is noted, and the session still ends up off
  clearIgnored();
  const b = session({ sessionId: 'b' });
  await rc.set(b, true);
  b.q.answer = () => Promise.reject(new Error('stuck'));
  await rc.release('b', b);
  assert.equal(rc.view(b).state, 'off');
  assert.ok(recentIgnored().some((e: any) => e.context.includes('archived or deleted')));
  // a process that ended while the drop was under way publishes nothing
  const d = session({ sessionId: 'd' });
  await rc.set(d, true);
  const drop = later();
  d.q.answer = () => drop.promise;
  const pending = rc.release('d', d);
  live.delete(d);
  const before = events.length;
  drop.resolve(undefined);
  await pending;
  assert.equal(events.length, before);
});
