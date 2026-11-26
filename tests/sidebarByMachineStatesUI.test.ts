// "By machine" where the machine or the record is not what it seems (#5576 review): a chat gone from this Mac stays gone, nothing is drawn until it is known which chats run where, a machine that does not answer says so and where to fix it, and what was shown stays shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetHostChats } from '../src/lib/hostChats.ts';
import { deletionVisibility } from '../src/store/deletionVisibility.ts';
import { calls, click, flush, mountSidebar, named, reset, thread } from './support/shell-sidebar-kit.ts';
import { OWN, act, group, offlineBox, rig, row } from './support/by-machine-rig.ts';

test('a chat that is gone from this Mac does not come back as a row of the machine that still lists it', async (t) => {
  rig(t, { rows: [row(1), row(2)] });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    const box = () => group(view, 'ssh:box');
    assert.equal(box().querySelectorAll('.machine-chat-row').length, 2);
    await act(async () => {
      deletionVisibility.accept({
        chatId: 'acp:host-claude:c2',
        nativeDeleted: true,
        metadata: 'retained',
        nativeKeys: ['acp:host-claude:c2'],
      });
    });
    await flush();
    assert.deepEqual(
      [...box().querySelectorAll('.machine-chat-row .side-row-label')].map((e) => e.textContent),
      ['Machine chat 1'],
    );
  } finally {
    await view.unmount();
  }
});

test('a machine that does not answer: its rows look so, opening one says why and where to fix it, a new chat there does too, and main is not asked', async (t) => {
  const r = rig(t, { rows: [row(1, 'running')] });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    await act(async () => r.pushMachines(offlineBox));
    await flush();
    const box = () => group(view, 'ssh:box');
    const chat = box().querySelector('.machine-chat-row')!;
    assert.ok(chat.classList.contains('not-live'));
    assert.equal(chat.querySelector('.row-dot'), null, 'a state it said while it answered is not shown as live');
    assert.match(chat.getAttribute('aria-label')!, /Build box is offline/);
    const before = calls.length;
    await click(chat);
    await click(box().querySelector('[aria-label="New chat on Build box"]')!);
    const told = calls.slice(before).filter((c) => c[0] === 'toast');
    assert.equal(told.length, 2);
    assert.match(told[0][1], /Build box is offline\. Reconnect it to open this chat/);
    assert.match(told[1][1], /Build box is offline\. Reconnect it to start a chat there/);
    assert.equal(told[0][3].action.label, 'Edit machine');
    told[1][3].action.run();
    assert.deepEqual(named('navigate').at(-1), [{ name: 'settings', section: 'connections', tab: 'other' }]);
    assert.deepEqual(r.opened, [], 'main was not asked');
  } finally {
    await view.unmount();
  }
});

test('Show more stays shown when the group is folded and opened again; titles and names of the machine are isolated from the row around them', async (t) => {
  rig(t, { rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => row(n)) });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    const box = () => group(view, 'ssh:box');
    // five at first (the Mac's own chat is among them), then five more
    // (chat 2 is gone from this Mac by the first test: nine are listed)
    await click(box().querySelector('.show-more')!);
    const shown = box().querySelectorAll('.thread-row').length;
    assert.ok(shown > 5);
    await click(box().querySelector('.project-row')!);
    await click(box().querySelector('.project-row')!);
    assert.equal(box().querySelectorAll('.thread-row').length, shown, 'what was shown stays shown');
    assert.ok(box().querySelector('.machine-chat-row bdi'));
    assert.ok(box().querySelector('.project-row bdi'));
  } finally {
    await view.unmount();
  }
});

// last: its read of the owners never answers, and that read is shared by every test of this file
test('until it is known which chats run where, every group says it is loading and no chat is drawn under the wrong one', async (t) => {
  rig(t, { ownersPending: true });
  resetHostChats();
  reset({ prefs: { sidebarOrganize: 'machine' }, threadOrder: [OWN], threads: { [OWN]: thread(OWN) } });
  const view = await mountSidebar();
  try {
    await flush();
    assert.deepEqual(
      view.$$('.machine-group .empty-note').map((e) => e.textContent),
      ['Loading…', 'Loading…'],
    );
    assert.equal(view.$$('.thread-row').length, 0);
  } finally {
    await view.unmount();
  }
});
