// Files in conflict in the Changes pane (src/components/panels/DiffPanel.tsx, ChangesCommit.tsx), on both sources: this Mac's git status and a machine's Host name them, the pane marks them Conflicted, they cannot be ticked, and Commit waits and says how many (a commit of every change would stage their markers as resolved, #5237). An older Host that does not name them marks none, as before.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store, native, h, act, DiffPanel, settle, render, one, typeInto, mount, DIFF } from './support/diff-panel-ui/fixture.ts';
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
/** the paths each source is told are in conflict (null: an older Host that does not say) */
let unmerged: string[] | null = [];
const commits: unknown[] = [];
const hostSide = {
  gitDiff: async () => ({
    value: { isRepo: true, patch: PATCH, truncated: false, unreadable: false, ...(unmerged && { conflicted: unmerged }) },
  }),
  gitCommit: async (_id: string, q: unknown) => (commits.push(q), { value: { ok: true, stderr: '' } }),
  gitDiscard: async () => ({ value: { ok: true, stderr: '' } }),
  access: async () => true,
  onAccess: () => () => undefined,
  machines: async () => [],
  onMachines: () => () => undefined,
};
(native as any).host = hostSide;
beforeEach(() => {
  unmerged = [];
  commits.length = 0;
  (native as any).git.status = async () => ({
    files: (unmerged ?? []).map((path) => ({ code: 'UU', path, added: 1, removed: 0, conflicted: true })),
  });
  (native as any).git.commitFiles = async (...args: unknown[]) => (commits.push(args), { ok: true, stdout: '', stderr: '' });
});

/** Each source's pane on its own fixture diff: the conflicted file is src/a.ts in both, the other file is the one a commit could take. */
const sources = [
  {
    name: 'this Mac',
    // the files a commit could take, the conflicted one left out, with the other one unticked
    label: 'Commit 1 of 2',
    other: 'new.py',
    open: async () => {
      void DIFF;
      return mount({ scope: 'uncommitted' });
    },
  },
  {
    name: 'a machine',
    label: 'Commit 0 of 1',
    other: 'top.md',
    open: async () => {
      store.set({ diffPanel: { scope: 'uncommitted' }, runtime: { t1: { turns: [] } }, prefs: {}, drafts: {} });
      const r = await render(h(DiffPanel, { cwd: '/srv/app', threadId: 't1', source: machineChangesSource(BOX, '/srv/app') }));
      await settle(act);
      return r;
    },
  },
];
const section = (el: HTMLElement, p: string) => one(el, `.cp-file[data-path="${p}"]`);
const pick = (el: HTMLElement, p: string) => one(el, `[aria-label="Include ${p} in the commit"]`) as HTMLInputElement;
const commitButton = (el: HTMLElement) => one(el, '.cp-commit .btn') as HTMLButtonElement;
const message = (el: HTMLElement, text: string) => act(async () => typeInto(one(el, '.cp-commit input') as HTMLInputElement, text));

for (const source of sources) {
  test(`${source.name}: a file in conflict is marked, cannot be ticked, and Commit waits for it and says how many`, async () => {
    unmerged = ['src/a.ts'];
    const r = await source.open();
    assert.equal(section(r.host, 'src/a.ts').querySelector('.cp-file-badge.conflicted')?.textContent, 'Conflicted');
    assert.equal(section(r.host, source.other).querySelector('.cp-file-badge.conflicted'), null);
    assert.deepEqual([pick(r.host, 'src/a.ts').disabled, pick(r.host, 'src/a.ts').checked], [true, false]);
    assert.deepEqual([pick(r.host, source.other).disabled, pick(r.host, source.other).checked], [false, true]);
    await message(r.host, 'markers');
    assert.equal(commitButton(r.host).disabled, true);
    assert.equal(commitButton(r.host).title, 'Resolve conflicts in 1 file first');
    await act(async () => commitButton(r.host).click());
    assert.equal(commits.length, 0, 'nothing is sent');
    await r.unmount();
  });

  test(`${source.name}: Enter in the message field commits nothing while a file is in conflict, whatever else is ticked or unticked`, async () => {
    unmerged = ['src/a.ts'];
    const r = await source.open();
    // the other file unticked: the commit would name only files, the conflicted one among them were it not left out
    await act(async () => (pick(r.host, source.other) as HTMLInputElement).click());
    await message(r.host, 'markers');
    const input = one(r.host, '.cp-commit input');
    await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle(act);
    assert.equal(commits.length, 0, 'Enter sends nothing');
    assert.deepEqual(
      store.calls
        .filter((c) => c[0] === 'toast')
        .at(-1)
        ?.slice(1),
      ['Resolve conflicts in 1 file first.', 'error'],
    );
    // the conflicted file is neither ticked nor counted
    assert.equal(commitButton(r.host).textContent?.trim(), source.label);
    await r.unmount();
  });

  test(`${source.name}: a file in conflict with no patch lines (deleted on both sides) still has its row, and is what Commit waits for`, async () => {
    unmerged = ['ghost.txt'];
    const r = await source.open();
    assert.equal(section(r.host, 'ghost.txt').querySelector('.cp-file-badge.conflicted')?.textContent, 'Conflicted');
    await message(r.host, 'm');
    assert.equal(commitButton(r.host).title, 'Resolve conflicts in 1 file first');
    await r.unmount();
  });

  test(`${source.name}: two files in conflict say so, and Commit works again once git lists none`, async () => {
    unmerged = ['src/a.ts', source.other];
    const r = await source.open();
    await message(r.host, 'markers');
    assert.equal(commitButton(r.host).title, 'Resolve conflicts in 2 files first');
    unmerged = [];
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await settle(act);
    assert.equal(r.host.querySelectorAll('.cp-file-badge.conflicted').length, 0);
    assert.equal(commitButton(r.host).disabled, false);
    assert.equal(commitButton(r.host).title, '');
    await act(async () => commitButton(r.host).click());
    await settle(act);
    assert.equal(commits.length, 1);
    await r.unmount();
  });
}

test('with no conflict and every file unticked, Enter in the message field commits nothing', async () => {
  const r = await sources[1].open();
  for (const p of ['src/a.ts', 'top.md']) await act(async () => pick(r.host, p).click());
  await message(r.host, 'nothing ticked');
  await act(async () => void one(r.host, '.cp-commit input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle(act);
  assert.equal(commits.length, 0);
  await r.unmount();
});

test('a Host that does not name conflicts marks none and commits as before', async () => {
  unmerged = null;
  const r = await sources[1].open();
  assert.equal(r.host.querySelectorAll('.cp-file-badge.conflicted').length, 0);
  await message(r.host, 'm');
  assert.equal(commitButton(r.host).disabled, false);
  await r.unmount();
});
