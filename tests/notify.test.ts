// notify(kind, chatId) in electron/platform/notify.cjs: the Notifications setting, one per chat,
// "needs you" over "done", and merging within 60 seconds (#59).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { goalNotice } from '../src/lib/notify.ts';

const require = createRequire(import.meta.url);
const { Notifier, allowed, showNotice, KINDS, MERGE_MS } = require('../electron/platform/notify.cjs');

function setup(mode = 'unfocused', focused = false, kinds: Record<string, boolean> = {}) {
  let t = 1_000_000;
  const shown: any[] = [];
  const closed: string[] = [];
  const state = { mode, focused };
  const n = new Notifier({
    getMode: () => state.mode,
    getKinds: () => kinds,
    isFocused: () => state.focused,
    now: () => t,
    show: (x: any) => {
      shown.push(x);
      return { close: () => closed.push(x.id) };
    },
  });
  return { n, shown, closed, state, tick: (ms: number) => (t += ms) };
}

test('Never shows nothing, for every kind, and never reaches the OS', () => {
  const { n, shown } = setup('never');
  for (const kind of KINDS) {
    assert.equal(n.notify(kind, 'c1', { title: 't', body: 'b', status: 'blocked' }), null);
    assert.equal(n.notify(kind, 'c2', { title: 't', body: 'b', viewing: false }), null);
  }
  assert.equal(shown.length, 0);
});

test('a kind switched off never notifies; the others still do', () => {
  const { n, shown } = setup('always', false, { approval: false, scheduled: false });
  assert.equal(n.notify('approval', 'a', { title: 'x', body: 'y' }), null);
  assert.equal(n.notify('scheduled', 'b', { title: 'x', body: 'y' }), null);
  assert.ok(n.notify('turn', 'c', { title: 'x', body: 'y' }));
  assert.ok(n.notify('goal', 'd', { title: 'x', body: 'y', status: 'complete' }));
  assert.equal(shown.length, 2);
});

test('the setting applies to every kind, not only turn complete', () => {
  // When unfocused: hidden while the user looks at the chat in a focused window
  assert.equal(allowed('unfocused', true, true), false);
  assert.equal(allowed('unfocused', false, false), true);
  assert.equal(allowed('always', false, true), true);
  // Only when I'm needed: approval, authorization, a goal stopped short
  assert.equal(allowed('needed', false, false), false);
  assert.equal(allowed('needed', true, false), true);
  assert.equal(allowed('needed', true, true), false);
  // an unknown value behaves like the default
  assert.equal(allowed('bogus', false, false), true);

  const { n, shown } = setup('needed');
  n.notify('turn', 'a', { title: 'A', body: 'done' });
  n.notify('scheduled', 'b', { title: 'Scheduled task started', body: 'Daily' });
  n.notify('goal', 'c', { title: 'C', body: 'Goal complete', status: 'complete' });
  assert.equal(shown.length, 0);
  n.notify('approval', 'd', { title: 'Codex needs your approval', body: 'D' });
  n.notify('goal', 'e', { title: 'E', body: 'Goal blocked', status: 'blocked' });
  assert.deepEqual(
    shown.map((s) => s.chatId),
    ['d', 'e'],
  );
});

test('viewing only hides a notification while a window has focus', () => {
  const { n, shown, state } = setup('unfocused', true);
  n.notify('approval', 'a', { title: 'x', body: 'y', viewing: true });
  assert.equal(shown.length, 0);
  state.focused = false;
  n.notify('approval', 'a', { title: 'x', body: 'y', viewing: true });
  assert.equal(shown.length, 1);
});

test('one notification per chat: a new one replaces the old, under the same identifier', () => {
  const { n, shown, closed, tick } = setup();
  n.notify('turn', 'a', { title: 'A', body: 'first' });
  tick(MERGE_MS + 1);
  n.notify('turn', 'a', { title: 'A', body: 'second' });
  assert.equal(shown.length, 2);
  assert.equal(shown[0].id, shown[1].id);
  assert.equal(shown[1].groupId, 'a');
  assert.deepEqual(closed, [shown[0].id]);
});

