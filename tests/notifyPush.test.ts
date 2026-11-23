// The push-request hook next to notify.cjs: a banner the Mac would show becomes one fixed-kind request per paired phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chatRef } from '../shared/remote/ref.mjs';

const require = createRequire(import.meta.url);
const { Notifier } = require('../electron/platform/notify.cjs');
const { createPushRequests, pushKindOf } = require('../electron/platform/notifyPush.cjs');

function setup(
  opts: {
    mode?: string;
    kinds?: Record<string, boolean>;
    pairs?: string[];
    sink?: (r: any) => void;
    quiet?: boolean;
    focused?: boolean;
  } = {},
) {
  const reqs: any[] = [];
  const push = createPushRequests({
    pairs: () => opts.pairs ?? ['p1', 'p2'],
    getKinds: () => ({ turn: true, goal: true, ...opts.kinds }),
    sink: opts.sink ?? ((r: any) => reqs.push(r)),
  });
  const n = new Notifier({
    getMode: () => opts.mode ?? 'always',
    getKinds: () => opts.kinds ?? {},
    isFocused: () => opts.focused ?? false,
    show: () => ({ close() {} }),
    onBanner: push.onBanner,
  });
  if (opts.quiet) n.setQuiet(() => true);
  return { n, reqs, push };
}

test('pushKindOf maps each kind', () => {
  assert.equal(pushKindOf('momo', true), 'momoNeedsYou');
  assert.equal(pushKindOf('approval', true), 'needsYou');
  assert.equal(pushKindOf('turn', false), 'done');
  assert.equal(pushKindOf('goal', false), 'done');
  for (const k of ['scheduled', 'computer', 'momo', 'auth']) assert.equal(pushKindOf(k, false), null);
});

test('one request per pair with the chat ref and no content', () => {
  const { n, reqs } = setup();
  n.notify('turn', 'c1', { title: 'secret title', body: 'secret body' });
  assert.deepEqual(reqs, [
    { pair: 'p1', kind: 'done', ref: chatRef('p1', 'c1') },
    { pair: 'p2', kind: 'done', ref: chatRef('p2', 'c1') },
  ]);
  assert.ok(!JSON.stringify(reqs).includes('secret'));
});

test('needs-you and MoMo kinds push; kinds without a push do not', () => {
  const { n, reqs } = setup({ pairs: ['p'] });
  n.notify('approval', 'a', {});
  n.notify('momo', 'm', { status: 'needs' });
  n.notify('scheduled', 's', {});
  assert.deepEqual(
    reqs.map((r) => r.kind),
    ['needsYou', 'momoNeedsYou'],
  );
});

test('no push when the banner is suppressed', () => {
  for (const o of [{ mode: 'never' }, { kinds: { turn: false } }, { mode: 'unfocused', focused: true }, { quiet: true }]) {
    const { n, reqs } = setup(o);
    n.notify('turn', 'c', { viewing: true });
    assert.equal(reqs.length, 0, JSON.stringify(o));
  }
  const held = setup({ pairs: ['p'] });
  held.n.notify('approval', 'c', {});
  held.n.notify('turn', 'c', {});
  assert.equal(held.reqs.length, 1);
});

test('a throwing sink or onBanner breaks nothing', () => {
  const seen: string[] = [];
  const { n } = setup({
    sink: (r) => {
      seen.push(r.pair);
      throw new Error('x');
    },
  });
  assert.ok(n.notify('turn', 'c', {}));
  assert.deepEqual(seen, ['p1', 'p2']);
  const bad = new Notifier({
    getMode: () => 'always',
    show: () => ({ close() {} }),
    onBanner: () => {
      throw new Error('y');
    },
  });
  assert.ok(bad.notify('turn', 'c', {}));
});

test('machineOffline pushes per pair with an empty ref; no pairs, no requests', () => {
  const { push, reqs } = setup();
  push.machineOffline('p9');
  assert.deepEqual(reqs, [{ pair: 'p9', kind: 'machineOffline', ref: '' }]);
  const none = setup({ pairs: [] });
  none.n.notify('turn', 'c', {});
  assert.equal(none.reqs.length, 0);
});

test('the push hook gets the chat title only, never the banner text standing in for it', () => {
  const seen: any[] = [];
  const n = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), onBanner: (b: any) => seen.push(b) });
  n.notify('turn', 'a', { title: 'banner text', chatTitle: 'My chat' });
  n.notify('turn', 'b', { title: 'banner text only' });
  assert.deepEqual(
    seen.map((b) => b.chatTitle),
    ['My chat', ''],
  );
});
