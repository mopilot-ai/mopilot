// The Changes pane of a chat on a machine is the Changes pane of this Mac run on the machine's source (src/components/panels/DiffPanel.tsx, MachineChanges.tsx): its files, filter, Unified/Split and Viewed marks come from the one pane, commit and discard go through the Host, what needs a copy of the folder on this Mac is greyed with its reason, and a read or write for another machine or folder says nothing (fixture: tests/support/diff-panel-ui/fixture.ts).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  store,
  native,
  calls,
  confirms,
  setConfirmAnswer,
  h,
  act,
  DiffPanel,
  settle,
  render,
  one,
  typeInto,
  label,
  menuItem,
} from './support/diff-panel-ui/fixture.ts';
import { machineChangesSource } from '../src/lib/machineChangesSource.ts';
import { resetViewedMarks } from '../src/lib/diffViewed.ts';
import { GIT_IDLE_POLL_MS } from '../src/lib/gitPoll.ts';

const BOX = { id: 'ssh:me@box', name: 'box' };
const OTHER = { id: 'ssh:me@other', name: 'other' };
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
  diff: (async () => ({ value: { isRepo: true, patch: PATCH, truncated: false, unreadable: false } })) as Reply,
  commit: (async () => ({ value: { ok: true, stderr: '' } })) as Reply,
  discard: (async () => ({ value: { ok: true, stderr: '' } })) as Reply,
  reads: [] as { id: string; q: any }[],
  commits: [] as { id: string; q: any }[],
  discards: [] as { id: string; q: any }[],
};
(native as any).host = {
  // the machine list behind the notice's Update action: no machines, so the notice shows its words only
  access: async () => true,
  onAccess: () => () => undefined,
  machines: async () => [],
  onMachines: () => () => undefined,
  gitDiff: async (id: string, q: unknown) => (host.reads.push({ id, q }), host.diff()),
  gitCommit: async (id: string, q: unknown) => (host.commits.push({ id, q }), host.commit()),
  gitDiscard: async (id: string, q: unknown) => (host.discards.push({ id, q }), host.discard()),
};
beforeEach(() => {
  host.diff = async () => ({ value: { isRepo: true, patch: PATCH, truncated: false, unreadable: false } });
  host.commit = async () => ({ value: { ok: true, stderr: '' } });
  host.discard = async () => ({ value: { ok: true, stderr: '' } });
  host.reads.length = host.commits.length = host.discards.length = 0;
  localStorage.clear();
  resetViewedMarks();
});

const pane = (machine = BOX, folder = '/srv/app') =>
  h(DiffPanel, { cwd: folder, threadId: 't1', source: machineChangesSource(machine, folder) });
async function open(scope = 'uncommitted', machine = BOX, folder = '/srv/app') {
  store.set({
    diffPanel: { scope },
    runtime: { t1: { turns: [{ status: 'completed' }] } },
    prefs: { openDestination: 'finder' },
    drafts: {},
  });
  const r = await render(pane(machine, folder));
  await settle(act);
  return r;
}
const toasts = () => store.calls.filter((c) => c[0] === 'toast').map((c) => c.slice(1));
const section = (host: HTMLElement, p: string) => one(host, `.cp-file[data-path="${p}"]`);
const viewed = (el: HTMLElement, p: string) => section(el, p).querySelector('.cp-viewed input') as HTMLInputElement;
const press = (el: HTMLElement) => act(async () => el.click());
const fileMenu = async (el: HTMLElement, p: string) => press(section(el, p).querySelector('[aria-label="File actions"]') as HTMLElement);
const type = (el: HTMLElement, value: string) => act(async () => typeInto(one(el, '.cp-commit input') as HTMLInputElement, value));

