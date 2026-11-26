// "By machine" when something fails (#5576 review): a failed read of which chats run where keeps the groups it has, a stale list on a machine that answers says so (not "offline"), and a machine with a thousand chats never draws a thousand rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reloadHostChats, resetHostChats } from '../src/lib/hostChats.ts';
import { calls, click, flush, mountSidebar, reset, thread } from './support/shell-sidebar-kit.ts';
import { act, group, rig, row } from './support/by-machine-rig.ts';

test('a read of which chats run where that fails after it answered keeps every group as it was', async (t) => {
  const r = rig(t, { rows: [row(1)] });
  resetHostChats();
  reset({ prefs: { sidebarOrganize: 'machine' }, threadOrder: ['mac1'], threads: { mac1: thread('mac1') } });
  const view = await mountSidebar();
  try {
    await flush();
    assert.ok(group(view, 'this-mac').querySelector('.thread-row'));
    r.failOwners = true;
    await act(async () => void (await reloadHostChats()));
    await flush();
    assert.equal(
      view.$$('.machine-group .empty-note').filter((e) => e.textContent === 'Loading…').length,
      0,
      'no group goes back to loading',
    );
    assert.ok(group(view, 'this-mac').querySelector('.thread-row'), "this Mac's own chat stays");
    assert.ok(group(view, 'ssh:box').querySelector('.machine-chat-row'));
  } finally {
    // the failed read is tried again on a timer: it ends with the test
    resetHostChats();
    await view.unmount();
  }
});

test('a list that is stale on a machine that answers says so, not that the machine is offline', async (t) => {
  const r = rig(t, { rows: [row(1)] });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    await act(async () => r.pushIndex([{ machineId: 'ssh:box', state: 'stale', truncated: false, rows: [row(1)] }]));
    await flush();
    const chat = group(view, 'ssh:box').querySelector('.machine-chat-row')!;
    assert.ok(chat.classList.contains('not-live'));
    assert.match(chat.getAttribute('aria-label')!, /list out of date/);
    const before = calls.length;
    await click(chat);
    const told = calls.slice(before).filter((c) => c[0] === 'toast');
    assert.match(told[0][1], /The list of chats on Build box is out of date\. It refreshes by itself/);
    assert.doesNotMatch(told[0][1], /offline/);
    assert.deepEqual(r.opened, []);
  } finally {
    await view.unmount();
  }
});

test('a group of a thousand chats draws a few hundred rows at most, however often Show more is pressed', async (t) => {
  rig(t, { rows: Array.from({ length: 1000 }, (_, i) => row(i + 1)) });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    const box = () => group(view, 'ssh:box');
    assert.equal(box().querySelectorAll('.machine-chat-row').length, 5, 'five at first');
    assert.equal(box().querySelector('.machine-note')?.textContent, "Older chats aren't listed");
    for (let i = 0; i < 60; i++) {
      const more = box().querySelector('.show-more');
      if (!more || /less/.test(more.textContent ?? '')) break;
      await click(more);
    }
    const drawn = box().querySelectorAll('.machine-chat-row').length;
    assert.ok(drawn <= 200, 'never more than the cap');
    assert.ok(drawn > 150, 'and most of it once asked for');
  } finally {
    await view.unmount();
  }
});
