// The Host's desktop lease (G8 #3903): one chat at a time, grants checked and injected on every call, a resent call answered once, the lease ending with its connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createDesktopHost, scopeParams, scopeReply, DesktopError } from '../host/src/desktopHost.mjs';
// @ts-ignore: plain ESM without declarations
import { ANY_APP } from '../shared/host/desktop.mjs';
import { fakeHelper } from './support/host-desktop-kit.ts';
import { deferred, tick } from './support/async-scenarios.ts';

function setup(over: { ok?: boolean; epochs?: Record<string, number>; maxReply?: number } = {}) {
  const f = fakeHelper();
  let ok = over.ok ?? true;
  let rechecks = 0;
  const epochs: Record<string, number> = over.epochs ?? {};
  const probe = { ok: () => ok, why: () => 'The desktop helper is not installed on this Host.', recheck: () => void rechecks++ };
  const host = createDesktopHost({ helper: f.helper, probe, epochOf: (c: string) => epochs[c] ?? 1, maxReply: over.maxReply ?? 1000 });
  return { ...f, host, epochs, setOk: (v: boolean) => (ok = v), rechecks: () => rechecks };
}
const A = {};
const B = {};

test('A1: a second chat is refused while one holds the desktop; it is never queued or taken', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['com.apple.Notes']);
  await assert.rejects(s.host.lease(B, 'chat-b', 1, ['com.apple.Notes']), (e: any) => e.code === 'busy');
  assert.deepEqual(
    s.calls.map((c) => c.method),
    ['control.acquire'],
    'the helper was asked for control once, by the first chat',
  );
  assert.equal(s.host.state(B, 'chat-b').busy, true);
  assert.equal(s.host.state(A, 'chat-a').held, true);
});

test('A1: two connections racing for the desktop get one winner', async () => {
  const s = setup();
  const gate = deferred<any>();
  s.helper.handler = (m: string) => (m === 'control.acquire' ? gate.promise : Promise.resolve({}));
  const first = s.host.lease(A, 'chat-a', 1, ['x.y']);
  const second = s.host.lease(B, 'chat-b', 1, ['x.y']);
  gate.resolve({});
  await first;
  await assert.rejects(second, (e: any) => e.code === 'busy');
});

test('a lease whose chat has a newer owner is dead: another chat may take the desktop', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['x.y']);
  s.epochs['chat-a'] = 2;
  assert.equal(s.host.state(B, 'chat-b').busy, false);
  await s.host.lease(B, 'chat-b', 1, ['x.y']);
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', {}), (e: any) => e.code === 'no_lease');
});

test('a reconnect of the same chat starts fresh: held input is let go and the old connection can no longer act', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['x.y']);
  await s.host.lease(B, 'chat-a', 1, ['z.w']);
  assert.deepEqual(
    s.calls.map((c) => c.method),
    ['control.acquire', 'input.release', 'control.release', 'control.acquire'],
  );
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', {}), (e: any) => e.code === 'no_lease');
  await s.host.call(B, 'chat-a', 1, 'call-0002', 'input.click', {});
  assert.deepEqual(s.calls.at(-1)?.params.bundleIds, ['z.w'], 'the new grants, not the old ones');
});

test('a lease at an older epoch than the held one is refused as stale', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 3, ['x.y']);
  await assert.rejects(s.host.lease(B, 'chat-a', 2, ['x.y']), (e: any) => e.code === 'stale_lease');
  await assert.rejects(s.host.call(A, 'chat-a', 2, 'call-0001', 'input.click', {}), (e: any) => e.code === 'stale_lease');
});

test('no lease, no call: not held, held by another connection, or an action the Host does not serve', async () => {
  const s = setup();
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', {}), (e: any) => e.code === 'no_lease');
  await s.host.lease(A, 'chat-a', 1, ['x.y']);
  await assert.rejects(s.host.call(B, 'chat-a', 1, 'call-0001', 'input.click', {}), (e: any) => e.code === 'no_lease');
  await assert.rejects(s.host.call(A, 'chat-b', 1, 'call-0001', 'input.click', {}), (e: any) => e.code === 'no_lease');
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0001', 'permissions.request', {}), (e: any) => e.code === 'unsupported_call');
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0001', 'app.script', {}), (e: any) => e.code === 'unsupported_call');
});

