// The sidebar's "By machine" view (#5576): one group per place chats run, each machine's chats from its Host's list (the Mac's index) beside the chats this Mac started there, five at first and Show more, the machine's menu and new chat, and each state of a machine's list as one line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byText, click, flush, key, mountSidebar, named, reset, thread } from './support/shell-sidebar-kit.ts';
import { OWN, act, group, offlineBox, rig, row, titles } from './support/by-machine-rig.ts';

test('By machine: this Mac and each machine are groups; a machine shows its newest five chats from its Host, then Show more', async (t) => {
  rig(t);
  reset({
    prefs: { sidebarOrganize: 'machine' },
    threadOrder: ['mac1', OWN],
    threads: { mac1: thread('mac1', { updatedAt: 50 }), [OWN]: thread(OWN, { updatedAt: 999_999 }) },
  });
  const view = await mountSidebar();
  try {
    await flush();
    assert.equal(byText(view.host, '.side-label', 'Machines').textContent?.trim(), 'Machines');
    assert.deepEqual(
      view.$$('.machine-group').map((g) => g.dataset.machineGroup),
      ['this-mac', 'ssh:box'],
    );
    assert.deepEqual(titles(group(view, 'this-mac')), ['Chat mac1']);
    assert.equal(group(view, 'this-mac').querySelector('.by-machine-dot'), null, 'this Mac has no dot');
    const box = group(view, 'ssh:box');
    assert.equal(box.querySelector('.by-machine-dot.on')?.getAttribute('aria-label'), 'Connected');
    // the Mac's own record of a chat on the machine leads (newest), then the Host's rows newest first
    assert.deepEqual(titles(box), ['Chat acp:host-claude:own', 'Machine chat 7', 'Machine chat 6', 'Machine chat 5', 'Machine chat 4']);
    await click(byText(box, '.show-more', 'Show 3 more'));
    assert.equal(titles(group(view, 'ssh:box')).length, 8, 'every chat is shown after Show more');
  } finally {
    await view.unmount();
  }
});

test('a machine row opens its chat through main into the one chat view', async (t) => {
  const r = rig(t, { rows: [row(1)] });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    await click(byText(group(view, 'ssh:box'), '.machine-chat-row .side-row-label', 'Machine chat 1').closest('.machine-chat-row')!);
    await flush();
    assert.deepEqual(r.opened, [['ssh:box', 'claude:c1']], 'the window names the machine and the chat; main knows the folder');
    assert.deepEqual(named('navigate').at(-1), [{ name: 'thread', id: 'acp:host-claude:c1' }]);
  } finally {
    await view.unmount();
  }
});

test('Enter on a machine row opens it as a click does, and a second press while it opens does nothing more', async (t) => {
  const r = rig(t, { rows: [row(1)] });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    const chat = group(view, 'ssh:box').querySelector('.machine-chat-row')!;
    await act(async () => {
      void key(chat, 'Enter');
      void key(chat, 'Enter');
    });
    await flush();
    assert.deepEqual(r.opened, [['ssh:box', 'claude:c1']]);
    assert.deepEqual(named('navigate').at(-1), [{ name: 'thread', id: 'acp:host-claude:c1' }]);
  } finally {
    await view.unmount();
  }
});

test('the machine heading: Edit machine… opens Settings › Connections › Control other devices; the new chat button starts a chat on it', async (t) => {
  rig(t, { rows: [] });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    const box = () => group(view, 'ssh:box');
    assert.equal(box().querySelector('.empty-note')?.textContent, 'No chats');
    await click(box().querySelector('[aria-label="Actions for Build box"]')!);
    await click(byText(box(), 'button[data-item]', 'Edit machine…'));
    assert.deepEqual(named('navigate').at(-1), [{ name: 'settings', section: 'connections', tab: 'other' }]);
    await click(box().querySelector('[aria-label="New chat on Build box"]')!);
    assert.deepEqual(named('pickNewChatHost').at(-1), [{ id: 'ssh:box', name: 'Build box' }]);
    assert.deepEqual(named('navigate').at(-1), [{ name: 'home' }]);
    await click(group(view, 'this-mac').querySelector('[aria-label="New chat on This Mac"]')!);
    assert.deepEqual(named('pickNewChatHost').at(-1), [{ id: 'local', name: 'This Mac' }]);
    assert.equal(group(view, 'this-mac').querySelector('[aria-label^="Actions for"]'), null, 'this Mac has no machine menu');
  } finally {
    await view.unmount();
  }
});

test('a running chat of a machine shows its dot, and each state of a list says one line', async (t) => {
  const r = rig(t, { rows: [row(1, 'running'), row(2, 'attention')] });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    const box = () => group(view, 'ssh:box');
    assert.ok(box().querySelector('.row-dot.working'));
    assert.ok(box().querySelector('.row-dot.waiting'));
    const say = async (state: string, rows: unknown[] = []) => {
      await act(async () => r.pushIndex([{ machineId: 'ssh:box', state, truncated: false, rows }]));
      await flush();
      return [...box().querySelectorAll('.empty-note')].map((e) => e.textContent);
    };
    assert.deepEqual(await say('loading'), ['Loading…']);
    assert.deepEqual(await say('failed'), ["Couldn't load its chats"]);
    assert.deepEqual(await say('unsupported'), ['Update its Host to list chats']);
    assert.deepEqual(await say('partial', [row(3)]), ['Some chats may be missing']);
    assert.deepEqual(await say('ready'), ['No chats']);
    await act(async () => r.pushIndex([{ machineId: 'ssh:box', state: 'ready', truncated: true, rows: [row(4)] }]));
    assert.deepEqual(
      [...box().querySelectorAll('.empty-note')].map((e) => e.textContent),
      ["Older chats aren't listed"],
    );
    await act(async () => r.pushIndex('not an index'));
    assert.deepEqual(
      [...box().querySelectorAll('.empty-note')].map((e) => e.textContent),
      ["Older chats aren't listed"],
      'an answer that is no list changes nothing',
    );
    await act(async () => r.pushMachines(offlineBox));
  } finally {
    await view.unmount();
  }
});
