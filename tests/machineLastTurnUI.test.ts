// Last Turn in the Changes pane of a chat on a machine (src/components/panels/DiffPanel.tsx, src/lib/machineChangesSource.ts, #5255): the newest turn the Host says changed files, read again when a turn ends, no commit for it, the Host's own sentences when it has no start of the turn or is older, and the pane's other scopes one pick away (fixture: tests/support/diff-panel-ui/fixture.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store, native, h, act, DiffPanel, settle, render, one, label, menuItem } from './support/diff-panel-ui/fixture.ts';
import { machineChangesSource } from '../src/lib/machineChangesSource.ts';

const BOX = { id: 'ssh:me@box', name: 'box' };
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1,2 @@',
  ' one',
  '+two',
  'diff --git a/top.md b/top.md',
  '--- a/top.md',
  '+++ b/top.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');
type Reply = () => Promise<any>;
const host = {
  turn: (async () => ({ value: { isRepo: true, baseline: true, patch: PATCH, truncated: false } })) as Reply,
  turnReads: [] as { id: string; q: any }[],
  reads: [] as { id: string; q: any }[],
};
(native as any).host = {
  access: async () => true,
  onAccess: () => () => undefined,
  machines: async () => [],
  onMachines: () => () => undefined,
  gitDiff: async (id: string, q: unknown) => (
    host.reads.push({ id, q }), { value: { isRepo: true, patch: PATCH, truncated: false, unreadable: false } }
  ),
  gitTurnDiff: async (id: string, q: unknown) => (host.turnReads.push({ id, q }), host.turn()),
};
beforeEach(() => {
  host.turn = async () => ({ value: { isRepo: true, baseline: true, patch: PATCH, truncated: false } });
  host.reads.length = host.turnReads.length = 0;
});
const pane = (machine: { id: string; name: string; stale?: boolean } = BOX, folder = '/srv/app') =>
  h(DiffPanel, { cwd: folder, threadId: 't1', source: machineChangesSource(machine, folder) });
const press = (el: HTMLElement) => act(async () => el.click());