test('the machine’s patch is shown by the one pane: files, totals, filter, Unified/Split and Viewed, and nothing is read on this Mac', async () => {
  const r = await open('branch');
  assert.deepEqual(host.reads, [{ id: BOX.id, q: { path: '/srv/app', scope: 'branch' } }]);
  assert.equal(calls.length, 0, 'this Mac’s git is not asked');
  assert.deepEqual(
    [...r.host.querySelectorAll('.cp-file')].map((s) => s.getAttribute('data-path')),
    ['src/a.ts', 'top.md'],
  );
  assert.equal(one(r.host, '.cp-scope').textContent, 'Branch+2 -1');
  // the filter, the file list and the split view come with the pane
  await act(async () => typeInto(one(r.host, '.cp-filter input') as HTMLInputElement, 'top'));
  assert.deepEqual(
    [...r.host.querySelectorAll('.cp-file')].map((s) => s.getAttribute('data-path')),
    ['top.md'],
  );
  await act(async () => typeInto(one(r.host, '.cp-filter input') as HTMLInputElement, ''));
  await press(one(r.host, '.cp-mode button', 'Split'));
  assert.equal(r.host.querySelectorAll('[data-split]').length, 2);
  // Viewed folds the file
  await press(viewed(r.host, 'src/a.ts'));
  assert.equal(viewed(r.host, 'src/a.ts').checked, true);
  assert.equal(r.host.querySelector('[data-split="src/a.ts"]'), null);
  // the scope menu reads the other scope from the machine
  await press(one(r.host, '.cp-scope'));
  await press(menuItem(r.host, 'Uncommitted changes'));
  await settle(act);
  assert.equal(host.reads.at(-1)!.q.scope, 'uncommitted');
  await r.unmount();
});

test('Viewed marks are the machine’s: the same path on another machine is unmarked', async () => {
  let r = await open('uncommitted');
  await press(viewed(r.host, 'src/a.ts'));
  await r.unmount();
  r = await open('uncommitted');
  assert.equal(viewed(r.host, 'src/a.ts').checked, true, 'kept for the next pane on the same machine');
  await r.unmount();
  r = await open('uncommitted', OTHER);
  assert.equal(viewed(r.host, 'src/a.ts').checked, false);
  await r.unmount();
});

test('what needs a copy of the folder on this Mac is greyed with its reason; Copy path copies the path in the folder', async () => {
  const r = await open('uncommitted');
  const caps = machineChangesSource(BOX, '/srv/app').capabilities as Record<string, { reason: string }>;
  const openButton = section(r.host, 'src/a.ts').querySelector('.cp-review-actions button[disabled]') as HTMLElement;
  assert.ok(openButton, 'Open is there but disabled');
  assert.equal(openButton.parentElement!.getAttribute('title'), caps.openInEditor.reason);
  await fileMenu(r.host, 'src/a.ts');
  const reveal = menuItem(r.host, 'Reveal in Finder');
  assert.ok(reveal.hasAttribute('disabled') || reveal.querySelector('.menu-desc'), 'Reveal is greyed');
  assert.equal(reveal.querySelector('.menu-desc')!.textContent, caps.reveal.reason);
  assert.equal(menuItem(r.host, 'Attach as context').querySelector('.menu-desc')!.textContent, caps.attach.reason);
  await press(menuItem(r.host, 'Copy path'));
  assert.deepEqual(calls.at(-1), ['copy', 'src/a.ts']);
  // Last Turn is the Host's own: offered, while a Host older than this app greys it with the update sentence
  await press(one(r.host, '.cp-scope'));
  assert.equal(menuItem(r.host, 'Last Turn').querySelector('.menu-desc'), null);
  // no comment buttons, and no pull request thread is looked up on this Mac
  assert.equal(r.host.querySelectorAll('[data-comment]').length, 0);
  await r.unmount();
  const turn = await (async () => {
    store.set({ diffPanel: { scope: 'turn' }, runtime: { t1: { turns: [] } }, prefs: { changesLastTurnOnly: true }, drafts: {} });
    return render(pane({ ...BOX, stale: true } as typeof BOX));
  })();
  await settle(act);
  assert.equal(one(turn.host, '.cp-scope').textContent?.startsWith('Uncommitted'), true, 'a machine with no Last Turn opens Uncommitted');
  await press(one(turn.host, '.cp-scope'));
  assert.equal(
    menuItem(turn.host, 'Last Turn').querySelector('.menu-desc')!.textContent,
    "Update the Host on that machine to see a turn's changes",
  );
  assert.equal(
    calls.some((c) => c[0] === 'git' || c[0] === 'diff'),
    false,
  );
  await turn.unmount();
});

