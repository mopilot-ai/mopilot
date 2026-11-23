// Native delivery failures retire only the failed banner's membership and priority holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { registerNotify, KINDS } = require('../electron/platform/notify.cjs');

function setup() {
  const made: Notification[] = [];
  const state = { failDuringShow: false, throwOnClose: false };
  class Notification extends EventEmitter {
    static isSupported = () => true;
    closed = 0;
    opts: any;
    constructor(opts: any) {
      super();
      this.opts = opts;
      made.push(this);
    }
    show() {
      if (state.failDuringShow) this.emit('failed', {}, 'Native delivery failed');
    }
    close() {
      this.closed++;
      if (state.throwOnClose) throw new Error('Native close failed');
    }
  }
  const handlers = new Map<string, any>();
  const clicks: string[] = [];
  const notifier = registerNotify(
    { handle: (channel: string, handler: any) => handlers.set(channel, handler) },
    { Notification, getMode: () => 'always', onClick: (id: string) => clicks.push(id) },
  );
  const call = (kind: string, chatId: string) => handlers.get('app:notify')({}, kind, chatId, { title: chatId, status: 'blocked' });
  return { made, state, clicks, notifier, call };
}

for (const kind of KINDS) {
  for (const synchronous of [false, true]) {
    test(`${kind} native delivery failure ${synchronous ? 'during' : 'after'} show releases holds and permits retry`, () => {
      const { made, state, clicks, notifier, call } = setup();
      state.failDuringShow = synchronous;
      call(kind, 'chat');
      if (!synchronous) made[0].emit('failed', {}, 'Native delivery failed');
      assert.equal(notifier.byChat.size, 0, 'a notification the OS could not show owns no hold');
      assert.equal(notifier.groups.size, 0);
      assert.deepEqual(clicks, [], 'delivery failure must not navigate');
      state.failDuringShow = false;
      call('turn', 'chat');
      assert.equal(made.length, 2, 'completion is not suppressed by the failed notice');
      call(kind, 'retry');
      assert.equal(made.length, 3, 'delivery can be retried');
    });
  }
}

test('a failed merged banner releases all members and cannot reappear in later merges', () => {
  const { made, notifier, call } = setup();
  call('approval', 'a');
  call('approval', 'b');
  made[1].emit('failed', {}, 'Merged delivery failed');
  assert.equal(notifier.byChat.size, 0);
  assert.equal(notifier.groups.size, 0);
  call('approval', 'c');
  assert.deepEqual(notifier.byChat.get('c').chats, ['c']);
  call('turn', 'a');
  call('turn', 'b');
  assert.equal(made.length, 5);
});

test('late failure of a replaced single or merged banner preserves the current banner and click route', () => {
  const { made, clicks, notifier, call } = setup();
  call('approval', 'a');
  call('approval', 'b');
  call('approval', 'c');
  const current = notifier.byChat.get('c');
  made[0].emit('failed', {}, 'Old single failed');
  made[1].emit('failed', {}, 'Old merged failed');
  for (const id of ['a', 'b', 'c']) assert.equal(notifier.byChat.get(id), current);
  assert.equal(made[2].closed, 0);
  call('turn', 'a');
  assert.equal(made.length, 3, 'a live approval still correctly suppresses lower priority');
  made[2].emit('click');
  assert.deepEqual(clicks, ['c']);
  assert.equal(notifier.byChat.size, 0);
});

test('a late failure after retraction cannot retire the refreshed remaining member', () => {
  const { made, notifier, call } = setup();
  call('approval', 'a');
  call('approval', 'b');
  notifier.retract('b');
  const current = notifier.byChat.get('a');
  made[1].emit('failed', {}, 'Retracted banner failed');
  assert.equal(notifier.byChat.get('a'), current);
  assert.equal(made[2].closed, 0);
  assert.equal(notifier.byChat.has('b'), false);
});

test('failure cleanup tolerates OS close rejection and duplicate failure events', () => {
  const { made, state, notifier, call } = setup();
  call('auth', 'a');
  state.throwOnClose = true;
  assert.doesNotThrow(() => made[0].emit('failed', {}, 'Failed'));
  assert.doesNotThrow(() => made[0].emit('failed', {}, 'Failed again'));
  assert.equal(notifier.byChat.size, 0);
  assert.equal(made[0].closed, 1);
  state.throwOnClose = false;
  call('turn', 'a');
  assert.equal(made.length, 2);
});

test('a synchronous failure replacing a merged banner discards the entire closed group', () => {
  const { made, state, notifier, call } = setup();
  call('approval', 'a');
  call('approval', 'b');
  state.failDuringShow = true;
  call('approval', 'c');
  assert.equal(notifier.byChat.size, 0);
  assert.equal(notifier.groups.size, 0);
  state.failDuringShow = false;
  call('approval', 'd');
  assert.deepEqual(notifier.byChat.get('d').chats, ['d']);
  assert.equal(made.length, 4);
});

test('native delivery failure is retained in diagnostics without surfacing as a chat click', () => {
  const { recentIgnored } = require('../electron/ignored.cjs');
  const { made, clicks, call } = setup();
  call('approval', 'a');
  made[0].emit('failed', {}, 'The native service rejected delivery');
  assert.ok(
    recentIgnored().some(
      (entry: any) => entry.context === 'deliver an OS notification' && entry.message === 'The native service rejected delivery',
    ),
  );
  assert.deepEqual(clicks, []);
});
