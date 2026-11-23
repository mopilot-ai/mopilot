// src/lib/desktopLineage.ts in the sidebar: a chat a Claude desktop chat started nests under it as MoPilot's own linked
// sessions do; MoPilot's journal decides every chat it links (a detach here wins), and the links grant no authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, fx, thread, mountSidebar, flush } from './support/shell-sidebar-kit.ts';

// after the kit's mocks: the real modules would read the real bridge
const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { loadDesktopLineage, resetDesktopLineage, withDesktopLineage } = await import('../src/session/harness/claude/desktopLineage.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const EMPTY = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
const ids = ['claude-top', 'claude-kid', 'claude-grand', 'claude-other'];

function setup() {
  resetSideSessions();
  resetDesktopLineage();
  const threads = Object.fromEntries(ids.map((id, i) => [id, thread(id, { cwd: '/home', updatedAt: 20 - i })]));
  reset({ threadOrder: ids, threads, prefs: { sidebarFolders: [], sidebarProjectOrder: [] } });
  fx.orchestration = EMPTY;
}

const nestedRows = (host: HTMLElement) => [...host.querySelectorAll('.side-children .thread-row')].map((r) => r.getAttribute('aria-label'));
const topRows = (host: HTMLElement) =>
  [...host.querySelectorAll('.thread-row')].filter((r) => !r.closest('.side-children')).map((r) => r.getAttribute('aria-label'));

test("Claude desktop's side sessions nest under the chat that started them, grandchildren too", async () => {
  setup();
  fx.desktopLineage = { kid: { parentId: 'top', createdAt: 1 }, grand: { parentId: 'kid', createdAt: 2 } };
  await loadDesktopLineage();
  const view = await mountSidebar();
  await flush();
  assert.deepEqual(topRows(view.host), ['Chat claude-top', 'Chat claude-other']);
  assert.deepEqual(nestedRows(view.host), ['Chat claude-kid', 'Chat claude-grand']);
  // Claude desktop detached it: the next read brings it back to the top level
  fx.desktopLineage = { grand: { parentId: 'kid', createdAt: 2 } };
  await loadDesktopLineage();
  await flush();
  assert.deepEqual(topRows(view.host), ['Chat claude-top', 'Chat claude-kid', 'Chat claude-other']);
  await view.unmount();
});

test("MoPilot's journal decides a chat it links: a detach here keeps it top-level", async () => {
  setup();
  fx.orchestration = {
    ...EMPTY,
    children: {
      'claude-kid': {
        parentId: 'claude-top',
        detached: true,
        name: 'kid',
        title: 'kid',
        harness: 'claude',
        useWorktree: false,
        createdAt: 1,
        lastReport: null,
      },
    },
  };
  fx.desktopLineage = { kid: { parentId: 'top', createdAt: 1 } };
  await loadDesktopLineage();
  const view = await mountSidebar();
  await flush();
  assert.deepEqual(nestedRows(view.host), []);
  await view.unmount();
});

test('the merged view is only for nesting: the journal view other surfaces read is unchanged and kept by identity', async () => {
  const journal = {
    ...EMPTY,
    children: { a: { parentId: 'p', name: 'a', title: 'a', harness: 'codex', useWorktree: true, createdAt: 1, lastReport: null } },
  } as any;
  const links = { b: { parentId: 'p', createdAt: 2 }, a: { parentId: 'q', createdAt: 3 }, self: { parentId: 'self', createdAt: 4 } };
  const merged = withDesktopLineage(journal, links);
  assert.equal(merged.children.a.parentId, 'p', 'the journal wins');
  assert.equal(merged.children.b.parentId, 'p');
  assert.equal(merged.children.b.lastReport, null);
  assert.equal(merged.children.self, undefined, 'a link to itself is dropped');
  assert.equal(journal.children.b, undefined, 'the journal view is not touched');
  assert.equal(withDesktopLineage(journal, links), merged, 'same inputs, same view');
  assert.equal(withDesktopLineage(journal, {}), journal, 'nothing to add: the journal view itself');
});

test('an unchanged read keeps the links; a failed read is noted and keeps them', async () => {
  setup();
  fx.desktopLineage = { kid: { parentId: 'top', createdAt: 1 } };
  await loadDesktopLineage();
  const view = await mountSidebar();
  await flush();
  // same links in a new object: no change reaches the sidebar
  fx.desktopLineage = { kid: { parentId: 'top', createdAt: 1 } };
  await loadDesktopLineage();
  // a different link set of the same size is a change
  fx.desktopLineage = { grand: { parentId: 'top', createdAt: 1 } };
  await loadDesktopLineage();
  await flush();
  assert.deepEqual(nestedRows(view.host), ['Chat claude-grand']);
  // a changed time too, then a link added
  fx.desktopLineage = { grand: { parentId: 'top', createdAt: 7 } };
  await loadDesktopLineage();
  fx.desktopLineage = { grand: { parentId: 'top', createdAt: 7 }, kid: { parentId: 'top', createdAt: 8 } };
  await loadDesktopLineage();
  fx.desktopLineage = Promise.reject(new Error('main gone')) as any;
  (fx.desktopLineage as any).catch(() => {});
  await loadDesktopLineage();
  await flush();
  assert.deepEqual(nestedRows(view.host), ['Chat claude-kid', 'Chat claude-grand']);
  await view.unmount();
});