test('"needs you" outranks "done" for the same chat; a click lets the next one through', () => {
  const { n, shown, tick } = setup();
  n.notify('goal', 'a', { title: 'A', body: 'Goal paused · Budget reached', status: 'budgetLimited' });
  tick(1000);
  assert.equal(n.notify('turn', 'a', { title: 'A', body: 'Task complete' }), null, 'the turn the pause ended does not hide it');
  assert.ok(n.notify('approval', 'a', { title: 'Codex needs your approval', body: 'A' }), 'another "needs you" replaces it');
  n.clear('a');
  assert.ok(n.notify('turn', 'a', { title: 'A', body: 'Task complete' }));
  assert.equal(shown.length, 3);
});

test('same-kind notifications from different chats within 60s merge into one', () => {
  const { n, shown, closed, tick } = setup();
  n.notify('approval', 'a', { title: 'Codex needs your approval', body: 'A', chatTitle: 'Alpha' });
  tick(10_000);
  n.notify('approval', 'b', { title: 'Claude needs your approval', body: 'B', chatTitle: 'Beta' });
  tick(10_000);
  const r = n.notify('approval', 'c', { title: 'Codex needs your approval', body: 'C', chatTitle: 'Gamma' });
  assert.equal(r.title, '3 chats need you');
  assert.equal(r.body, 'Gamma, Beta, Alpha');
  assert.deepEqual(r.chats.sort(), ['a', 'b', 'c']);
  // the first single and the first merged one were taken down
  assert.deepEqual(closed, ['chat:a', 'merged:approval:needs']);
  assert.equal(shown.at(-1).id, 'merged:approval:needs');

  // a different kind does not merge with them
  assert.equal(n.notify('turn', 'd', { title: 'Delta', body: 'done' })!.title, 'Delta');
  // and after 60 quiet seconds a new one stands alone
  tick(MERGE_MS + 1);
  assert.equal(n.notify('approval', 'e', { title: 'Codex needs your approval', body: 'E' })!.title, 'Codex needs your approval');
});

test('merged titles for done kinds', () => {
  const { n } = setup();
  n.notify('turn', 'a', { title: 'A', body: '' });
  assert.equal(n.notify('turn', 'b', { title: 'B', body: '' })!.title, '2 chats finished');
  n.notify('scheduled', 'c', { title: 'Scheduled task started', body: 'x' });
  assert.equal(n.notify('scheduled', 'd', { title: 'Scheduled task started', body: 'y' })!.title, '2 scheduled tasks started');
});

test('unknown kinds and missing chats are ignored', () => {
  const { n, shown } = setup('always');
  assert.equal(n.notify('bogus', 'a', { title: 'x', body: 'y' }), null);
  assert.equal(n.notify('turn', '', { title: 'x', body: 'y' }), null);
  assert.equal(shown.length, 0);
});

test('a pull request never interrupts the user: only a session question does (#3661)', () => {
  const { n, shown } = setup('always', false, { pr: true });
  assert.equal(KINDS.includes('pr'), false);
  assert.equal(n.notify('pr', 'a', { title: '#1 needs you', body: 'Ready to merge' }), null);
  assert.equal(shown.length, 0);
});

test('goal notifications: only when a running goal finishes or stops short', () => {
  const g = (status: any) =>
    ({ threadId: 't', objective: 'o', status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 }) as any;
  assert.deepEqual(goalNotice(g('active'), g('complete')), { status: 'complete', body: 'Goal complete' });
  assert.equal(goalNotice(g('active'), g('budgetLimited'))!.body, 'Goal paused · Budget reached');
  assert.equal(goalNotice(g('active'), g('blocked'))!.status, 'blocked');
  assert.equal(goalNotice(g('active'), g('paused')), null, 'a pause the user asked for');
  assert.equal(goalNotice(g('paused'), g('complete')), null);
  assert.equal(goalNotice(undefined, g('active')), null);
  assert.equal(goalNotice(g('active'), null), null);
});

