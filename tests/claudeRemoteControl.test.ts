// Remote Control for Claude Code sessions (electron/harness/claude/remoteControl.cjs) against a fake SDK query: connect,
// disconnect, the newest request winning and a connect that answers late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { clearIgnored, fileOf, link, later, recentIgnored, setup, tick, UNAVAILABLE, linkOf } from './support/remote-control-kit.ts';

test('linkOf accepts only an https page and a bridge id', () => {
  assert.deepEqual(linkOf(link('z')), { url: 'https://claude.ai/code/session_z', bridge: 'cse_z' });
  for (const bad of [
    undefined,
    null,
    'x',
    [],
    {},
    { session_url: 'https://c', bridge_session_id: 1 },
    { session_url: '', bridge_session_id: 'b' },
  ])
    assert.equal(linkOf(bad), null);
  assert.equal(linkOf({ session_url: 'http://claude.ai/x', bridge_session_id: 'b' }), null);
  assert.equal(linkOf({ session_url: 'javascript:alert(1)', bridge_session_id: 'b' }), null);
});

test('turning it on connects with the title, shows connecting then on, and remembers the bridge', async () => {
  const { rc, events, session } = setup();
  const s = session();
  const v = await rc.set(s, true, { title: 'My chat' });
  assert.deepEqual(v, { state: 'on', url: 'https://claude.ai/code/session_a', error: null, wanted: true });
  assert.deepEqual(s.q.calls, [[true, 'My chat', { keepSessionOnExit: true }]]);
  assert.deepEqual(
    events.map((e) => [e.kind, e.state]),
    [
      ['remoteControl', 'connecting'],
      ['remoteControl', 'on'],
    ],
  );
  assert.equal(events[1].key, 'claude:x');
  assert.deepEqual(rc.view(s), v);
  // already on: asking again asks nothing of the CLI and changes nothing
  assert.deepEqual(await rc.set(s, true), v);
  assert.equal(s.q.calls.length, 1);
});

test('the title defaults to the folder name, then to the app name', async () => {
  const { rc, session } = setup();
  const a = session();
  await rc.set(a, true);
  assert.equal(a.q.calls[0][1], 'project');
  const b = session({ cwd: undefined });
  await rc.set(b, true);
  assert.equal(b.q.calls[0][1], 'MoPilot');
});

test('turning it off disconnects and clears the link, and the off is remembered', async () => {
  const f = fileOf();
  const { rc, events, session } = setup({ file: f });
  const s = session();
  await rc.set(s, true);
  s.q.answer = () => undefined;
  const v = await rc.set(s, false);
  assert.deepEqual(v, { state: 'off', url: null, error: null, wanted: false });
  assert.deepEqual(s.q.calls.at(-1), [false]);
  assert.equal(events.at(-1).state, 'off');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).choices, { x: { on: false } });
});

test('a disconnect that fails or times out keeps the link shown and says why', async () => {
  const { rc, session } = setup({ requestMs: 20 });
  const s = session();
  await rc.set(s, true);
  s.q.answer = () => Promise.reject(new Error('bridge gone'));
  await assert.rejects(rc.set(s, false), /bridge gone/);
  assert.equal(rc.view(s).state, 'on');
  assert.equal(rc.view(s).error, 'bridge gone');
  s.q.answer = () => new Promise(() => {});
  await assert.rejects(rc.set(s, false), /did not disconnect in time/);
  assert.equal(rc.view(s).state, 'on');
});

test('a disconnect that answers after its process ended, or after a newer request, changes nothing shown', async () => {
  const { rc, events, live, session } = setup();
  for (const outcome of ['ok', 'fail']) {
    const s = session();
    await rc.set(s, true);
    const answer = later();
    s.q.answer = () => answer.promise;
    const off = rc.set(s, false);
    const settled = outcome === 'ok' ? off : assert.rejects(off, /late failure/);
    live.delete(s);
    const before = events.length;
    if (outcome === 'ok') answer.resolve(undefined);
    else answer.reject(new Error('late failure'));
    await settled;
    assert.equal(events.length, before);
    assert.equal(rc.view(s).state, 'on');
  }
  // a newer request took over: the older disconnect leaves the state to it
  const t = session();
  await rc.set(t, true);
  const slow = later();
  t.q.answer = (on: boolean) => (on ? link('again') : slow.promise);
  const older = rc.set(t, false);
  const newer = rc.set(t, true);
  slow.resolve(undefined);
  await Promise.all([older, newer]);
  assert.equal(rc.view(t).state, 'on');
  assert.equal(rc.view(t).url, 'https://claude.ai/code/session_again');
});

test('a connect that fails is a view with the error, not a throw; the session can retry', async () => {
  const { rc, events, session } = setup();
  const s = session();
  s.q.answer = () => Promise.reject(new Error('bridge refused'));
  const v = await rc.set(s, true);
  assert.deepEqual(v, { state: 'error', url: null, error: 'bridge refused', wanted: true });
  assert.equal(events.at(-1).state, 'error');
  s.q.answer = () => link('b');
  assert.equal((await rc.set(s, true)).state, 'on');
  const odd = session();
  odd.q.answer = () => Promise.reject('plain text');
  assert.equal((await rc.set(odd, true)).error, 'plain text');
  const blank = session();
  blank.q.answer = () => Promise.reject(undefined);
  assert.equal((await rc.set(blank, true)).error, 'failed');
});