test('the machine is read on open, on focus, on Refresh and when a turn changes, and never on a timer', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const r = await open('uncommitted');
  try {
    const before = host.reads.length;
    await act(async () => mock.timers.tick(GIT_IDLE_POLL_MS * 3));
    await settle(act);
    assert.equal(host.reads.length, before, 'no timer');
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await settle(act);
    assert.equal(host.reads.length, before + 1, 'focus');
    await press(label(r.host, 'Refresh'));
    await settle(act);
    assert.equal(host.reads.length, before + 2, 'Refresh');
    await act(async () =>
      store.set({ runtime: { t1: { turns: [{ status: 'completed' }, { status: 'inProgress' }], activeTurnId: 'x' } } }),
    );
    await settle(act);
    assert.ok(host.reads.length > before + 2, 'a turn that starts');
  } finally {
    await r.unmount();
    mock.timers.reset();
  }
});

test('no changes, no repository, a refusal, an unreadable diff, a cut patch and a failed bridge each say so', async () => {
  const say = async (reply: Reply) => {
    host.diff = reply;
    const r = await open('uncommitted');
    const text = one(r.host, '.cp-diffs').textContent;
    const roles = [...r.host.querySelectorAll('.cp-diffs [role]')].map((e) => e.getAttribute('role'));
    await r.unmount();
    return [text, roles] as const;
  };
  assert.deepEqual(await say(async () => ({ value: { isRepo: true, patch: '', truncated: false, unreadable: false } })), [
    'No changes',
    [],
  ]);
  assert.deepEqual(await say(async () => ({ value: { isRepo: false } })), ['This folder is not a git repository', []]);
  assert.deepEqual(await say(async () => ({ error: { message: 'x', code: 'read_timed_out' } })), [
    'The machine took too long to read that folder.',
    ['status'],
  ]);
  assert.deepEqual(await say(async () => ({ value: { isRepo: true, patch: PATCH, truncated: false, unreadable: true } })), [
    'The machine could not read the changes.',
    ['status'],
  ]);
  const cut = await say(async () => ({ value: { isRepo: true, patch: PATCH, truncated: true, unreadable: false } }));
  assert.match(cut[0]!, /The patch is cut here; more changes are not shown\.$/);
  assert.deepEqual(
    await say(async () => {
      throw new Error('the bridge failed');
    }),
    ['Could not read that on the machine.', ['status']],
  );
  // an older Host is offered its update, in the notice
  host.diff = async () => ({ error: { message: 'x', code: 'host_outdated' } });
  const r = await open('uncommitted');
  assert.match(one(r.host, '.cp-diffs').textContent!, /Update the Host on that machine\./);
  await r.unmount();
});

test('Commit takes every change, or only the ticked files, through the machine, and the pane reads again', async () => {
  const r = await open('uncommitted');
  assert.equal(r.host.querySelectorAll('.cp-file-pick').length, 2);
  assert.equal(one(r.host, '.cp-commit .btn').hasAttribute('disabled'), true, 'no message yet');
  await type(r.host, 'all of it');
  const reads = host.reads.length;
  await press(one(r.host, '.cp-commit .btn'));
  await settle(act);
  assert.deepEqual(host.commits, [{ id: BOX.id, q: { path: '/srv/app', message: 'all of it', files: null } }]);
  assert.deepEqual(toasts().at(-1), ['Committed changes', 'success']);
  assert.equal(host.reads.length, reads + 1, 'read again');
  assert.equal((one(r.host, '.cp-commit input') as HTMLInputElement).value, '');
  await press(one(r.host, '[aria-label="Include top.md in the commit"]'));
  await type(r.host, 'one of two');
  assert.equal(one(r.host, '.cp-commit .btn').textContent?.trim(), 'Commit 1 of 2');
  await press(one(r.host, '.cp-commit .btn'));
  await settle(act);
  assert.deepEqual(host.commits.at(-1)!.q.files, [{ path: 'src/a.ts', oldPath: 'src/a.ts', isCopy: undefined, isDeleted: undefined }]);
  assert.deepEqual(toasts().at(-1), ['Committed 1 file', 'success']);
  // the Branch scope has no commit box
  await press(one(r.host, '.cp-scope'));
  await press(menuItem(r.host, 'Branch changes'));
  await settle(act);
  assert.equal(r.host.querySelectorAll('.cp-commit, .cp-file-pick').length, 0);
  await r.unmount();
});