test('Last Turn on a machine shows what the Host says the chat’s newest changing turn changed, read again when a turn ends, and offers no commit', async () => {
  store.set({
    diffPanel: { scope: 'turn' },
    runtime: {
      t1: {
        turns: [
          { id: 'old', status: 'completed', items: [] },
          { id: 'new', status: 'completed', items: [] },
        ],
      },
    },
    prefs: {},
    drafts: {},
  });
  const r = await render(pane());
  await settle(act);
  // the newest turn is asked first
  assert.deepEqual(host.turnReads[0], { id: BOX.id, q: { path: '/srv/app', turnId: 'new' } });
  assert.equal(one(r.host, '.cp-scope').textContent, 'Last Turn+2 -1');
  assert.deepEqual(
    [...r.host.querySelectorAll('.cp-file')].map((x) => x.getAttribute('data-path')),
    ['src/a.ts', 'top.md'],
  );
  assert.equal(host.reads.length, 0, 'the folder’s own changes are not read for it');
  assert.equal(r.host.querySelectorAll('.cp-commit, [aria-label^="Include"]').length, 0, 'no commit for a turn');
  // a turn that ends reads it again
  const before = host.turnReads.length;
  await act(async () =>
    store.set({
      runtime: {
        t1: {
          turns: [
            { id: 'old', status: 'completed', items: [] },
            { id: 'new', status: 'completed', items: [] },
            { id: 'newer', status: 'inProgress', items: [] },
          ],
          activeTurnId: 'newer',
        },
      },
    }),
  );
  await settle(act);
  assert.ok(host.turnReads.length > before);
  assert.equal(host.turnReads.at(-1)!.q.turnId, 'newer');
  // a Host with no start of the turn says so, and the other scopes stay one pick away
  host.turn = async () => ({ value: { isRepo: true, baseline: false } });
  await press(label(r.host, 'Refresh'));
  await settle(act);
  assert.match(one(r.host, '.cp-diffs').textContent!, /This turn's baseline is gone\. Uncommitted shows what has changed now\./);
  await press(one(r.host, '.cp-scope'));
  await press(menuItem(r.host, 'Uncommitted changes'));
  await settle(act);
  assert.equal(host.reads.at(-1)!.q.scope, 'uncommitted');
  assert.equal(r.host.querySelectorAll('.cp-file').length, 2);
  // an older Host is told to update, in the pane
  await press(one(r.host, '.cp-scope'));
  host.turn = async () => ({ error: { message: 'x', code: 'host_outdated' } });
  await press(menuItem(r.host, 'Last Turn'));
  await settle(act);
  assert.match(one(r.host, '.cp-diffs').textContent!, /Update the Host on that machine\./);
  await r.unmount();
});

test('Last Turn on a machine asks for the one turn a caller names, and for none when the pane has no chat', async () => {
  store.set({
    diffPanel: { scope: 'turn', turnId: 'named' },
    runtime: { t1: { turns: [{ id: 'x', status: 'completed', items: [] }] } },
    prefs: {},
    drafts: {},
  });
  const named = await render(pane());
  await settle(act);
  assert.deepEqual(
    host.turnReads.map((r) => r.q.turnId),
    ['named'],
  );
  await named.unmount();
  host.turnReads.length = 0;
  store.set({ diffPanel: { scope: 'turn' }, runtime: {}, prefs: {}, drafts: {} });
  const bare = await render(h(DiffPanel, { cwd: '/srv/app', threadId: null, source: machineChangesSource(BOX, '/srv/app') }));
  await settle(act);
  assert.equal(host.turnReads.length, 0, 'a chat with no turns has none to ask about');
  assert.match(one(bare.host, '.cp-diffs').textContent!, /No changes/);
  await bare.unmount();
});

test('a machine whose row says its Host is older than this app has Last Turn greyed', async () => {
  const { MachineChanges } = await import('../src/components/panels/MachineChanges.tsx');
  store.set({ threads: { t1: { cwd: '/srv/app' } }, diffPanel: { scope: 'uncommitted' }, runtime: {}, prefs: {}, drafts: {} });
  const r = await render(h(MachineChanges, { machine: { ...BOX, away: false, row: { hostStale: true } as any }, threadId: 't1' }));
  await settle(act);
  await press(one(r.host, '.cp-scope'));
  assert.equal(
    menuItem(r.host, 'Last Turn').querySelector('.menu-desc')!.textContent,
    "Update the Host on that machine to see a turn's changes",
  );
  await r.unmount();
});

test('Last Turn on a machine says a turn the Host lost is gone, and does not show the turn before it as if it were that one', async () => {
  store.set({
    diffPanel: { scope: 'turn' },
    runtime: {
      t1: {
        turns: [
          { id: 'before', status: 'completed', items: [] },
          { id: 'killed', status: 'completed', items: [] },
        ],
      },
    },
    prefs: {},
    drafts: {},
  });
  host.turn = async () => {
    const asked = host.turnReads.at(-1)!.q.turnId;
    return asked === 'killed'
      ? { value: { isRepo: true, baseline: false } }
      : { value: { isRepo: true, baseline: true, patch: PATCH, truncated: false } };
  };
  const r = await render(pane());
  await settle(act);
  assert.match(one(r.host, '.cp-diffs').textContent!, /This turn's baseline is gone\. Uncommitted shows what has changed now\./);
  assert.equal(r.host.querySelectorAll('.cp-file').length, 0, 'the turn before is not shown in its place');
  assert.deepEqual(
    host.turnReads.map((x) => x.q.turnId),
    ['killed'],
  );
  // the other scopes are one pick away
  await press(one(r.host, '.cp-scope'));
  await press(menuItem(r.host, 'Uncommitted changes'));
  await settle(act);
  assert.equal(r.host.querySelectorAll('.cp-file').length, 2);
  await r.unmount();
});
