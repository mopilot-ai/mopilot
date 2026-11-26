// By machine's small edges (#5576): the Organize menu offers it with Host and a click chooses it, a chat the machine lists with no title is Untitled, the offline note's Edit machine opens the machine settings, and a group shown in full folds back with Show less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byText, calls, click, flush, mountSidebar, named, reset } from './support/shell-sidebar-kit.ts';
import { group, offlineBox, rig, row, act } from './support/by-machine-rig.ts';

test('the Organize sidebar menu offers By machine with Host, and choosing it saves the choice', async (t) => {
  rig(t, { rows: [] });
  reset({ prefs: { sidebarOrganize: 'project' } });
  const view = await mountSidebar();
  try {
    await flush();
    await click(view.$('[aria-label="Project sidebar options"]')!);
    await click(byText(view.host, 'button[data-item]', 'By machine'));
    assert.ok(calls.some((c) => c[0] === 'setPrefs' && c[1].sidebarOrganize === 'machine'));
  } finally {
    await view.unmount();
  }
});

test('a chat the machine lists with no title is Untitled; the note of a row that cannot open offers Edit machine, which opens the machine settings', async (t) => {
  const r = rig(t, { rows: [{ ...row(1), title: '' }] });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    const chat = () => group(view, 'ssh:box').querySelector('.machine-chat-row')!;
    assert.equal(chat().querySelector('.side-row-label')?.textContent, 'Untitled chat');
    await act(async () => r.pushMachines(offlineBox));
    await flush();
    const before = calls.length;
    await click(chat());
    const told = calls.slice(before).filter((c) => c[0] === 'toast');
    told[0][3].action.run();
    assert.deepEqual(named('navigate').at(-1), [{ name: 'settings', section: 'connections', tab: 'other' }]);
  } finally {
    await view.unmount();
  }
});

test('a group shown in full folds back to its first chats with Show less', async (t) => {
  rig(t, { rows: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => row(n)) });
  reset({ prefs: { sidebarOrganize: 'machine' } });
  const view = await mountSidebar();
  try {
    await flush();
    const rows = () => group(view, 'ssh:box').querySelectorAll('.machine-chat-row').length;
    assert.equal(rows(), 5);
    await click(group(view, 'ssh:box').querySelector('.show-more')!);
    assert.equal(rows(), 8);
    await click(byText(group(view, 'ssh:box'), '.show-more', 'Show less'));
    assert.equal(rows(), 5);
  } finally {
    await view.unmount();
  }
});
