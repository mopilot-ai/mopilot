// The "working in" stack's pictures in main: a thumbnail (or the opened card's larger live view) at most once a second, only with Screen Recording already granted, the app's icon, and bringing the app forward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkingInViews, openWith, THUMB_EVERY_MS, PERMISSION_TTL_MS, THUMB_SIDES } = require('../electron/capabilities/workingInViews.cjs');

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

function rig(o: any = {}) {
  let now = 1000;
  const calls: any[] = [];
  const helper = {
    permissionStatus: async () => {
      calls.push(['permissions']);
      if (o.permThrows) throw new Error('down');
      return { screenRecording: o.screen ?? true };
    },
    resolveApps: async (q: string[]) => {
      calls.push(['resolve', q]);
      return 'resolved' in o
        ? o.resolved
        : { apps: [{ query: q[0], app: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', running: true, pid: 42 } }] };
    },
    call: async (method: string, params: any, opts: any) => {
      calls.push([method, params, opts]);
      if (o.shotThrows) throw new Error('nope');
      return 'shot' in o ? o.shot : { jpeg: 'SlBH', mimeType: 'image/jpeg' };
    },
  };
  const opened: any[] = [];
  const v = new WorkingInViews({
    helper,
    enabled: () => o.enabled ?? true,
    now: () => now,
    open: async (args: string[]) => {
      if (o.openThrows) throw new Error('no app');
      opened.push(args);
    },
  });
  return { v, helper, calls, opened, tick: (ms: number) => (now += ms) };
}

test('thumbnail: a small capture of the app through the helper, at most one a second per chat and app', async () => {
  const r = rig();
  const a = await r.v.thumbnail('c1', 'TextEdit');
  assert.deepEqual(a, { thumbnail: 'data:image/jpeg;base64,SlBH', bundleId: 'com.apple.TextEdit' });
  const shot = r.calls.find((c) => c[0] === 'app.screenshot');
  assert.deepEqual(shot[1], {
    pid: 42,
    bundleIds: ['com.apple.TextEdit'],
    maxSide: 360,
    maxPixels: 360 * 360,
    scale: 1,
    format: 'jpeg',
    quality: 0.6,
    tree: false,
  });
  assert.equal(shot[2].timeoutMs, 8000);
  // sooner than a second: the last answer, no new capture
  r.tick(THUMB_EVERY_MS - 1);
  assert.equal(await r.v.thumbnail('c1', 'textedit'), a);
  assert.equal(r.calls.filter((c) => c[0] === 'app.screenshot').length, 1);
  // another chat, or a second later: a new capture (the permission answer is still trusted)
  await r.v.thumbnail('c2', 'TextEdit');
  r.tick(1);
  await r.v.thumbnail('c1', 'TextEdit');
  assert.equal(r.calls.filter((c) => c[0] === 'app.screenshot').length, 3);
  assert.equal(r.calls.filter((c) => c[0] === 'permissions').length, 1);
  r.tick(PERMISSION_TTL_MS);
  await r.v.thumbnail('c1', 'TextEdit');
  assert.equal(r.calls.filter((c) => c[0] === 'permissions').length, 2);
  // forgetting the chat drops its throttle
  r.v.forget('c1');
  r.v.forget('nobody');
  await r.v.thumbnail('c1', 'TextEdit');
  assert.equal(r.calls.filter((c) => c[0] === 'app.screenshot').length, 5);
});

test('thumbnail: the opened live view is a larger capture with its own once-a-second throttle (#2045)', async () => {
  const r = rig();
  const shots = () => r.calls.filter((c) => c[0] === 'app.screenshot');
  await r.v.thumbnail('c1', 'TextEdit', 't1', 'large');
  assert.equal(shots()[0][1].maxSide, THUMB_SIDES.large);
  assert.equal(shots()[0][1].maxPixels, THUMB_SIDES.large * THUMB_SIDES.large);
  // the card's thumbnail inside the same second is its own capture, at the card's size
  await r.v.thumbnail('c1', 'TextEdit', 't1', 'card');
  assert.equal(shots()[1][1].maxSide, THUMB_SIDES.card);
  // within the second each size answers from its own cache; an unknown size is the card's
  r.tick(THUMB_EVERY_MS - 1);
  await r.v.thumbnail('c1', 'TextEdit', 't1', 'large');
  await r.v.thumbnail('c1', 'TextEdit', 't1', 'huge');
  assert.equal(shots().length, 2);
  // at the second's end: a new capture per size
  r.tick(1);
  await r.v.thumbnail('c1', 'TextEdit', 't1', 'large');
  assert.equal(shots().length, 3);
  assert.equal(shots()[2][1].maxSide, THUMB_SIDES.large);
});

test('thumbnail: a card capture and a large one in flight together each settle with their own picture, in either order', async () => {
  for (const order of [
    ['card', 'large'],
    ['large', 'card'],
  ]) {
    const r = rig();
    const answers = new Map<number, (v: any) => void>();
    (r.helper as any).call = (_m: string, params: any) => new Promise((resolve) => answers.set(params.maxSide, resolve));
    const card = r.v.thumbnail('c', 'TextEdit', 't', 'card');
    const large = r.v.thumbnail('c', 'TextEdit', 't', 'large');
    await nextTask();
    await nextTask();
    for (const size of order) answers.get(THUMB_SIDES[size])!({ jpeg: size.toUpperCase() });
    assert.equal((await card).thumbnail, 'data:image/jpeg;base64,CARD');
    assert.equal((await large).thumbnail, 'data:image/jpeg;base64,LARGE');
    // while each is cached, a repeat call gets that size's own answer
    assert.equal((await r.v.thumbnail('c', 'TextEdit', 't', 'large')).thumbnail, 'data:image/jpeg;base64,LARGE');
  }
});

test('the IPC passes the requested size through', async () => {
  const r = rig();
  const handlers = new Map<string, (...a: any[]) => any>();
  r.v.handle({ handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) });
  await handlers.get('computer:workingThumb')!({}, 'c', 'TextEdit', 't', 'large');
  assert.equal(r.calls.find((c) => c[0] === 'app.screenshot')[1].maxSide, THUMB_SIDES.large);
});

test('thumbnail: never without computer use or Screen Recording already granted, and never a prompt', async () => {
  const none = { thumbnail: null, bundleId: null };
  const off = rig({ enabled: false });
  assert.deepEqual(await off.v.thumbnail('c', 'TextEdit'), none);
  assert.deepEqual(off.calls, []);
  const denied = rig({ screen: false });
  assert.deepEqual(await denied.v.thumbnail('c', 'TextEdit'), none);
  assert.deepEqual(denied.calls, [['permissions']], 'asked for the status only: no request, no capture');
  const down = rig({ permThrows: true });
  assert.deepEqual(await down.v.thumbnail('c', 'TextEdit'), none);
  assert.deepEqual(await rig().v.thumbnail('c', ''), none);
  assert.deepEqual(await rig().v.thumbnail('c', 5), none);
});

test('thumbnail: an app not running, not found, a capture that fails or brings back no image', async () => {
  const idle = rig({ resolved: { apps: [{ app: { bundleId: 'com.apple.Mail', running: false } }] } });
  assert.deepEqual(await idle.v.thumbnail('c', 'Mail'), { thumbnail: null, bundleId: 'com.apple.Mail' });
  assert.deepEqual(await rig({ resolved: { apps: [{ app: null }] } }).v.thumbnail('c', 'Nope'), { thumbnail: null, bundleId: null });
  assert.deepEqual(await rig({ resolved: null }).v.thumbnail('c', 'Nope'), { thumbnail: null, bundleId: null });
  assert.deepEqual(await rig({ shotThrows: true }).v.thumbnail('c', 'TextEdit'), { thumbnail: null, bundleId: null });
  assert.deepEqual(await rig({ shot: {} }).v.thumbnail('c', 'TextEdit'), { thumbnail: null, bundleId: 'com.apple.TextEdit' });
  assert.deepEqual(await rig({ shot: null }).v.thumbnail('c', 'TextEdit'), { thumbnail: null, bundleId: 'com.apple.TextEdit' });
  assert.deepEqual(await rig({ shot: { thumb: 'UE5H', mimeType: 'image/png' } }).v.thumbnail('c', 'TextEdit'), {
    thumbnail: 'data:image/png;base64,UE5H',
    bundleId: 'com.apple.TextEdit',
  });
  assert.equal((await rig({ shot: { jpeg: 'QQ' } }).v.thumbnail('c', 'TextEdit')).thumbnail, 'data:image/jpeg;base64,QQ');
});

test('bringToFront: by bundle id when known, else by name; false when there is nothing to open or it fails', async () => {
  const r = rig();
  assert.equal(await r.v.bringToFront('TextEdit', 'com.apple.TextEdit'), true);
  assert.equal(await r.v.bringToFront('TextEdit', null), true);
  assert.equal(await r.v.bringToFront('', ''), false);
  assert.equal(await r.v.bringToFront(null, undefined), false);
  assert.deepEqual(r.opened, [
    ['-b', 'com.apple.TextEdit'],
    ['-a', 'TextEdit'],
  ]);
  assert.equal(await rig({ openThrows: true }).v.bringToFront('TextEdit', null), false);
});

test('pillWho: the agent ("The agent" when none is known) and whether the person took over; no app lookup', async () => {
  const { v, calls } = rig();
  assert.deepEqual(await v.pillWho('Claude'), { agent: 'Claude', paused: false });
  assert.deepEqual(await v.pillWho(null, true), { agent: 'The agent', paused: true });
  assert.deepEqual(await v.pillWho(''), { agent: 'The agent', paused: false });
  assert.deepEqual(calls, []);
});

test('defaults: the clock and /usr/bin/open (an unknown bundle id fails without opening anything)', async () => {
  const v = new WorkingInViews({ helper: {}, enabled: () => false });
  assert.equal(typeof v.now(), 'number');
  assert.equal(await v.bringToFront('x', 'invalid.bundle.id.mopilot-test-7f3c'), false);
});

test('openWith: runs /usr/bin/open and settles with its result', async () => {
  const ran: any[] = [];
  await openWith(['-a', 'TextEdit'], (file: string, args: string[], cb: (e: Error | null) => void) => (ran.push([file, args]), cb(null)));
  assert.deepEqual(ran, [['/usr/bin/open', ['-a', 'TextEdit']]]);
  await assert.rejects(
    openWith(['-a', 'x'], (_f: string, _a: string[], cb: (e: Error | null) => void) => cb(new Error('no'))),
    /no/,
  );
});

const noThumbnail = { thumbnail: null, bundleId: null };

for (const boundary of ['permissionStatus', 'resolveApps', 'call'] as const) {
  for (const retirement of ['disable', 'forget'] as const) {
    test(`thumbnail retires ${retirement} while ${boundary} waits`, async () => {
      const options = { enabled: true };
      const r = rig(options);
      let answer!: (value: any) => void;
      (r.helper as any)[boundary] = () =>
        new Promise((resolve) => {
          answer = resolve;
        });
      const old = r.v.thumbnail('chat', 'TextEdit');
      await nextTask();
      assert.equal(typeof answer, 'function');
      if (retirement === 'disable') options.enabled = false;
      else if (retirement === 'forget') r.v.forget('chat');
      answer(
        boundary === 'permissionStatus'
          ? { screenRecording: true }
          : boundary === 'resolveApps'
            ? { apps: [{ app: { bundleId: 'com.apple.TextEdit', running: true, pid: 42 } }] }
            : { jpeg: 'OLD' },
      );
      assert.deepEqual(await old, noThumbnail);
      if (boundary !== 'call') assert.equal(r.calls.filter((call) => call[0] === 'app.screenshot').length, 0);
    });
  }
}

test('turning computer use off prevents cached thumbnails from being returned', async () => {
  const options = { enabled: true };
  const r = rig(options);
  assert.ok((await r.v.thumbnail('chat', 'TextEdit')).thumbnail);
  options.enabled = false;
  assert.deepEqual(await r.v.thumbnail('chat', 'TextEdit'), noThumbnail);
});

for (const boundary of ['permissionStatus', 'resolveApps', 'call'] as const) {
  test(`thumbnail coalesces slow ${boundary} across polling deadlines`, async () => {
    const r = rig();
    let answer!: (value: any) => void;
    (r.helper as any)[boundary] = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const first = r.v.thumbnail('chat', 'TextEdit');
    await nextTask();
    r.tick(THUMB_EVERY_MS * 3);
    const repeat = r.v.thumbnail('chat', 'TextEdit');
    assert.equal(repeat, first);
    answer(
      boundary === 'permissionStatus'
        ? { screenRecording: true }
        : boundary === 'resolveApps'
          ? { apps: [{ app: { bundleId: 'com.apple.TextEdit', running: true, pid: 42 } }] }
          : { jpeg: 'SLOW' },
    );
    assert.ok((await first).thumbnail);
  });
}

test('permission probes are shared until they settle and cache from completion time', async () => {
  const r = rig();
  const answers: ((value: any) => void)[] = [];
  r.helper.permissionStatus = () => new Promise((resolve) => answers.push(resolve));
  const first = r.v.screenGranted();
  const second = r.v.screenGranted();
  await nextTask();
  const probes = answers.length;
  r.tick(PERMISSION_TTL_MS * 2);
  answers.forEach((answer) => answer({ screenRecording: true }));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(probes, 1);
  assert.equal(await r.v.screenGranted(), true);
  assert.equal(answers.length, 1);
});

test('clearing a queued permission probe prevents the retired helper call from starting', async () => {
  const r = rig();
  const pending = r.v.screenGranted();
  r.v.clear();
  assert.equal(await pending, false);
  assert.deepEqual(r.calls, []);
});

test('thumbnail caches and forgetting use exact chat and app identities', async () => {
  const r = rig();
  const first = r.v.thumbnail('opaque', 'part\0Notes');
  const second = r.v.thumbnail('opaque\0part', 'Notes');
  assert.notEqual(first, second);
  await Promise.all([first, second]);
  r.v.forget('opaque');
  assert.equal(r.v.thumbnail('opaque\0part', 'Notes'), second);
  assert.notEqual(r.v.thumbnail('opaque', 'part\0Notes'), first);
});

test('capture retirement preserves another opaque chat owner while both helper replies are pending', async () => {
  const r = rig();
  const answers: ((value: any) => void)[] = [];
  r.helper.call = () => new Promise((resolve) => answers.push(resolve));
  const first = r.v.thumbnail('opaque', 'part\0Notes', 'turn');
  const second = r.v.thumbnail('opaque\0part', 'Notes', 'turn');
  await nextTask();
  assert.equal(answers.length, 2);
  r.v.forget('opaque');
  answers[0]({ jpeg: 'OLD' });
  answers[1]({ jpeg: 'CURRENT' });
  assert.deepEqual(await first, noThumbnail);
  assert.equal((await second).thumbnail, 'data:image/jpeg;base64,CURRENT');
  assert.equal(r.v.thumbnail('opaque\0part', 'Notes', 'turn'), second);
});

test('a permission read that fails decides nothing: it is not kept as "not granted", and the next thumbnail asks again (#1531)', async () => {
  const o: any = { permThrows: true };
  const r = rig(o);
  assert.equal(await r.v.screenGranted(), false);
  o.permThrows = false;
  // well within the cache window: a granted Screen Recording is seen at once
  r.tick(1);
  assert.ok((await r.v.thumbnail('c', 'TextEdit')).thumbnail);
  assert.equal(r.calls.filter((c) => c[0] === 'permissions').length, 2);
  // an answer the helper gave is kept as before
  assert.equal(await r.v.screenGranted(), true);
  assert.equal(r.calls.filter((c) => c[0] === 'permissions').length, 2);
});