test('an unavailable desktop refuses the lease with the reason; a disposed Host refuses too', async () => {
  const s = setup({ ok: false });
  await assert.rejects(s.host.lease(A, 'chat-a', 1, ['x.y']), (e: any) => e.code === 'unavailable' && /not installed/.test(e.message));
  assert.deepEqual(s.host.state(A, 'chat-a'), {
    held: false,
    busy: false,
    available: false,
    reason: 'The desktop helper is not installed on this Host.',
  });
  s.setOk(true);
  assert.deepEqual(s.host.state(A, 'chat-a'), { held: false, busy: false, available: true });
  await s.host.dispose();
  await assert.rejects(s.host.lease(A, 'chat-a', 1, ['x.y']), (e: any) => e.code === 'unavailable');
});

test('scopeParams: named apps must be inside the grant; the grant is injected for the helper; any-app leaves params alone', () => {
  const apps = ['a.b', 'c.d'];
  assert.deepEqual(scopeParams(apps, 'input.click', { x: 1 }), { x: 1, bundleIds: apps });
  assert.deepEqual(scopeParams(apps, 'input.click', { x: 1, bundleIds: ['a.b'] }), { x: 1, bundleIds: ['a.b'] });
  assert.deepEqual(scopeParams(apps, 'screenshot', {}), { bundleIds: apps, includeBundleIds: apps });
  assert.deepEqual(scopeParams(apps, 'screenshot', { includeBundleIds: ['c.d'] }), { bundleIds: apps, includeBundleIds: ['c.d'] });
  assert.deepEqual(scopeParams(apps, 'app.click', { bundleId: 'a.b' }), { bundleId: 'a.b', bundleIds: apps });
  for (const outside of [{ bundleIds: ['e.f'] }, { includeBundleIds: ['a.b', 'e.f'] }, { bundleId: 'e.f' }, { bundleIds: 'a.b' }])
    assert.throws(
      () => scopeParams(apps, 'input.click', outside),
      (e: any) => e instanceof DesktopError && e.code === 'outside_grant',
    );
  const p = { x: 1, bundleIds: ['anything'] };
  assert.equal(scopeParams(ANY_APP, 'input.click', p), p);
});

test('scopeReply: the lists of the whole desktop answer only about the lease’s apps; any-app and other replies pass through', () => {
  const apps = ['a.b', 'C.D'];
  const running = {
    apps: [{ bundleId: 'A.B', name: 'One' }, { bundleId: 'e.f', name: 'Two' }, { name: 'No id' }, { bundleId: 'c.d' }],
    frontmost: 'e.f',
  };
  assert.deepEqual(scopeReply(apps, 'apps.list', running), {
    apps: [{ bundleId: 'A.B', name: 'One' }, { bundleId: 'c.d' }],
    frontmost: 'e.f',
  });
  const found = {
    apps: [
      { query: 'one', app: { bundleId: 'a.b' } },
      { query: 'two', app: { bundleId: 'e.f' }, refused: 'x' },
      { query: 'none', app: null },
      null,
    ],
  };
  assert.deepEqual(scopeReply(apps, 'apps.resolve', found), {
    apps: [{ query: 'one', app: { bundleId: 'a.b' } }, { query: 'two', app: null }, { query: 'none', app: null }, null],
  });
  assert.equal(scopeReply(ANY_APP, 'apps.list', running), running);
  assert.equal(scopeReply(apps, 'displays.list', { displays: [] }).displays.length, 0);
  assert.equal(scopeReply(apps, 'apps.list', undefined), undefined);
  assert.deepEqual(scopeReply(apps, 'screenshot', { apps: [{ bundleId: 'e.f' }] }), { apps: [{ bundleId: 'e.f' }] });
});

test('a lease limited to some apps sees only those in apps.list through the Host', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  s.helper.handler = async () => ({ apps: [{ bundleId: 'a.b' }, { bundleId: 'x.y' }] });
  assert.deepEqual(await s.host.call(A, 'chat-a', 1, 'call-0001', 'apps.list', {}), { apps: [{ bundleId: 'a.b' }] });
});

