// Issue 1367 in the app: each harness's sessions with their last activity, what holds a chat, the setting from ui-state,
// the archive as every window and Codex see it, and a changed setting from Settings sweeping without a window.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createAutoArchive } = require('../electron/app/autoArchive.cjs');
const { register } = require('../electron/app/ipc/chats.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { DAY_MS, SETTING_SWEEP_MS } = require('../electron/session/autoArchive.cjs');

const old = Date.now() - 30 * DAY_MS;

function app(o: { scheduler?: boolean; orchestrator?: boolean; days?: number | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-archive-app-'));
  const f: any = { codexPages: [], archivedInCodex: [], broadcasts: [], days: o.days === undefined ? 7 : o.days };
  f.chats = new ChatsStore(path.join(dir, 'threads'));
  f.state = new SessionStore();
  const pages: Record<string, any> = {
    first: { data: [{ id: 'cx-old', updatedAt: old / 1000 }], nextCursor: 'next' },
    next: {
      data: [
        { id: 'cx-held', updatedAt: old / 1000 },
        { id: 'cx-parent', updatedAt: old / 1000 },
      ],
      nextCursor: null,
    },
  };
  f.live = {
    chats: f.chats,
    controller: { state: f.state },
    codex: {
      threadList: async (p: any) => (f.codexPages.push(p), pages[p.cursor ?? 'first']),
      threadArchive: async (id: string) => void f.archivedInCodex.push(id),
    },
    acpHost: { list: async () => [{ id: 'acp:opencode:old', updatedAt: old }] },
    ...(o.scheduler === false
      ? {}
      : { scheduler: { list: async () => [{ target_thread_id: 'cx-held' }, { target_thread_id: null }, {}] } }),
    ...(o.orchestrator === false
      ? {}
      : { orchestrator: { journal: { childrenOf: (id: string) => (id === 'cx-parent' ? ['busy-child'] : []) } } }),
  };
  // a full first page, then a short one: the listing pages until it ends
  f.claude = {
    pages: [] as number[],
    listSessions: async (limit: number, offset: number) => {
      f.claude.pages.push(offset);
      return offset === 0
        ? Array.from({ length: limit }, (_, i) => ({ sessionId: `recent-${i}`, lastModified: Date.now() }))
        : [{ sessionId: 'old', lastModified: old }];
    },
  };
  f.state.patch('busy-child', { turn: 'running' });
  f.a = createAutoArchive({
    live: f.live,
    readState: () => ({ prefs: { autoArchiveDays: f.days } }),
    broadcastAll: (channel: string, payload: any) => f.broadcasts.push([channel, payload.id, payload.chat?.meta?.archived != null]),
    claude: f.claude,
  });
  return f;
}

test('every harness is listed to its end, held chats are kept, and the archive reaches every window and Codex', async () => {
  const f = app();
  const done = (await f.a.sweep()).sort();
  assert.deepEqual(done, ['acp:opencode:old', 'claude:old', 'cx-old']);
  assert.deepEqual(
    f.codexPages.map((p: any) => p.cursor),
    [null, 'next'],
  );
  assert.ok(f.codexPages.every((p: any) => p.archived === false && p.sortKey === 'updated_at'));
  assert.deepEqual(f.claude.pages, [0, 500]);
  assert.deepEqual(f.archivedInCodex, ['cx-old']);
  assert.deepEqual(f.broadcasts.sort(), done.map((id: string) => ['chats:changed', id, true]).sort());
});

test('without scheduled tasks or linked sessions running, nothing holds those chats', async () => {
  const f = app({ scheduler: false, orchestrator: false });
  assert.deepEqual((await f.a.sweep()).sort(), ['acp:opencode:old', 'claude:old', 'cx-held', 'cx-old', 'cx-parent']);
});

test('the setting is read from ui-state: Never archives nothing', async () => {
  const f = app({ days: null });
  assert.deepEqual(await f.a.sweep(), []);
  assert.deepEqual(f.codexPages, []);
});

test("Settings' change reaches main's sweep through the prefs hook, with no window open", async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = app({ days: null });
    let onPrefs: (prefs: any) => void = () => {};
    let prefs: any = {};
    const live: any = {
      ...f.live,
      scheduler: { ...f.live.scheduler, settingsChanged: () => {} },
      orchestrator: { ...f.live.orchestrator, pump: () => {} },
      menuKeybindings: {},
    };
    register(
      { handle: () => {} },
      {
        readState: () => ({ prefs }),
        registerChats: (_ipc: any, o: any) => {
          onPrefs = o.onPrefs;
          return { patchPrefs: () => true };
        },
        STATE_FILE: () => '/nonexistent/ui-state.json',
        broadcastExcept: () => {},
        buildMenu: () => {},
        broadcastAll: (channel: string, payload: any) => f.broadcasts.push([channel, payload.id]),
        claude: f.claude,
        zoom: { set: () => false },
        live,
      },
    );
    prefs = { autoArchiveDays: 7 };
    onPrefs(prefs);
    mock.timers.tick(SETTING_SWEEP_MS);
    await waitFor(() => !(f.broadcasts.length < 3), 'three archive broadcasts');
    assert.deepEqual(f.broadcasts.map(([, id]: any) => id).sort(), ['acp:opencode:old', 'claude:old', 'cx-old']);
    // a linked session's parent archives a chat the same way (archive_session): every window and Codex are told
    assert.equal(live.archiveChat('cx-kid'), true);
    assert.deepEqual(f.broadcasts.at(-1), ['chats:changed', 'cx-kid']);
    await waitFor(() => f.archivedInCodex.includes('cx-kid'), 'cx-kid archived in Codex');
    assert.ok(f.archivedInCodex.includes('cx-kid'));
  } finally {
    mock.timers.reset();
  }
});

test('a malformed Codex page fails its listing, so no Codex chat is taken for inactive', async () => {
  const f = app();
  f.live.codex.threadList = async () => ({ nextCursor: null });
  assert.deepEqual((await f.a.sweep()).sort(), ['acp:opencode:old', 'claude:old']);
  assert.deepEqual(f.archivedInCodex, []);
});

test('a chat on a harness without an archive of its own is archived in MoPilot only', async () => {
  const f = app();
  f.live.codex.threadList = async () => ({ data: [], nextCursor: null });
  assert.deepEqual((await f.a.sweep()).sort(), ['acp:opencode:old', 'claude:old']);
  assert.deepEqual(f.archivedInCodex, []);
});