test('a notice the person asked for follows the Notifications setting and waits for no one while a chat holds the screen', () => {
  const shown: unknown[] = [];
  let mode = 'unfocused';
  const n = new Notifier({ show: () => null, getMode: () => mode, showNotice: (x: unknown) => void shown.push(x) });
  n.notice({ title: 'MoPilot', body: 'Recording' });
  assert.deepEqual(shown, [{ title: 'MoPilot', body: 'Recording' }]);
  // Never: nothing
  mode = 'never';
  n.notice({ title: 'MoPilot', body: 'not shown' });
  // a chat controlling the screen: dropped, not shown when it lets go
  mode = 'always';
  n.hold(true);
  n.notice({ title: 'MoPilot', body: 'not shown either' });
  n.hold(false);
  assert.equal(shown.length, 1);
  // without a way to show one, a notice is nothing
  assert.doesNotThrow(() => new Notifier({ show: () => null, getMode: () => 'always' }).notice({ title: 'a', body: 'b' }));
});

test('a notice the person asked for shows where notifications are supported, and a failure never throws', () => {
  const shown: unknown[] = [];
  let supported = true;
  let fails = false;
  class Fake {
    static isSupported = () => supported;
    o: unknown;
    constructor(o: unknown) {
      this.o = o;
    }
    show() {
      if (fails) throw new Error('no banner');
      shown.push(this.o);
    }
  }
  showNotice({ Notification: Fake }, { title: 'MoPilot', body: 'Recording' });
  assert.deepEqual(shown, [{ title: 'MoPilot', body: 'Recording' }]);
  supported = false;
  showNotice({ Notification: Fake }, { title: 'MoPilot', body: 'not shown' });
  supported = true;
  fails = true;
  assert.doesNotThrow(() => showNotice({ Notification: Fake }, { title: 'MoPilot', body: 'fails' }));
  assert.equal(shown.length, 1);
});

test('an answered approval no longer holds back the chat\'s "done" notification', () => {
  const { n, shown, closed, tick } = setup('always');
  n.notify('approval', 'c1', { title: 'needs you', body: '' });
  tick(1000);
  assert.equal(n.notify('turn', 'c1', { title: 'done', body: '' }), null);
  n.retract('c1');
  assert.deepEqual(closed, ['chat:c1']);
  assert.equal(n.notify('turn', 'c1', { title: 'done', body: '' })?.title, 'done');
  assert.equal(shown.length, 2);
  // only an approval is retracted: a paused goal that needs the user keeps holding
  n.notify('goal', 'c2', { title: 'paused', body: '', status: 'blocked' });
  n.retract('c2');
  assert.equal(n.notify('turn', 'c2', { title: 'done', body: '' }), null);
});

test('answered approvals leave the visible merge and do not return in later notifications', () => {
  const { n, shown, closed } = setup('always');
  n.notify('approval', 'a', { title: 'Alpha needs approval', body: 'A', chatTitle: 'Alpha' });
  n.notify('approval', 'b', { title: 'Beta needs approval', body: 'B', chatTitle: 'Beta' });
  n.retract('a');
  assert.equal(shown.at(-1).title, 'Beta needs approval');
  assert.equal(shown.at(-1).body, 'B');
  assert.equal(shown.at(-1).chatId, 'b');
  const result = n.notify('approval', 'c', { title: 'Gamma needs approval', body: 'C', chatTitle: 'Gamma' });
  assert.deepEqual(result.chats, ['b', 'c']);
  assert.equal(result.title, '2 chats need you');
  assert.equal(result.body, 'Gamma, Beta');
  n.retract('b');
  n.retract('c');
  assert.equal(closed.at(-1), 'chat:c');
  assert.equal(n.byChat.size, 0);
  assert.equal(n.groups.size, 0);
});

test('clicking a merged notification removes its membership from later merges', () => {
  const { n } = setup('always');
  n.notify('approval', 'a', { title: 'Alpha' });
  n.notify('approval', 'b', { title: 'Beta' });
  n.clear('b');
  const result = n.notify('approval', 'c', { title: 'Gamma' });
  assert.deepEqual(result.chats, ['c']);
  assert.equal(result.title, 'Gamma');
});