test('a lease with no apps yet serves the lookups only, shows them every app, and refuses everything else whatever it names', async () => {
  assert.deepEqual(scopeParams([], 'apps.list', {}), {});
  assert.deepEqual(scopeParams([], 'apps.resolve', { queries: ['Notes'] }), { queries: ['Notes'] });
  assert.deepEqual(scopeParams([], 'displays.list', {}), {});
  for (const method of ['input.click', 'screenshot', 'apps.open', 'app.click'])
    assert.throws(
      () => scopeParams([], method, { bundleIds: ['a.b'] }),
      (e: any) => e instanceof DesktopError && e.code === 'outside_grant' && /No apps are granted/.test(e.message),
    );
  const all = { apps: [{ bundleId: 'a.b' }, { bundleId: 'x.y' }] };
  assert.equal(scopeReply([], 'apps.list', all), all);
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, []);
  s.helper.handler = async () => all;
  assert.deepEqual(await s.host.call(A, 'chat-a', 1, 'call-0001', 'apps.list', {}), all);
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0002', 'input.click', {}), (e: any) => e.code === 'outside_grant');
  assert.equal(s.calls.filter((c) => c.method === 'input.click').length, 0);
});

test('a call reaches the helper scoped to the lease; a call outside the grant never does', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  s.helper.handler = async () => ({ clicked: true });
  assert.deepEqual(await s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', { x: 4, y: 5 }), { clicked: true });
  assert.deepEqual(s.calls.at(-1), { method: 'input.click', params: { x: 4, y: 5, bundleIds: ['a.b'] } });
  const before = s.calls.length;
  await assert.rejects(
    s.host.call(A, 'chat-a', 1, 'call-0002', 'input.click', { bundleIds: ['z.z'] }),
    (e: any) => e.code === 'outside_grant',
  );
  assert.equal(s.calls.length, before);
});

test('a resent call id gets the first answer and acts once; reads are not remembered', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  let n = 0;
  s.helper.handler = async () => ({ n: ++n });
  const first = s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', {});
  const again = s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', {});
  assert.deepEqual([await first, await again], [{ n: 1 }, { n: 1 }]);
  assert.equal(s.calls.filter((c) => c.method === 'input.click').length, 1);
  assert.deepEqual(await s.host.call(A, 'chat-a', 1, 'call-0002', 'screenshot', {}), { n: 2 });
  assert.deepEqual(await s.host.call(A, 'chat-a', 1, 'call-0002', 'screenshot', {}), { n: 3 }, 'a look is taken again');
  // a failure is remembered too: the resend gets the same error, the click does not happen twice
  s.helper.handler = async () => {
    throw Object.assign(new Error('refused'), { reason: 'target_refused' });
  };
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0003', 'input.type', {}), /refused/);
  s.helper.handler = async () => ({ n: 99 });
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0003', 'input.type', {}), /refused/);
  assert.equal(s.rechecks(), 0, 'a refused action says nothing about the session');
});

test('a call id that comes back with another action is refused, not answered with the first one', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  await s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', { x: 1 });
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0001', 'input.type', { text: 'hi' }), (e: any) => e.code === 'call_id_reused');
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', { x: 2 }), (e: any) => e.code === 'call_id_reused');
  assert.equal(s.calls.filter((c) => c.method === 'input.type').length, 0);
  assert.equal(s.calls.filter((c) => c.method === 'input.click').length, 1);
});

test('the memory of answered calls is bounded: the oldest is forgotten', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  let n = 0;
  s.helper.handler = async () => ({ n: ++n });
  for (let i = 0; i < 65; i++) await s.host.call(A, 'chat-a', 1, `call-${String(i).padStart(4, '0')}`, 'input.click', {});
  assert.deepEqual(await s.host.call(A, 'chat-a', 1, 'call-0064', 'input.click', {}), { n: 65 }, 'the newest is still remembered');
  assert.deepEqual(await s.host.call(A, 'chat-a', 1, 'call-0000', 'input.click', {}), { n: 66 }, 'the oldest was forgotten and runs again');
});