test('a commit the machine refuses or cannot do keeps the message and says why', async () => {
  const r = await open('uncommitted');
  await type(r.host, 'again');
  const attempt = async (reply: Reply) => {
    host.commit = reply;
    await press(one(r.host, '.cp-commit .btn'));
    await settle(act);
    return toasts().at(-1);
  };
  assert.deepEqual(await attempt(async () => ({ error: { message: 'x', code: 'host_outdated' } })), [
    'Update the Host on that machine.',
    'error',
  ]);
  assert.equal((one(r.host, '.cp-commit input') as HTMLInputElement).value, 'again');
  assert.deepEqual(
    await attempt(async () => ({ value: { ok: false, stderr: 'Resolve the conflicts first, then commit.', refused: true } })),
    ['Resolve the conflicts first, then commit.', 'error'],
  );
  assert.deepEqual(await attempt(async () => ({ value: { ok: false, stderr: 'nothing to commit, working tree clean' } })), [
    'There is nothing to commit.',
    'error',
  ]);
  assert.deepEqual(await attempt(async () => ({ value: { ok: true, stderr: '', warning: 'Committed, but…' } })), [
    'Committed, but…',
    'info',
  ]);
  await r.unmount();
});

test('Discard changes and Discard all changes ask first, name the machine, send the file or everything, and read again whatever the outcome', async () => {
  const r = await open('uncommitted');
  setConfirmAnswer(false);
  await fileMenu(r.host, 'src/a.ts');
  await press(menuItem(r.host, 'Discard changes'));
  assert.deepEqual(confirms, ['Discard all changes to src/a.ts on box? This cannot be undone.']);
  assert.equal(host.discards.length, 0, 'declined: nothing is sent');
  setConfirmAnswer(true);
  const reads = host.reads.length;
  await fileMenu(r.host, 'src/a.ts');
  await press(menuItem(r.host, 'Discard changes'));
  await settle(act);
  assert.deepEqual(host.discards, [{ id: BOX.id, q: { path: '/srv/app', file: 'src/a.ts' } }]);
  assert.equal(host.reads.length, reads + 1);
  assert.equal(toasts().length, 0, 'a discard that worked says nothing');
  const all = async (reply: Reply) => {
    host.discard = reply;
    await press(label(r.host, 'Changes options'));
    await press(menuItem(r.host, 'Discard all changes'));
    await settle(act);
    return toasts().at(-1);
  };
  assert.deepEqual(await all(async () => ({ value: { ok: false, stderr: 'error: pathspec x\nmore' } })), ['error: pathspec x', 'error']);
  assert.equal(confirms.at(-1), 'Discard all uncommitted changes on box? This cannot be undone.');
  assert.deepEqual(host.discards.at(-1), { id: BOX.id, q: { path: '/srv/app', file: null } });
  assert.deepEqual(await all(async () => ({ value: { ok: false, stderr: '' } })), ['Could not discard changes', 'error']);
  assert.deepEqual(await all(async () => ({ value: { ok: false, stderr: 'Update the Host on that machine.', refused: true } })), [
    'Update the Host on that machine.',
    'error',
  ]);
  assert.deepEqual(await all(async () => ({ error: { message: 'x', code: 'outside_roots' } })), [
    'That folder is outside what this machine shares.',
    'error',
  ]);
  assert.match(
    String(
      (
        await all(async () => {
          throw new Error('the bridge failed');
        })
      )?.[0],
    ),
    /the bridge failed/,
  );
  await r.unmount();
});

test('a read, commit or discard that ends after the pane moved to another machine, folder or closed shows nothing and reads nothing', async () => {
  // a read for the folder the pane left
  let answer: (r: any) => void = () => {};
  host.diff = () => new Promise((resolve) => (answer = resolve));
  store.set({ diffPanel: { scope: 'uncommitted' }, runtime: { t1: { turns: [] } }, prefs: {}, drafts: {} });
  const r = await render(pane(BOX, '/srv/old'));
  await settle(act);
  host.diff = async () => ({ value: { isRepo: true, patch: PATCH.split('diff --git a/top.md')[0], truncated: false, unreadable: false } });
  await r.rerender(pane(OTHER, '/srv/new'));
  await settle(act);
  await act(async () => answer({ value: { isRepo: true, patch: PATCH, truncated: false, unreadable: false } }));
  assert.deepEqual(
    [...r.host.querySelectorAll('.cp-file')].map((s) => s.getAttribute('data-path')),
    ['src/a.ts'],
    'the answer for the old machine and folder is dropped',
  );
  // a commit that ends after the move
  let finish: (r: any) => void = () => {};
  host.commit = () => new Promise((resolve) => (finish = resolve));
  await type(r.host, 'late');
  await press(one(r.host, '.cp-commit .btn'));
  await r.rerender(pane(BOX, '/srv/other'));
  await settle(act);
  const moved = host.reads.length;
  await act(async () => finish({ value: { ok: true, stderr: '' } }));
  await settle(act);
  assert.equal(host.reads.length, moved, 'no read for the folder it was not made in');
  assert.equal(toasts().length, 0);
  // a discard that ends, or fails, after the pane closed
  let end: (r: any) => void = () => {};
  host.discard = () => new Promise((resolve) => (end = resolve));
  await fileMenu(r.host, 'src/a.ts');
  await press(menuItem(r.host, 'Discard changes'));
  const after = host.reads.length;
  await r.unmount();
  await act(async () => end({ value: { ok: false, stderr: 'late failure' } }));
  assert.equal(host.reads.length, after);
  assert.equal(toasts().length, 0);
  const x = await open('uncommitted');
  host.discard = () => Promise.reject(new Error('gone'));
  await fileMenu(x.host, 'src/a.ts');
  const pending = press(menuItem(x.host, 'Discard changes'));
  await x.unmount();
  await pending;
  assert.equal(toasts().length, 0);
});

