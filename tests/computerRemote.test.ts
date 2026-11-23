// A Host's own desktop as the computer-use helper (G8 #3903): the usual wrappers over RemoteDesktop with a lease per chat, nothing of this Mac's reached, and what only a person at a Mac can do answered as a guest can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RemoteHelper, grantKey } = require('../electron/capabilities/computerRemote.cjs');
const { ComputerHelper } = require('../electron/capabilities/computer.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

function rig(over: { apps?: string[] | '*'; alive?: boolean } = {}) {
  const log: any[] = [];
  const ids: string[] = [];
  const state = { apps: over.apps ?? (['a.b'] as string[] | '*'), alive: over.alive ?? true, fail: null as any, available: true };
  const remote = {
    lease: async (c: string, apps: any) => void log.push(['lease', c, apps]),
    command: async (c: string, m: string, p: any, o: any = {}) => {
      log.push(['command', c, m, p]);
      ids.push(o.callId);
      if (state.fail) throw state.fail;
      return { did: m };
    },
    release: async (c: string) => void log.push(['release', c]),
    abort: async (c: string) => void log.push(['abort', c]),
    state: async (c: string) => (log.push(['state', c]), { available: state.available }),
    alive: () => state.alive,
  };
  const helper = new RemoteHelper({ remote, appsOf: () => state.apps, idleSeconds: async () => 42 });
  const as = <T>(chat: string, fn: () => T) => guarded({ token: { chat, turn: 1 } }, fn);
  return { helper, log, state, as, ids };
}

test('the wrappers go to the Host as helper requests for the chat of the running call, under a lease taken once', async () => {
  const r = rig();
  assert.deepEqual(await r.as('c1', () => r.helper.click(10, 20, { count: 2 })), { did: 'input.click' });
  await r.as('c1', () => r.helper.screenshot({ maxSide: 800 }));
  assert.deepEqual(r.log, [
    ['lease', 'c1', ['a.b']],
    ['command', 'c1', 'input.click', { x: 10, y: 20, count: 2 }],
    ['command', 'c1', 'screenshot', { maxSide: 800 }],
  ]);
  // another chat has its own lease, on the same Host
  await r.as('c2', () => r.helper.key('Return'));
  assert.deepEqual(r.log.at(-2), ['lease', 'c2', ['a.b']]);
});

test('a changed grant takes the lease again with the new apps; the same grant in another order does not', async () => {
  const r = rig({ apps: ['b.b', 'a.a'] });
  await r.as('c1', () => r.helper.click(1, 2));
  r.state.apps = ['a.a', 'b.b'];
  await r.as('c1', () => r.helper.click(1, 2));
  assert.equal(r.log.filter((l) => l[0] === 'lease').length, 1);
  r.state.apps = ['a.a', 'b.b', 'c.c'];
  await r.as('c1', () => r.helper.click(1, 2));
  r.state.apps = '*';
  await r.as('c1', () => r.helper.click(1, 2));
  assert.deepEqual(
    r.log.filter((l) => l[0] === 'lease').map((l) => l[2]),
    [['b.b', 'a.a'], ['a.a', 'b.b', 'c.c'], '*'],
  );
  assert.equal(grantKey('*'), '*');
  assert.equal(grantKey(['b', 'a']), 'a,b');
});

test('control is the lease: acquire and resume take it, release and a turn that ended let go of it', async () => {
  const r = rig();
  assert.deepEqual(await r.as('c1', () => r.helper.acquireControl('MoPilot')), { controlling: true, paused: null });
  await r.as('c1', () => r.helper.resumeControl());
  assert.equal(r.log.filter((l) => l[0] === 'lease').length, 1);
  await r.as('c1', () => r.helper.releaseControl());
  assert.deepEqual(r.log.at(-1), ['release', 'c1']);
  await r.as('c1', () => r.helper.click(1, 1));
  assert.equal(r.log.filter((l) => l[0] === 'lease').length, 2, 'the lease was taken again after it was let go');
  await r.as('c2', () => r.helper.click(1, 1));
  await r.helper.revokeTurn('c1', 3);
  assert.deepEqual(r.log.at(-1), ['release', 'c1']);
  await r.as('c3', () => r.helper.click(1, 1));
  const before = r.log.length;
  await r.helper.releaseInput({ keys: ['a'] });
  assert.deepEqual(
    r.log.slice(before).map((l) => l.slice(0, 3)),
    [
      ['command', 'c2', 'input.release'],
      ['command', 'c3', 'input.release'],
    ],
    'a cleanup with no chat lets go of held input on every desktop it holds',
  );
  r.state.fail = new Error('the Host is gone');
  assert.deepEqual(await r.helper.releaseInput({ keys: ['a'] }), {}, 'best effort: a Host that does not answer is not an error');
});

test('a cleanup with no chat lets go of every chat the helper holds a lease for', async () => {
  const r = rig();
  await r.as('c1', () => r.helper.click(1, 1));
  await r.as('c2', () => r.helper.click(1, 1));
  await r.helper.call('control.release');
  assert.deepEqual(
    r.log.filter((l) => l[0] === 'release').map((l) => l[1]),
    ['c1', 'c2'],
  );
  await r.helper.call('control.release');
  assert.equal(r.log.filter((l) => l[0] === 'release').length, 2, 'nothing left to let go of');
});

test('a request that needs a chat refuses without one; the idle time is the user’s own device; the permissions are the Host’s desktop', async () => {
  const r = rig();
  await assert.rejects(r.helper.screenshot(), (e: any) => e instanceof ToolError && e.code === 'no_chat');
  await assert.rejects(r.helper.permissionStatus(), (e: any) => e.code === 'no_chat');
  assert.equal(await r.helper.idleSeconds(), 42);
  assert.equal(await r.helper.escapeSender(), null);
  assert.deepEqual(await r.as('c1', () => r.helper.permissionStatus()), {
    accessibility: true,
    screenRecording: true,
    inputMonitoring: true,
  });
  r.state.available = false;
  assert.deepEqual(await r.as('c1', () => r.helper.permissionStatus()), {
    accessibility: false,
    screenRecording: false,
    inputMonitoring: false,
  });
  assert.equal(r.log.filter((l) => l[0] === 'command').length, 0);
});

test('what only a person at a Mac does: nothing to do on a guest, or a refusal that says so', async () => {
  const r = rig();
  for (const m of ['glow.start', 'glow.stop', 'apps.hideOthers', 'apps.restore', 'pasteboard.save', 'pasteboard.restore', 'deny.set'])
    assert.deepEqual(await r.as('c1', () => r.helper.call(m, {})), {}, m);
  for (const m of [
    'permissions.request',
    'permissions.openSettings',
    'speech.status',
    'eventkit.status',
    'calendar.events',
    'record.start',
    'activity.sample',
    'app.script',
    'shortcuts.run',
  ])
    await assert.rejects(
      r.as('c1', () => r.helper.call(m, {})),
      (e: any) => e.code === 'unsupported_on_host',
      m,
    );
  await assert.rejects(
    r.as('c1', () => r.helper.call('shutdown', {})),
    (e: any) => e.code === 'unsupported_on_host' && /not something a Host/.test(e.message),
  );
  assert.equal(r.log.length, 0, 'none of it reached the Host');
});

test('the Host letting go of the lease (idle, a new owner) is learned from the failure: the call takes the lease again once, with the same call id; other failures keep it', async () => {
  const r = rig();
  await r.as('c1', () => r.helper.click(1, 1));
  // a lease lost once: the call goes through on the second try, as the same action
  let lost = 1;
  const send = r.helper.remote.command;
  r.helper.remote.command = async (...a: any[]) => {
    if (lost-- > 0) throw new ToolError('This chat does not hold the desktop.', 'no_lease');
    return send(...a);
  };
  await r.as('c1', () => r.helper.click(1, 1));
  r.helper.remote.command = send;
  assert.equal(r.log.filter((l) => l[0] === 'lease').length, 2, 'the lease was taken again');
  // a lease that stays lost: one retry, then the error
  r.state.fail = new ToolError('x', 'no_lease');
  const before = r.ids.length;
  await assert.rejects(
    r.as('c1', () => r.helper.click(1, 1)),
    (e: any) => e.code === 'no_lease',
  );
  assert.equal(r.ids.length - before, 2, 'tried twice, not more');
  assert.equal(r.ids.at(-1), r.ids.at(-2), 'the retry is the same action, so the Host answers it once');
  r.state.fail = null;
  await r.as('c1', () => r.helper.click(1, 1));
  r.state.fail = new ToolError('x', 'busy');
  const leases = r.log.filter((l) => l[0] === 'lease').length;
  await assert.rejects(r.as('c1', () => r.helper.click(1, 1)));
  assert.equal(r.log.filter((l) => l[0] === 'lease').length, leases, 'busy keeps the lease');
});

test('Stop tells the Host; the helper is "running" while the Host answers and starts and stops nothing of this Mac’s', async () => {
  const r = rig();
  await r.as('c1', () => r.helper.click(1, 1));
  await r.helper.abortChat('c1');
  assert.deepEqual(r.log.at(-1), ['abort', 'c1']);
  await r.as('c1', () => r.helper.click(1, 1));
  assert.equal(r.log.filter((l) => l[0] === 'lease').length, 2, 'a stopped chat leases again');
  assert.equal(r.helper.running, true);
  r.state.alive = false;
  assert.equal(r.helper.running, false);
  assert.equal(r.helper.installed, true);
  assert.deepEqual(await r.helper.start(), { remote: true });
  r.helper.stop();
});

test('it never touches this Mac’s helper: ComputerHelper’s own call is not used', async () => {
  const original = ComputerHelper.prototype.call;
  let local = 0;
  ComputerHelper.prototype.call = function (...a: any[]) {
    local++;
    return original.apply(this, a);
  };
  try {
    const r = rig();
    await r.as('c1', () => r.helper.click(1, 1));
    await r.as('c1', () => r.helper.permissionStatus());
    await r.helper.call('control.release');
    assert.equal(local, 0);
  } finally {
    ComputerHelper.prototype.call = original;
  }
});

test('a new connection to the same Host: calls go over it and each chat takes its lease again', async () => {
  const a = rig();
  await a.as('c1', () => a.helper.click(1, 1));
  const b = rig();
  a.helper.setRemote(b.helper.remote);
  await a.as('c1', () => a.helper.click(2, 2));
  assert.deepEqual(
    b.log.map((l) => l[0]),
    ['lease', 'command'],
  );
  assert.equal(a.log.filter((l) => l[0] === 'command').length, 1, 'the old connection was not used again');
});

test('a finished chat gives the Host its desktop up at once, once; a chat that held none asks nothing', async () => {
  const r = rig();
  await r.as('c1', () => r.helper.click(1, 1));
  await r.helper.forgetChat('c1');
  assert.deepEqual(r.log.at(-1), ['release', 'c1']);
  const n = r.log.length;
  await r.helper.forgetChat('c1');
  await r.helper.forgetChat('never');
  assert.equal(r.log.length, n);
});

test('around runs a call inside what the pane shows of it (after the lease, around a retry); a screenshot’s geometry is told once it came back', async () => {
  const log: any[] = [];
  const remote: any = {
    lease: async (c: string) => void log.push(['lease', c]),
    command: async (_c: string, m: string) => (log.push(['command', m]), { display: { id: 1 }, did: m }),
    release: async () => undefined,
    abort: async () => undefined,
    state: async () => ({ available: true }),
    alive: () => true,
  };
  const helper = new RemoteHelper({
    remote,
    appsOf: () => ['a.b'],
    idleSeconds: async () => 1,
    around: async (c: string, m: string, p: any, run: () => Promise<any>) => (log.push(['around', c, m, p]), run()),
    onShot: (c: string, shot: any) => log.push(['shot', c, shot.did]),
  });
  await guarded({ token: { chat: 'c1', turn: 1 } }, () => helper.click(3, 4));
  await guarded({ token: { chat: 'c1', turn: 1 } }, () => helper.screenshot({}));
  assert.deepEqual(log, [
    ['lease', 'c1'],
    ['around', 'c1', 'input.click', { x: 3, y: 4 }],
    ['command', 'input.click'],
    ['around', 'c1', 'screenshot', {}],
    ['command', 'screenshot'],
    ['shot', 'c1', 'screenshot'],
  ]);
});

for (const changed of ['generation', 'epoch']) {
  test(`lease-loss retry cannot send input after ${changed} changes during reacquire`, async () => {
    let generation = 0;
    let epoch = 1;
    let leases = 0;
    let attempts = 0;
    let refuse = true;
    const helper = new RemoteHelper({
      appsOf: () => '*',
      idleSeconds: async () => 0,
      ownerEpoch: () => epoch,
      remote: {
        generation: () => generation,
        alive: () => true,
        lease: async () => {
          if (++leases === 2) {
            if (changed === 'generation') generation++;
            else epoch++;
          }
        },
        command: async () => {
          attempts++;
          if (refuse) throw new ToolError('lease lost', 'no_lease');
          return { ok: true };
        },
        release: async () => undefined,
        abort: async () => undefined,
        state: async () => ({ available: true }),
      },
    });
    const as = () => guarded({ token: { chat: 'c1', turn: 1 } }, () => helper.click(1, 1));
    await assert.rejects(as(), (error: any) => error.code === 'aborted');
    assert.equal(attempts, 1, 'the second desktop.call is never sent');
    refuse = false;
    await as();
    assert.equal(attempts, 2, 'a fresh action still works');
  });
}