test('refreshing a member of the same group emits one replacement and retains the other members', () => {
  const { n, shown } = setup('always');
  n.notify('approval', 'a', { title: 'Alpha', chatTitle: 'Alpha' });
  n.notify('approval', 'b', { title: 'Beta', chatTitle: 'Beta' });
  const result = n.notify('approval', 'a', { title: 'Alpha again', chatTitle: 'Alpha again' });
  assert.equal(shown.length, 3);
  assert.deepEqual(result.chats, ['b', 'a']);
  assert.equal(result.body, 'Alpha again, Beta');
});

test('removing the latest approval refreshes the merged count and targets a remaining chat', () => {
  const { n, shown } = setup('always');
  for (const id of ['a', 'b', 'c']) n.notify('approval', id, { title: id, chatTitle: id });
  n.retract('c');
  assert.equal(shown.at(-1).title, '2 chats need you');
  assert.equal(shown.at(-1).body, 'b, a');
  assert.equal(shown.at(-1).chatId, 'b');
});

test('removing or clicking an expired group preserves a newer group of the same kind', () => {
  for (const clicked of [false, true]) {
    const { n, tick } = setup('always');
    n.notify('approval', 'a', { title: 'Alpha' });
    n.notify('approval', 'b', { title: 'Beta' });
    tick(MERGE_MS + 1);
    n.notify('approval', 'c', { title: 'Gamma' });
    if (clicked) n.clear('a');
    else {
      n.retract('a');
      n.retract('b');
    }
    const result = n.notify('approval', 'd', { title: 'Delta' });
    assert.deepEqual(result.chats, ['c', 'd']);
  }
});

for (const kind of KINDS) {
  test(`${kind} merged notification text keeps surrogate pairs within its existing budget`, () => {
    for (const [title, expected] of [
      ['x'.repeat(179) + '🙂tail', 'x'.repeat(179)],
      ['x'.repeat(178) + '🙂tail', 'x'.repeat(178) + '🙂'],
      ['x'.repeat(181), 'x'.repeat(180)],
    ]) {
      const { n, shown } = setup('always');
      n.notify(kind, 'a', { chatTitle: 'Older chat', status: 'blocked' });
      const result = n.notify(kind, 'b', { chatTitle: title, status: 'blocked' });
      assert.equal(result.body, expected);
      assert.equal(result.body.isWellFormed(), true);
      assert.ok(result.body.length <= 180);
      assert.equal(shown.at(-1).body, expected, 'the OS receives the intact bounded text');
      assert.equal(n.groups.values().next().value.chats.get('b').chatTitle, title, 'only presentation is truncated');
    }
  });
}

for (const kind of KINDS) {
  test(`${kind} OS show failures return no notification and permit retry`, () => {
    const { n, shown } = setup('always');
    const show = n.show;
    n.show = () => {
      throw new Error('OS notification unavailable');
    };
    assert.equal(n.notify(kind, 'chat', { title: 'Notice', status: 'blocked' }), null);
    assert.equal(n.byChat.has('chat'), false, 'failed show does not reserve a priority hold');
    n.show = show;
    assert.ok(n.notify(kind, 'chat', { title: 'Notice', status: 'blocked' }));
    assert.equal(shown.length, 1);
  });
}

test('OS close failures cannot prevent clearing, replacement, or approval retraction', () => {
  const { n, shown } = setup('always');
  n.show = (notice: any) => {
    shown.push(notice);
    return {
      close() {
        throw new Error('OS notification close failed');
      },
    };
  };
  n.notify('approval', 'chat', {});
  n.clear('chat');
  assert.equal(n.byChat.has('chat'), false);
  assert.equal(n.groups.size, 0);
  n.notify('turn', 'chat', {});
  assert.ok(n.notify('turn', 'chat', { title: 'Replacement' }));
  n.notify('approval', 'other', {});
  n.retract('other');
  assert.equal(n.byChat.has('other'), false);
  assert.ok(n.notify('approval', 'a', {}));
  assert.ok(n.notify('approval', 'b', {}));
  n.retract('a');
  assert.equal(n.byChat.has('a'), false);
  assert.equal(n.byChat.has('b'), true);
});

