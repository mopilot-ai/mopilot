// MoMo's chats are in no list of chats (src/lib/momoChats.ts): a chat a machine lists that is one of MoMo's is no row of By machine, however the machine named it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush, mountSidebar, reset, thread } from './support/shell-sidebar-kit.ts';
import { group, rig, row } from './support/by-machine-rig.ts';

test("a chat of MoMo's that a machine lists is not a row of its group, and a chat of this Mac's own that is MoMo's is not drawn either", async (t) => {
  rig(t, { rows: [row(1), row(2)] });
  reset({
    prefs: { sidebarOrganize: 'machine' },
    momoChats: { 'acp:host-claude:c2': 'main', 'acp:host-claude:own-momo': 'previous' },
    threadOrder: ['acp:host-claude:own-momo'],
    threads: { 'acp:host-claude:own-momo': thread('acp:host-claude:own-momo') },
  });
  const view = await mountSidebar();
  try {
    await flush();
    const labels = (id: string) => [...group(view, id).querySelectorAll('.side-row-label')].map((e) => e.textContent);
    assert.deepEqual(
      labels('ssh:box').filter((l) => /Machine chat|own-momo/.test(l ?? '')),
      ['Machine chat 1'],
      'MoMo chat 2 is skipped',
    );
    assert.deepEqual(
      labels('this-mac').filter((l) => /own-momo/.test(l ?? '')),
      [],
    );
    await click(group(view, 'ssh:box').querySelector('.machine-chat-row')!);
  } finally {
    await view.unmount();
  }
});