test('an answer without a usable link is a failure', async () => {
  const { rc, session } = setup();
  for (const bad of [undefined, {}, { session_url: 'https://x' }]) {
    const s = session();
    s.q.answer = () => bad;
    const v = await rc.set(s, true);
    assert.equal(v.state, 'error');
    assert.equal(v.error, 'Claude Code did not return a Remote Control link');
  }
});

test('a login that cannot have a bridge is unavailable, asked once, and nothing is connected', async () => {
  const { rc, events, session } = setup();
  const s = session();
  let asked = 0;
  s.q.initializationResult = async () => (asked++, { remote_control_available: false });
  const v = await rc.set(s, true);
  assert.deepEqual(v, { state: 'unavailable', url: null, error: UNAVAILABLE, wanted: false });
  assert.deepEqual(s.q.calls, []);
  assert.equal(events.at(-1).state, 'unavailable');
  await rc.set(s, true);
  assert.equal(asked, 1);
  assert.deepEqual(s.q.calls, []);
});

test('a CLI that cannot say, or says something odd, is asked to connect', async () => {
  const { rc, session } = setup();
  const noMethod = session();
  delete noMethod.q.initializationResult;
  assert.equal((await rc.set(noMethod, true)).state, 'on');
  const odd = session();
  odd.q.initializationResult = async () => 'what';
  assert.equal((await rc.set(odd, true)).state, 'on');
  clearIgnored();
  const broken = session();
  broken.q.initializationResult = async () => {
    throw new Error('no init');
  };
  assert.equal((await rc.set(broken, true)).state, 'on');
  assert.ok(recentIgnored().some((e: any) => e.context.includes('Remote Control availability')));
});

test('a process that ended while availability was read is left alone; so is one replaced by a newer request', async () => {
  const { rc, events, live, session } = setup();
  const gone = session();
  const ask = later();
  gone.q.initializationResult = () => ask.promise;
  const p = rc.set(gone, true);
  live.delete(gone);
  ask.resolve({ remote_control_available: false });
  assert.equal((await p).state, 'off');
  assert.deepEqual(gone.q.calls, []);
  assert.deepEqual(events, []);

  const s = session();
  const first = later();
  s.q.initializationResult = () => first.promise;
  const older = rc.set(s, true);
  const newer = rc.set(s, false);
  first.resolve({ remote_control_available: true });
  await Promise.allSettled([older, newer]);
  // the older connect never started: its generation was taken over before it could
  assert.equal(s.q.calls.filter((c: any[]) => c[0] === true).length, 0);
  assert.equal(rc.view(s).wanted, false);
  const u = session();
  const unavailable = later();
  u.q.initializationResult = () => unavailable.promise;
  const x = rc.set(u, true);
  const y = rc.set(u, true);
  unavailable.resolve({ remote_control_available: false });
  await x;
  assert.equal((await y).state, 'unavailable');
});

test('an answer that arrives after the user turned it off takes the unrecorded link down', async () => {
  const { rc, session } = setup();
  const s = session();
  const answer = later();
  s.q.answer = (on: boolean) => (on ? answer.promise : undefined);
  const connecting = rc.set(s, true);
  await tick();
  await tick();
  const off = rc.set(s, false);
  answer.resolve(link('late'));
  await Promise.all([connecting, off]);
  assert.equal(rc.view(s).state, 'off');
  assert.deepEqual(s.q.calls.filter((c: any[]) => c[0] === false).length >= 2, true);
});

test('a stale answer under a newer connect leaves that connect to record its own link', async () => {
  const { rc, session } = setup();
  const s = session();
  const first = later();
  const second = later();
  const answers = [first, second];
  s.q.answer = (on: boolean) => (on ? answers.shift()!.promise : undefined);
  const a = rc.set(s, true);
  await tick();
  await tick();
  // off and on again while the first connect is unanswered: the newest connect is the one that counts
  await rc.set(s, false);
  const b = rc.set(s, true);
  await tick();
  await tick();
  first.resolve(link('one'));
  await a;
  assert.equal(rc.view(s).state, 'connecting');
  second.resolve(link('two'));
  await b;
  assert.equal(rc.view(s).url, 'https://claude.ai/code/session_two');
  // only the user's own off was asked of the CLI: the older link was never taken down by it
  assert.equal(s.q.calls.filter((c: any[]) => c[0] === false).length, 1);
});