test('a failed merged replacement releases closed holds and cannot include an answered approval on retry', () => {
  const { n, shown, closed } = setup('always');
  const show = n.show;
  n.notify('approval', 'a', { title: 'A' });
  n.show = () => {
    throw new Error('merged show failed');
  };
  assert.equal(n.notify('approval', 'b', { title: 'B' }), null);
  assert.equal(n.byChat.size, 0);
  assert.equal(n.groups.size, 0);
  assert.deepEqual(closed, ['chat:a']);
  n.retract('b');
  n.show = show;
  assert.deepEqual(n.notify('approval', 'c', { title: 'C' }).chats, ['c']);
  assert.ok(n.notify('turn', 'a', { title: 'Done' }), 'the closed approval holds no priority');
  assert.equal(shown.length, 3);
});

test('dismissal during a failed replacement safely clears the group once', () => {
  const { n } = setup('always');
  n.notify('approval', 'a', {});
  n.show = () => {
    n.clear('a');
    throw new Error('replacement dismissed before showing');
  };
  assert.equal(n.notify('approval', 'b', {}), null);
  assert.equal(n.byChat.size, 0);
  assert.equal(n.groups.size, 0);
});

for (const kind of KINDS) {
  test(`${kind} expired groups refresh their remaining members when a chat joins a fresh group`, () => {
    const { n, shown, tick } = setup('always');
    for (const chat of ['a', 'b', 'c']) n.notify(kind, chat, { chatTitle: chat.toUpperCase(), status: 'blocked' });
    tick(MERGE_MS + 1);
    n.notify(kind, 'd', { chatTitle: 'D', status: 'blocked' });
    const before = shown.length;
    n.notify(kind, 'a', { chatTitle: 'A new', status: 'blocked' });
    assert.deepEqual(n.byChat.get('b').chats, ['b', 'c'], 'the old banner must no longer contain moved chat a');
    assert.deepEqual(n.byChat.get('a').chats, ['d', 'a']);
    assert.equal(shown.length, before + 2, 'the remaining old group and the fresh group both render');
    assert.equal(shown.at(-2).body, 'C, B');
    n.clear('b');
    assert.equal(n.byChat.has('c'), false);
    assert.equal(n.byChat.has('a'), true, 'clearing the expired group preserves the fresh group');
    assert.equal(n.byChat.has('d'), true);
  });
}

test('a failed expired-group refresh cannot discard the newer group at the same key', () => {
  const { n, tick } = setup('always');
  for (const chat of ['a', 'b', 'c']) n.notify('approval', chat, { chatTitle: chat });
  tick(MERGE_MS + 1);
  n.notify('approval', 'd', { chatTitle: 'd' });
  const show = n.show;
  n.show = (notice: any) => {
    if (notice.chatId === 'c') throw new Error('old group refresh failed');
    return show(notice);
  };
  assert.deepEqual(n.notify('approval', 'a', { chatTitle: 'a new' }).chats, ['d', 'a']);
  assert.equal(n.byChat.has('b'), false);
  assert.equal(n.byChat.has('c'), false);
  assert.equal(n.byChat.has('d'), true);
  assert.equal(n.byChat.has('a'), true);
  assert.equal(n.groups.size, 1);
});

test('while a chat controls the whole screen only approvals show (a banner would take its clicks); letting go shows what waited', () => {
  const { n, shown } = setup('always');
  n.hold(true);
  n.hold(true);
  assert.equal(n.notify('turn', 'c1', { title: 'first' }), null);
  n.notify('turn', 'c1', { title: 'latest' }); // the latest per kind and chat
  assert.notEqual(n.notify('approval', 'c2', { title: 'asks' }), null, 'a person must answer it: never held');
  n.notify('goal', 'c4', { title: 'opened meanwhile', status: 'complete' });
  n.clear('c4'); // the chat was opened while held
  n.clear('c1', { close() {} }); // a handle-specific clear is about a shown banner, not a waiting one
  assert.deepEqual(
    shown.map((x: any) => x.title),
    ['asks'],
  );
  n.hold(false);
  assert.deepEqual(
    shown.map((x: any) => x.title),
    ['asks', 'latest'],
  );
  n.hold(false); // not holding: nothing more
  assert.equal(shown.length, 2);
  assert.notEqual(n.notify('turn', 'c5', { title: 'now' }), null, 'shown again once released');
});
