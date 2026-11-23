// Real notification and native snapshot entries reveal outputs across turn aliases while refusing duplicate and withdrawn evidence.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, impl, flush, listeners, callsOf } from './support/store-harness.ts';
import { deferred } from './support/async-scenarios.ts';

const { store, resetState } = await loadStore();
const { followTurnDiffs } = await import('../src/store/turnDiffs.ts');
const { outputCompletion } = await import('../src/store/outputCompletion.ts');
const { onNotification } = await import('../src/store/notifications.ts');
followTurnDiffs();
const st = () => store.useStore.getState();
const patch = (name = 'report.pdf') =>
  `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+written\n`;
const snapshot = (turnId: string, diff: string | null) => listeners['session.onTurnDiff']({ chatId: 'a', turnId, diff });
let sequence = 0;
beforeEach(() => {
  resetState();
  resetAll();
  sequence++;
  store.useStore.setState({
    route: { name: 'thread', id: 'a' },
    threads: { a: { id: 'a', cwd: '/repo' } as any },
    runtime: { a: { turns: [{ id: `t${sequence}`, itemTimes: {}, items: [], status: 'inProgress' }] } as any },
    paneTabs: [],
    paneActive: '',
    diffPanel: { open: false },
  });
  impl['fs.messagePath'] = async (path: string) => ({ path, kind: 'file' });
});

test('Claude and ACP shell snapshots reveal and refresh under the exact current renderer turn id', async () => {
  for (const [local, remote] of [
    ['h-claude', 'ct-claude'],
    ['pending-acp', 'at-acp'],
  ]) {
    store.useStore.setState({
      runtime: { a: { turns: [{ id: local, items: [], status: 'completed' }] } as any },
      paneTabs: [],
      paneActive: '',
      diffPanel: { open: false },
    });
    snapshot(remote, patch(`${local}.pdf`));
    await flush();
    assert.equal(st().paneTabs[0].path, `/repo/${local}.pdf`);
    const version = st().paneTabs[0].version;
    const reads = callsOf('fs.messagePath').length;
    snapshot(remote, patch(`${local}.pdf`));
    await flush();
    assert.equal(callsOf('fs.messagePath').length, reads, 'identical native evidence never restarts the decoder');
    snapshot(remote, patch(`${local}.pdf`).replace('+written', '+updated'));
    await flush();
    assert.notEqual(st().paneTabs[0].version, version);
  }
});

test('a withdrawn live snapshot retires its pending reveal without treating withdrawal as new output', async () => {
  store.useStore.setState({ runtime: { a: { turns: [{ id: 'h-withdrawn', items: [] }] } as any } });
  const pending = deferred<any>();
  impl['fs.messagePath'] = () => pending.promise;
  snapshot('ct-withdrawn', patch());
  snapshot('ct-withdrawn', null);
  pending.resolve({ path: '/repo/report.pdf', kind: 'file' });
  await flush();
  assert.equal(st().runtime.a.turns[0].diff, undefined);
  assert.deepEqual(st().paneTabs, []);
});

test('completed native file-change notifications reveal once after reduction, and identical replay does not reopen a closed tab', async () => {
  const item: any = {
    type: 'fileChange',
    id: 'write',
    status: 'completed',
    changes: [{ path: '/repo/native.html', kind: { type: 'add' }, diff: 'new' }],
  };
  const notification: any = { method: 'item/completed', params: { threadId: 'a', turnId: `t${sequence}`, item } };
  onNotification(notification.method, notification.params);
  await flush();
  assert.equal(st().paneTabs[0].path, '/repo/native.html');
  store.closePaneTab(st().paneActive);
  onNotification(notification.method, notification.params);
  await flush();
  assert.deepEqual(st().paneTabs, []);
  const noOutput = outputCompletion('a', `t${sequence}`, { item: { type: 'agentMessage', id: 'reply', text: 'Done' } as any });
  noOutput();
  await flush();
  assert.deepEqual(st().paneTabs, []);
});

test('restoring stored diff history only populates inventory and never invokes the live reveal boundary', async () => {
  store.useStore.setState({ runtime: { a: { turns: [{ id: 'history', status: 'completed', diff: patch(), items: [] }] } as any } });
  await flush();
  assert.equal(callsOf('fs.messagePath').length, 0);
  assert.deepEqual(st().paneTabs, []);
});
