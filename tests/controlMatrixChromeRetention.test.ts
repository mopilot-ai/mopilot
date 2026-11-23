// CM-Z24 ownership policy controls: shared turn cleanup keeps Chrome-owned tabs and still sweeps IAB scratch tabs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

export const GUARDS = ['electron/capabilities/', 'shared/'];

for (const keepTabsOnTurnEnd of [true, false]) {
  test(`CM-Z24: shared turn cleanup keeps wait and control retirement with keepTabsOnTurnEnd=${keepTabsOnTurnEnd}`, async (t) => {
    const h = setup(t);
    h.tabs.o.keepTabsOnTurnEnd = keepTabsOnTurnEnd;
    const first = await drive(t, h.tabs.create('c'));
    const last = await drive(t, h.tabs.create('c'));
    const orphan = await drive(t, h.tabs.create('c'));
    orphan.wc.destroy();
    const user = tabOf(h, 'tab_bbbbbb');
    const other = tabOf(h, 'tab_cccccc', 'other');
    other.created = true;
    await drive(t, h.tabs.ready(first, 'c'));
    await drive(t, h.tabs.ready(last, 'c'));
    const events: string[] = [];
    h.tabs.onTurnEnd((id: string) => events.push(`ended:${id}`));
    // a tab handed to the user is theirs past the turn end (#1834): the turn's cleanup leaves the hand-off
    h.tabs.requestSignin(user);
    first.dialogWaiters.add((answer: unknown) => events.push(`dialog:${answer}`));
    h.tabs.waiting.set('c pending', [() => events.push('wait:c')]);
    h.tabs.waiting.set('other pending', [() => events.push('wait:other')]);

    const out = await drive(t, h.tabs.turnEnded('c'));
    assert.deepEqual(events, ['ended:c', 'wait:c', 'dialog:null']);
    assert.ok(user.signin, 'the hand-off outlives the turn');
    assert.equal(h.tabs.turnsEnded.get('c'), 1);
    assert.equal(first.dialogWaiters.size, 0);
    assert.ok([first, last].every((tab) => tab.closed || !tab.wc.debugger.isAttached()));
    assert.equal(h.tabs.waiting.has('other pending'), true);
    assert.equal(h.tabs.byKey('other', other.id), other, 'another chat keeps its ownership');
    assert.equal(h.tabs.byKey('c', user.id), user, 'a user tab is never a scratch tab');
    if (keepTabsOnTurnEnd) {
      assert.deepEqual(out.closed, []);
      assert.deepEqual(out.kept.sort(), [first.id, last.id, user.id].sort());
      assert.deepEqual(h.log.close, []);
      assert.equal(h.tabs.chats.get('c').orphans.get(orphan.id), orphan);
      assert.equal(orphan.created, false);
      assert.ok([first, last].every((tab) => tab.openedByAgent && !tab.result));
      assert.equal(tabOf(h, orphan.id).openedByAgent, true, 'retention does not invent user provenance');
    } else {
      assert.deepEqual(out.closed.sort(), [first.id, orphan.id].sort());
      assert.deepEqual(out.kept.sort(), [last.id, user.id].sort());
      assert.equal(last.result, true, 'IAB still keeps its last-used result');
      assert.equal(h.tabs.chats.get('c').orphans.has(orphan.id), false);
    }
  });
}
