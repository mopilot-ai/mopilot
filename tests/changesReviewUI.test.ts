// Reviewing in the Changes pane (src/components/panels/ChangesFileHead.tsx, DiffPanel.tsx): Viewed folds a file and a
// later change to it says so, Show whitespace off sets whitespace-only edits aside, and Attach as context adds the file
// to the chat's composer (fixture: tests/support/diff-panel-ui/fixture.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store, git, act, mount, label, menuItem, one, settle } from './support/diff-panel-ui/fixture.ts';
import { resetViewedMarks } from '../src/lib/diffViewed.ts';

beforeEach(() => {
  localStorage.clear();
  resetViewedMarks();
});
const section = (host: HTMLElement, p: string) => one(host, `.cp-file[data-path="${p}"]`);
const viewed = (host: HTMLElement, p: string) => section(host, p).querySelector('.cp-viewed input') as HTMLInputElement;
const shownDiff = (host: HTMLElement, p: string) => !!host.querySelector(`[data-inline="${p}"]`);

test('Viewed folds the file, marks its row, survives a remount, and unmarking opens it again', async () => {
  let r = await mount({ scope: 'uncommitted' });
  assert.equal(viewed(r.host, 'src/a.ts').checked, false);
  await act(async () => viewed(r.host, 'src/a.ts').click());
  assert.equal(viewed(r.host, 'src/a.ts').checked, true);
  assert.equal(shownDiff(r.host, 'src/a.ts'), false, 'a viewed file folds away');
  assert.equal(shownDiff(r.host, 'new.py'), true);
  assert.ok(one(r.host, '.cp-file-row.viewed').textContent!.includes('a.ts'));
  await r.unmount();
  r = await mount({ scope: 'uncommitted' });
  assert.equal(viewed(r.host, 'src/a.ts').checked, true, 'kept for the next pane');
  assert.equal(shownDiff(r.host, 'src/a.ts'), false);
  // folding by hand overrides the default either way
  await act(async () => section(r.host, 'src/a.ts').querySelector<HTMLElement>('.cp-file-head')!.click());
  assert.equal(shownDiff(r.host, 'src/a.ts'), true);
  await act(async () => viewed(r.host, 'src/a.ts').click());
  assert.equal(viewed(r.host, 'src/a.ts').checked, false);
  assert.equal(shownDiff(r.host, 'src/a.ts'), true);
  await r.unmount();
});

test('a viewed file that changes afterwards says so, unfolds, and can be marked viewed again', async () => {
  const r = await mount({ scope: 'uncommitted' });
  await act(async () => viewed(r.host, 'src/a.ts').click());
  await r.unmount();
  git.diff = async () =>
    ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+newer'].join('\n');
  const again = await mount({ scope: 'uncommitted' });
  assert.equal(one(again.host, '.cp-file-badge').textContent, 'Changed since you viewed it');
  assert.equal(viewed(again.host, 'src/a.ts').checked, false);
  assert.equal(shownDiff(again.host, 'src/a.ts'), true);
  await act(async () => viewed(again.host, 'src/a.ts').click());
  assert.equal(again.host.querySelector('.cp-file-badge'), null);
  await again.unmount();
});

test('Collapse all and Expand all win over Viewed for every file shown', async () => {
  const r = await mount({ scope: 'uncommitted' });
  await act(async () => viewed(r.host, 'src/a.ts').click());
  // a viewed file folded counts as folded: the button offers to expand
  await act(async () => label(r.host, 'Expand all diffs').click());
  assert.equal(r.host.querySelectorAll('[data-inline]').length, 3, 'the viewed file opens too');
  await act(async () => label(r.host, 'Collapse all diffs').click());
  assert.equal(r.host.querySelectorAll('[data-inline]').length, 0);
  await r.unmount();
});

test('Show whitespace off reads whitespace-only edits as unchanged and names a file with nothing else', async () => {
  git.diff = async () =>
    ['diff --git a/space.ts b/space.ts', '--- a/space.ts', '+++ b/space.ts', '@@ -1,2 +1,2 @@', '-a  =  1', '+a = 1', ' keep'].join('\n');
  const r = await mount({ scope: 'uncommitted' });
  assert.equal(r.host.querySelector('.cp-file-note'), null);
  await act(async () => label(r.host, 'Changes options').click());
  assert.equal(menuItem(r.host, 'Show whitespace').getAttribute('aria-checked'), 'true');
  await act(async () => menuItem(r.host, 'Show whitespace').click());
  assert.equal(store.get().prefs.changesWhitespace, false);
  assert.equal(one(r.host, '.cp-file-note').textContent, ' (whitespace only)');
  assert.ok(one(r.host, '.cp-file-head .diff-stat').textContent!.includes('+0'));
  await r.unmount();
});

test('Attach as context adds the file to the chat composer and says so', async () => {
  const r = await mount({ scope: 'uncommitted' });
  await act(async () => (section(r.host, 'new.py').querySelector('[aria-label="File actions"]') as HTMLElement).click());
  await act(async () => menuItem(r.host, 'Attach as context').click());
  await settle(act);
  assert.deepEqual(store.get().drafts.t1.attachments, [{ kind: 'file', name: 'new.py', path: '/repo/new.py' }]);
  assert.ok(store.calls.some((c: unknown[]) => c[0] === 'toast' && String(c[1]).includes('Attached new.py')));
  await r.unmount();
});

test('a file changed while the pane stays mounted unfolds and loses its Viewed check', async () => {
  const r = await mount({ scope: 'uncommitted' });
  await act(async () => viewed(r.host, 'src/a.ts').click());
  git.diff = async () => '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+changed';
  await act(async () => store.set({ diffPanel: { scope: 'uncommitted', open: true } }));
  await settle(act);
  assert.equal(viewed(r.host, 'src/a.ts').checked, false);
  assert.equal(shownDiff(r.host, 'src/a.ts'), true);
  await r.unmount();
});

test('Viewed in Uncommitted is independent from the same patch in Branch', async () => {
  const r = await mount({ scope: 'uncommitted' });
  await act(async () => viewed(r.host, 'src/a.ts').click());
  await act(async () => store.set({ diffPanel: { scope: 'branch' } }));
  await settle(act);
  assert.equal(viewed(r.host, 'src/a.ts').checked, false);
  assert.equal(r.host.querySelector('.cp-file-badge'), null);
  await act(async () => store.set({ diffPanel: { scope: 'uncommitted' } }));
  await settle(act);
  assert.equal(viewed(r.host, 'src/a.ts').checked, true);
  await r.unmount();
});

test('binary Viewed marks follow blob changes; a binary patch with no identity accurately disables tracking', async () => {
  const patch = (id: string) => `diff --git a/a.png b/a.png\nindex abc123..${id} 100644\nBinary files a/a.png and b/a.png differ`;
  git.diff = async () => patch('def456');
  const r = await mount({ scope: 'uncommitted' });
  await act(async () => viewed(r.host, 'a.png').click());
  git.diff = async () => patch('fed654');
  await act(async () => store.set({ diffPanel: { scope: 'uncommitted', open: true } }));
  await settle(act);
  assert.equal(viewed(r.host, 'a.png').checked, false);
  assert.ok(r.host.querySelector('.cp-file-badge'));
  git.diff = async () => 'diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ';
  await act(async () => store.set({ diffPanel: { scope: 'uncommitted', open: true } }));
  await settle(act);
  assert.equal(viewed(r.host, 'a.png').disabled, true);
  assert.match(viewed(r.host, 'a.png').title, /no version/);
  await r.unmount();
});