test('a failure of an older connect does not undo a newer one', async () => {
  const { rc, session } = setup();
  const s = session();
  const first = later();
  const second = later();
  const answers = [first, second];
  s.q.answer = (on: boolean) => (on ? answers.shift()!.promise : undefined);
  const a = rc.set(s, true);
  await tick();
  await tick();
  // off and on again while the first connect is unanswered: the newest connect is the one that counts
  await rc.set(s, false);
  const b = rc.set(s, true);
  await tick();
  await tick();
  second.resolve(link('two'));
  await b;
  first.reject(new Error('older failed'));
  const old = await a;
  assert.equal(old.state, 'on');
  assert.equal(old.url, 'https://claude.ai/code/session_two');
});

test('a connect that outlives its time is retried, and an answer that comes later is taken down when nothing recorded it', async () => {
  clearIgnored();
  const { rc, session } = setup({ requestMs: 15 });
  const s = session();
  const answer = later();
  s.q.answer = (on: boolean) => (on ? answer.promise : undefined);
  const v = await rc.set(s, true);
  assert.equal(v.state, 'offline');
  assert.equal(v.error, 'Reconnecting Remote Control');
  answer.resolve(link('late'));
  await tick();
  await tick();
  assert.deepEqual(s.q.calls.at(-1), [false]);
  // a disconnect of that unrecorded link that fails is noted, not thrown
  const t = session();
  const lateAgain = later();
  t.q.answer = (on: boolean) => (on ? lateAgain.promise : Promise.reject(new Error('cannot drop')));
  await rc.set(t, true);
  lateAgain.resolve(link('late2'));
  await tick();
  await tick();
  await tick();
  assert.ok(recentIgnored().some((e: any) => e.context.includes('not recorded')));
});

test('a late answer is left alone when a retry recorded the link, or is still connecting, or the process is gone, or was no link', async () => {
  const { rc, live, session } = setup({ requestMs: 15 });
  const run = async (settle: (t: any) => Promise<void> | void) => {
    const s = session();
    const answer = later();
    let first = true;
    s.q.answer = (on: boolean) => {
      if (!on) return undefined;
      if (first) return (first = false), answer.promise;
      return link('retry');
    };
    await rc.set(s, true);
    await settle(s);
    answer.resolve(link('late'));
    await tick();
    await tick();
    return s;
  };
  // a retry recorded its own link
  let s = await run(async (t) => assert.equal((await rc.set(t, true)).state, 'on'));
  assert.equal(s.q.calls.filter((c: any[]) => c[0] === false).length, 0);
  // the process ended
  s = await run(() => void live.delete(s));
  const gone = session();
  const l1 = later();
  gone.q.answer = () => l1.promise;
  await rc.set(gone, true);
  live.delete(gone);
  l1.resolve(link('x'));
  await tick();
  assert.equal(gone.q.calls.filter((c: any[]) => c[0] === false).length, 0);
  // an answer that is no link
  const odd = session();
  const l2 = later();
  odd.q.answer = () => l2.promise;
  await rc.set(odd, true);
  l2.resolve({});
  await tick();
  assert.equal(odd.q.calls.filter((c: any[]) => c[0] === false).length, 0);
  // a late rejection is only noted
  clearIgnored();
  const bad = session();
  const l3 = later();
  bad.q.answer = () => l3.promise;
  await rc.set(bad, true);
  l3.reject(new Error('too late'));
  await tick();
  await tick();
  assert.ok(recentIgnored().some((e: any) => e.context.includes('late Remote Control connect')));
});

test('an ended process publishes nothing for its connect', async () => {
  const { rc, events, live, session } = setup();
  const s = session();
  const answer = later();
  s.q.answer = () => answer.promise;
  const p = rc.set(s, true);
  await tick();
  await tick();
  const before = events.length;
  live.delete(s);
  answer.resolve(link('x'));
  await p;
  assert.equal(events.length, before);
  assert.equal(rc.view(s).state, 'connecting');
});

test('a second on while a connect is under way is that connect, not a second bridge', async () => {
  const { rc, session } = setup();
  const s = session();
  const answer = later();
  s.q.answer = () => answer.promise;
  const a = rc.set(s, true);
  const b = rc.set(s, true);
  assert.equal(a, b);
  answer.resolve(link('one'));
  assert.equal((await a).state, 'on');
  assert.equal(s.q.calls.length, 1);
});

test('a link must point at claude.ai or claude.com over https', () => {
  const ok = (url: string) => linkOf({ session_url: url, bridge_session_id: 'b' }) !== null;
  assert.equal(ok('https://claude.ai/code/session_a'), true);
  assert.equal(ok('https://staging.claude.ai/code/x'), true);
  assert.equal(ok('https://claude.com/code/x'), true);
  for (const bad of [
    'https://evil.example/claude.ai',
    'https://claude.ai.evil.example/x',
    'https://notclaude.ai/x',
    'not a url',
    'http://claude.ai/x',
  ])
    assert.equal(ok(bad), false);
});

test('an error never carries a link or a bridge id into what the chat shows', async () => {
  const { rc, session } = setup();
  const s = session();
  s.q.answer = () => Promise.reject(new Error('failed for https://claude.ai/code/session_a (cse_a) after 3 tries'));
  const v = await rc.set(s, true);
  assert.equal(v.error, 'failed for [link] ([id]) after 3 tries');
});
