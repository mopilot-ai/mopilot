// Legacy profile fixtures shared by migration and schema-ownership unit tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { flushPendingWrites } = createRequire(import.meta.url)('../../electron/platform/chats.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-migrate-'));

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const twoSegments = [
  { harness: 'codex', nativeId: 'cx-switched', start: 0, count: 2, model: null, handoff: null },
  {
    harness: 'claude',
    nativeId: 'claude:s-2',
    start: 2,
    count: null,
    model: 'sonnet',
    handoff: { mode: 'auto', tokens: 12, text: 'note' },
  },
];
const legacyUi = () => ({
  prefs: { theme: 'dark' },
  sidebarOpen: true,
  pinned: { 'cx-pinned': true, 'claude:s-pinned': true, 'cx-unpinned': false },
  unread: { 'cx-unread': true, 'cx-pinned': false },
  worktreeOf: { 'cx-wt': '/work/repo' },
  claudeArchived: { 'claude:s-archived': 1700000000000, 'claude:s-pinned': 1700000000001 },
  claudeChats: { 'claude:s-pinned': { id: 'acct-2', pinned: true }, 'claude:s-other': { id: 'default', pinned: false } },
  // an older build kept this one in ui-state
  segments: {
    'cx-old-ui': [
      { harness: 'codex', nativeId: 'cx-old-ui', start: 0, count: 1, model: null, handoff: null },
      { harness: 'claude', nativeId: 'claude:s-9', start: 1, count: null, model: null, handoff: null },
    ],
  },
});

function profile(ui: any = legacyUi()) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ui-state.json'), JSON.stringify(ui, null, 2));
  fs.mkdirSync(path.join(dir, 'threads'));
  fs.writeFileSync(path.join(dir, 'threads', 'cx-switched.json'), JSON.stringify({ id: 'cx-switched', segments: twoSegments }, null, 2));
  return dir;
}
const v2Files = (dir: string) =>
  Object.fromEntries(
    fs
      .readdirSync(path.join(dir, 'threads'))
      .filter((f) => f.endsWith('.v2'))
      .sort()
      .map((f) => [f, fs.readFileSync(path.join(dir, 'threads', f), 'utf8')]),
  );
const read = (dir: string, id: string) => JSON.parse(fs.readFileSync(path.join(dir, 'threads', encodeURIComponent(id) + '.v2'), 'utf8'));
// main writes ui-state.json behind; a test reads it once what main holds is on the disk
const uiOf = (dir: string) => (flushPendingWrites(), JSON.parse(fs.readFileSync(path.join(dir, 'ui-state.json'), 'utf8')));

export { NOW, twoSegments, legacyUi, profile, v2Files, read, uiOf };
