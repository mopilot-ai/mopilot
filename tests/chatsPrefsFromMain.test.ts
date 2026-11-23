// A prefs change main makes itself (electron/platform/chats.cjs registerChats' patchPrefs; Chrome's side panel picks a model or permission): written as a window's is, every window told, and main's listener run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { flushPendingWrites } = require('../electron/platform/chats.cjs');
const { ChatsStore, registerChats } = require('../electron/platform/chats.cjs');

test('a prefs change main makes is written, every window hears it, and its listener runs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ui = path.join(dir, 'ui-state.json');
  const sent: any[] = [];
  const seen: any[] = [];
  const { patchPrefs } = registerChats(
    { handle: () => undefined },
    {
      store: new ChatsStore(path.join(dir, 'threads')),
      uiState: ui,
      broadcast: (...a: any[]) => sent.push(a),
      onPrefs: (p: any) => seen.push(p),
    },
  );
  assert.equal(patchPrefs({ permission: 'read-only' }), true);
  // no window made it, so none is left out
  assert.deepEqual(sent, [['prefs:changed', null, { set: { permission: 'read-only' }, unset: [] }]]);
  assert.equal(seen[0].permission, 'read-only');
  flushPendingWrites();
  assert.equal(JSON.parse(fs.readFileSync(ui, 'utf8')).prefs.permission, 'read-only');
});