test('a chat on a machine opens the pane on the chat’s own folder there, and on another folder when the chat moves', async () => {
  const { MachineChanges } = await import('../src/components/panels/MachineChanges.tsx');
  const machine = { ...BOX, away: false };
  store.set({ threads: { t1: { cwd: '/srv/app' }, none: {} }, diffPanel: { scope: 'uncommitted' }, runtime: {}, prefs: {}, drafts: {} });
  const r = await render(h(MachineChanges, { machine, threadId: 't1' }));
  await settle(act);
  assert.deepEqual(host.reads.at(-1), { id: BOX.id, q: { path: '/srv/app', scope: 'uncommitted' } });
  assert.equal(r.host.querySelectorAll('.cp-file').length, 2);
  await act(async () => store.set({ threads: { t1: { cwd: '/srv/moved' } } }));
  await settle(act);
  assert.equal(host.reads.at(-1)!.q.path, '/srv/moved');
  await r.unmount();
  // a pane with no chat, or a chat that has no folder yet, asks for no folder
  for (const threadId of [null, 'none']) {
    const bare = await render(h(MachineChanges, { machine, threadId }));
    await settle(act);
    assert.equal(host.reads.at(-1)!.q.path, '');
    await bare.unmount();
  }
});

test('the scope picked in a machine pane is remembered as in this Mac’s: one preference, Last Turn included while the machine’s Host has it', async () => {
  const opened = async (prefs: Record<string, unknown>) => {
    store.set({ diffPanel: {}, runtime: { t1: { turns: [] } }, prefs, drafts: {} });
    const r = await render(pane());
    await settle(act);
    return r;
  };
  let r = await opened({});
  assert.equal(one(r.host, '.cp-scope').textContent?.startsWith('Branch'), true, 'the default, as on this Mac');
  await press(one(r.host, '.cp-scope'));
  await press(menuItem(r.host, 'Uncommitted changes'));
  await settle(act);
  assert.deepEqual(store.calls.filter((c) => c[0] === 'setPrefs').at(-1)?.[1], { changesScope: 'uncommitted' });
  await r.unmount();
  // the next pane opens on the pick
  r = await opened({ changesScope: 'uncommitted' });
  assert.equal(one(r.host, '.cp-scope').textContent?.startsWith('Uncommitted'), true);
  await r.unmount();
  // Last Turn is a scope of a machine whose Host has it: remembered like the others; a Host older than this app has none, and the pane opens Branch, as a chat-less pane on this Mac does, leaving the remembered pick alone
  store.calls.length = 0;
  r = await opened({ changesScope: 'turn' });
  assert.equal(one(r.host, '.cp-scope').textContent?.startsWith('Last Turn'), true);
  await r.unmount();
  store.set({ diffPanel: {}, runtime: { t1: { turns: [] } }, prefs: { changesScope: 'turn' }, drafts: {} });
  r = await render(pane({ ...BOX, stale: true } as typeof BOX));
  await settle(act);
  assert.equal(one(r.host, '.cp-scope').textContent?.startsWith('Branch'), true);
  assert.equal(
    store.calls.some((c) => c[0] === 'setPrefs'),
    false,
  );
  await r.unmount();
});