test('calls of a lease run one at a time, in order', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  const gate = deferred<any>();
  const order: string[] = [];
  s.helper.handler = async (m: string, p: any) => {
    order.push(`start ${p.tag}`);
    if (p.tag === 1) await gate.promise;
    order.push(`end ${p.tag}`);
    return {};
  };
  const one = s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', { tag: 1 });
  const two = s.host.call(A, 'chat-a', 1, 'call-0002', 'input.click', { tag: 2 });
  await tick();
  assert.deepEqual(order, ['start 1']);
  gate.resolve({});
  await Promise.all([one, two]);
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('Stop: a call waiting behind a running one fails at once, and the desktop is let go', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  const gate = deferred<any>();
  s.helper.handler = async (m: string) => (m === 'input.click' ? gate.promise : {});
  const running = s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', {});
  const waiting = s.host.call(A, 'chat-a', 1, 'call-0002', 'input.type', {});
  await tick();
  const stopped = s.host.abort('chat-a');
  gate.resolve({});
  await running;
  await assert.rejects(waiting, (e: any) => e.code === 'aborted');
  assert.deepEqual(await stopped, { aborted: true });
  assert.equal(s.calls.filter((c) => c.method === 'input.type').length, 0, 'the waiting action never ran');
  assert.deepEqual(
    s.calls.slice(-2).map((c) => c.method),
    ['input.release', 'control.release'],
  );
  assert.equal(s.host.state(A, 'chat-a').held, false);
  assert.deepEqual(await s.host.abort('chat-a'), { aborted: false }, 'nothing to stop the second time');
  assert.deepEqual(await s.host.abort('someone-else'), { aborted: false });
});

test('release and disconnect let go of the desktop, with held input cancelled and no resume; a late release by another cannot end a newer lease', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  assert.deepEqual(await s.host.release(B, 'chat-a', 1), { released: true });
  assert.equal(s.host.state(A, 'chat-a').held, true, 'not the holder: nothing ended');
  assert.deepEqual(await s.host.release(A, 'chat-a', 1), { released: true });
  assert.equal(s.host.state(A, 'chat-a').held, false);
  await s.host.lease(A, 'chat-a', 2, ['a.b']);
  await s.host.release(A, 'chat-a', 1);
  assert.equal(s.host.state(A, 'chat-a').held, true, 'a release of an older epoch does not end the newer lease');
  await s.host.closed(B);
  assert.equal(s.host.state(A, 'chat-a').held, true);
  const before = s.calls.length;
  await s.host.closed(A);
  assert.deepEqual(
    s.calls.slice(before).map((c) => c.method),
    ['input.release', 'control.release'],
  );
  await assert.rejects(s.host.call(A, 'chat-a', 2, 'call-0001', 'input.click', {}), (e: any) => e.code === 'no_lease');
});

test('letting go survives a helper that is already gone', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  s.helper.handler = async () => {
    throw new Error('helper exited');
  };
  await s.host.closed(A);
  assert.equal(s.host.state(A, 'chat-a').held, false);
});

test('a reply too large for a frame is refused with the way out; a helper that went makes the Host look again', async () => {
  const s = setup({ maxReply: 50 });
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  s.helper.handler = async () => ({ png: 'x'.repeat(200) });
  await assert.rejects(
    s.host.call(A, 'chat-a', 1, 'call-0001', 'screenshot', {}),
    (e: any) => e.code === 'too_large' && /smaller screenshot/.test(e.message),
  );
  s.helper.handler = async () => undefined;
  assert.equal(
    await s.host.call(A, 'chat-a', 1, 'call-0002', 'screenshot', {}),
    undefined,
    'an empty answer is carried as null, not refused',
  );
  assert.equal(s.rechecks(), 0);
  s.helper.handler = async () => {
    throw Object.assign(new Error('helper stopped'), { reason: 'helper_exited' });
  };
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0003', 'input.click', {}), /helper stopped/);
  await tick();
  assert.equal(s.rechecks(), 1);
});

test('dispose ends the lease, then stops the helper', async () => {
  const s = setup();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  await s.host.dispose();
  assert.equal(s.stopped(), 1);
  assert.deepEqual(
    s.calls.slice(-2).map((c) => c.method),
    ['input.release', 'control.release'],
  );
  const idle = setup();
  await idle.host.dispose();
  assert.equal(idle.stopped(), 1);
});
